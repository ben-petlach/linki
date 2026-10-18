import { createHash } from "crypto";
import type Database from "better-sqlite3";
import { claimAction, beginDispatch, confirmAction, holdUnknown, releaseClaim } from "@/lib/reliability/actions";
import { evaluateEligibility } from "@/lib/reliability/suppression";
import { isEmailInboxFresh, registerOutboundEmail, markOutboundAccepted } from "@/lib/email/inbox";
import { sendEmail, type EmailAccount } from "@/lib/email/sender";

/** All prospect-facing direct email must pass the same durable and policy gates as runner sends. */
export async function sendDirectEmail(db: Database.Database, input: {
  targetId: string; account: EmailAccount; recipient: string; subject: string;
  body: string; idempotencyKey: string;
}): Promise<{ ok: true; messageId: string } | { ok: false; status: number; error: string }> {
  if (!/^[a-zA-Z0-9._:-]{8,128}$/.test(input.idempotencyKey)) {
    return { ok: false, status: 400, error: "idempotencyKey must be 8–128 safe characters" };
  }
  const key = `manual-email:${input.targetId}:${input.account.id}:${input.idempotencyKey}`;
  const digest = createHash("sha256").update(key).digest("hex");
  const domain = input.account.from_email.split("@")[1];
  const messageId = `<${digest}@${domain}>`;
  const initial = gate(db, input.targetId, input.account.id, input.recipient, false);
  if (initial) return { ok: false, status: 409, error: initial };
  const claim = claimAction(db, { key, senderId: input.account.id, targetId: input.targetId, channel: "email" });
  if (!claim.claimed) return { ok: false, status: 409, error: `Action already ${claim.state}: ${claim.reason}` };
  const token = claim.token;
  let started = false;
  try {
    registerOutboundEmail(db, { actionKey: key, targetId: input.targetId, emailAccountId: input.account.id,
      recipient: input.recipient, messageId, subject: input.subject,
      payloadHash: createHash("sha256").update(input.subject + "\0" + input.body).digest("hex") });
    const begun = beginDispatch(db, key, token, () => gate(db, input.targetId, input.account.id, input.recipient, true));
    if (!begun.started) {
      if (releaseClaim(db, key, token)) db.prepare("DELETE FROM email_outbound WHERE action_key = ? AND accepted_at IS NULL").run(key);
      return { ok: false, status: 409, error: begun.reason ?? "Send blocked" };
    }
    started = true;
    const result = await sendEmail(input.account, input.recipient, input.subject, input.body, { messageId });
    if (!result.accepted.some(value => value.toLowerCase() === input.recipient.toLowerCase())) {
      holdUnknown(db, key, token, "SMTP response did not acknowledge recipient");
      return { ok: false, status: 502, error: "SMTP did not acknowledge recipient; held for review" };
    }
    markOutboundAccepted(db, key);
    if (!confirmAction(db, key, token, result.messageId)) throw new Error("Could not confirm durable send action");
    return { ok: true, messageId: result.messageId };
  } catch (err) {
    if (!started) {
      if (releaseClaim(db, key, token)) db.prepare("DELETE FROM email_outbound WHERE action_key = ? AND accepted_at IS NULL").run(key);
      return { ok: false, status: 409, error: err instanceof Error ? err.message : String(err) };
    }
    holdUnknown(db, key, token, err instanceof Error ? err.message : String(err));
    return { ok: false, status: 502, error: "Send outcome uncertain; held for review" };
  }
}

function gate(db: Database.Database, targetId: string, accountId: string, recipient: string, registered: boolean): string | null {
  const target = db.prepare("SELECT email, email_status FROM targets WHERE id = ?")
    .get(targetId) as { email: string | null; email_status: string | null } | undefined;
  if (!target || target.email?.trim().toLowerCase() !== recipient.trim().toLowerCase()) return "Recipient identity changed";
  if (target.email_status === "invalid") return "Email address invalid";
  const eligibility = evaluateEligibility(db, targetId, { channel: "email" });
  const manualBlocks = eligibility.blocks.filter(block => block.reason !== "inbound_reply");
  if (manualBlocks.length) return `Suppressed: ${manualBlocks.map(block => block.reason).join(", ")}`;
  const account = db.prepare(`SELECT is_verified, daily_email_limit, active_hours_start,
    active_hours_end, timezone, working_days FROM email_accounts WHERE id = ?`).get(accountId) as {
      is_verified: number; daily_email_limit: number; active_hours_start: number;
      active_hours_end: number; timezone: string; working_days: string;
    } | undefined;
  if (!account || account.is_verified !== 1) return "Sending account is not verified";
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: account.timezone || "UTC",
    weekday: "short", hour: "numeric", minute: "numeric", hour12: false }).formatToParts(new Date());
  const value = (name: string) => parts.find(part => part.type === name)?.value ?? "";
  const weekday = ({ Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 } as Record<string, number>)[value("weekday")];
  const hour = Number(value("hour")) % 24 + Number(value("minute")) / 60;
  if (!(account.working_days || "1,2,3,4,5").split(",").map(Number).includes(weekday) ||
      hour < (account.active_hours_start ?? 9) || hour >= (account.active_hours_end ?? 18)) {
    return "Outside sending schedule";
  }
  const sentToday = db.prepare(`SELECT COUNT(*) AS count FROM email_outbound
    WHERE email_account_id = ? AND date(created_at) = date('now')`).get(accountId) as { count: number };
  if (sentToday.count > (account.daily_email_limit ?? 0) ||
      (!registered && sentToday.count >= (account.daily_email_limit ?? 0))) return "Daily email limit reached";
  const inbox = isEmailInboxFresh(db, accountId);
  if (!inbox.fresh) return `Inbox sync unavailable: ${inbox.reason}`;
  return null;
}
