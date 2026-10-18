import { createHash } from "crypto";
import type Database from "better-sqlite3";
import { initActionSchema, claimAction, beginDispatch, confirmAction, holdUnknown, releaseClaim } from "@/lib/reliability/actions";
import { evaluateEligibility } from "@/lib/reliability/suppression";
import { isEmailInboxFresh, registerOutboundEmail, markOutboundAccepted } from "@/lib/email/inbox";
import { sendEmail, type EmailAccount } from "@/lib/email/sender";
import { getProviderDispatchBlockReason } from "@/lib/reliability/provider-health";
import { getDispatchBlockReason, initOperationsSchema } from "@/lib/reliability/operations";

/** All prospect-facing direct email must pass the same durable and policy gates as runner sends. */
export async function sendDirectEmail(db: Database.Database, input: {
  targetId: string; account: EmailAccount; recipient: string; subject: string;
  body: string; idempotencyKey: string; replyId?: string; inReplyTo?: string; references?: string[];
}): Promise<{ ok: true; messageId: string } | { ok: false; status: number; error: string }> {
  if (!/^[a-zA-Z0-9._:-]{8,128}$/.test(input.idempotencyKey)) {
    return { ok: false, status: 400, error: "idempotencyKey must be 8–128 safe characters" };
  }
  const key = `manual-email:${input.targetId}:${input.account.id}:${input.idempotencyKey}`;
  const digest = createHash("sha256").update(key).digest("hex");
  const domain = input.account.from_email.split("@")[1];
  const messageId = `<${digest}@${domain}>`;
  initActionSchema(db);
  const initial = gate(db, input.targetId, input.account.id, input.recipient, key, false, input.replyId, input.inReplyTo);
  if (initial) return { ok: false, status: 409, error: initial };
  const claim = claimAction(db, { key, senderId: input.account.id, targetId: input.targetId, channel: "email", recipientIdentity: input.recipient });
  if (!claim.claimed) return { ok: false, status: 409, error: `Action already ${claim.state}: ${claim.reason}` };
  const token = claim.token;
  let started = false;
  try {
    registerOutboundEmail(db, { actionKey: key, targetId: input.targetId, emailAccountId: input.account.id,
      recipient: input.recipient, messageId, subject: input.subject,
      payloadHash: createHash("sha256").update(input.subject + "\0" + input.body + "\0" + (input.inReplyTo ?? "") + "\0" + (input.references ?? []).join(" ")).digest("hex") });
    const begun = beginDispatch(db, key, token, () => gate(db, input.targetId, input.account.id, input.recipient, key, true, input.replyId, input.inReplyTo));
    if (!begun.started) {
      releaseUnsentRegistration(db, key, token);
      return { ok: false, status: 409, error: begun.reason ?? "Send blocked" };
    }
    started = true;
    const result = await sendEmail(input.account, input.recipient, input.subject, input.body, { messageId, inReplyTo: input.inReplyTo, references: input.references,
      ...(!input.replyId ? { unsubscribeActionKey: key } : {}) });
    if (!result.accepted.some(value => value.toLowerCase() === input.recipient.toLowerCase())) {
      holdUnknown(db, key, token, "SMTP response did not acknowledge recipient");
      return { ok: false, status: 502, error: "SMTP did not acknowledge recipient; held for review" };
    }
    markOutboundAccepted(db, key);
    if (!confirmAction(db, key, token, result.messageId)) throw new Error("Could not confirm durable send action");
    return { ok: true, messageId: result.messageId };
  } catch (err) {
    if (!started) {
      releaseUnsentRegistration(db, key, token);
      return { ok: false, status: 409, error: err instanceof Error ? err.message : String(err) };
    }
    holdUnknown(db, key, token, err instanceof Error ? err.message : String(err));
    return { ok: false, status: 502, error: "Send outcome uncertain; held for review" };
  }
}

function releaseUnsentRegistration(db: Database.Database, key: string, token: string): void {
  db.transaction(() => {
    if (releaseClaim(db, key, token)) {
      db.prepare("DELETE FROM email_outbound WHERE action_key = ? AND accepted_at IS NULL").run(key);
    }
  }).immediate();
}

function gate(db: Database.Database, targetId: string, accountId: string, recipient: string, actionKey: string, registered: boolean, replyId?: string, inReplyTo?: string): string | null {
  initOperationsSchema(db);
  const globalBlock = getDispatchBlockReason(db);
  if (globalBlock) return globalBlock;
  const providerBlock = getProviderDispatchBlockReason(db, accountId, "email");
  if (providerBlock) return providerBlock;
  const target = db.prepare("SELECT email, email_status FROM targets WHERE id = ?")
    .get(targetId) as { email: string | null; email_status: string | null } | undefined;
  if (!target || target.email?.trim().toLowerCase() !== recipient.trim().toLowerCase()) return "Recipient identity changed";
  if (target.email_status === "invalid") return "Email address invalid";
  if (replyId) {
    const reply = db.prepare("SELECT target_id, email_account_id, message_id, from_email FROM email_replies WHERE id = ?")
      .get(replyId) as { target_id: string; email_account_id: string | null; message_id: string | null; from_email: string } | undefined;
    if (!reply || reply.target_id !== targetId || reply.email_account_id !== accountId ||
        reply.from_email.trim().toLowerCase() !== recipient.trim().toLowerCase() || reply.message_id !== inReplyTo) {
      return "Reply association changed";
    }
  }
  const assignment = db.prepare(`SELECT COUNT(*) AS total,
    SUM(CASE WHEN email_account_id = ? THEN 1 ELSE 0 END) AS matching
    FROM run_profiles WHERE target_id = ? AND email_account_id IS NOT NULL`)
    .get(accountId, targetId) as { total: number; matching: number | null };
  if (assignment.total > 0 && !assignment.matching) return "Sending account is not assigned to contact";
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
  // Count actual dispatch day, including uncertain outcomes. A claimed, registered
  // action reserves capacity even if its registration happened yesterday.
  const durable = db.prepare(`SELECT COUNT(*) AS count FROM dispatch_actions a
    LEFT JOIN email_outbound o ON o.action_key = a.action_key
    WHERE a.sender_id = ? AND a.channel = 'email' AND a.action_key != ?
      AND ((a.dispatched_at IS NOT NULL AND date(COALESCE(o.accepted_at, a.dispatched_at)) = date('now'))
        OR (a.state = 'claimed' AND a.lease_until > ? AND o.action_key IS NOT NULL))`).get(accountId, actionKey, Date.now()) as { count: number };
  const orphaned = db.prepare(`SELECT COUNT(*) AS count FROM email_outbound o
    WHERE o.email_account_id = ? AND o.accepted_at IS NOT NULL AND date(o.accepted_at) = date('now')
      AND NOT EXISTS (SELECT 1 FROM dispatch_actions a WHERE a.action_key = o.action_key)`)
    .get(accountId) as { count: number };
  // Old installs recorded sends only in logs. Count them conservatively: a log may
  // duplicate a durable action, but fuzzy time matching could undercount real sends.
  const legacy = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'logs'").get()
    ? db.prepare(`SELECT COUNT(*) AS count FROM logs l
        WHERE l.message LIKE 'Email sent%' AND date(l.created_at) = date('now')
          AND EXISTS (SELECT 1 FROM run_profiles rp WHERE rp.run_id = l.run_id
            AND rp.target_id = l.target_id AND rp.email_account_id = ?)`)
      .get(accountId) as { count: number }
    : { count: 0 };
  const used = durable.count + orphaned.count + legacy.count + (registered ? 1 : 0);
  if (registered ? used > (account.daily_email_limit ?? 0) : used >= (account.daily_email_limit ?? 0)) return "Daily email limit reached";
  const inbox = isEmailInboxFresh(db, accountId);
  if (!inbox.fresh) return `Inbox sync unavailable: ${inbox.reason}`;
  return null;
}
