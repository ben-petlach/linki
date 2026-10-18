import { createHmac, timingSafeEqual } from "node:crypto";
import { resolveTxt } from "node:dns/promises";
import type Database from "better-sqlite3";
import { initSuppressionSchema, suppressIdentity } from "@/lib/reliability/suppression";

type Db = Database.Database;
type Channel = "email" | "linkedin";
type TxtResolver = (name: string) => Promise<string[][]>;

export function initProviderHealthSchema(db: Db): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS provider_sender_events (
      email_account_id TEXT NOT NULL,
      message_id TEXT NOT NULL,
      recipient_email TEXT NOT NULL,
      kind TEXT NOT NULL CHECK(kind IN ('hard_bounce', 'complaint')),
      source TEXT NOT NULL,
      received_at TEXT NOT NULL,
      PRIMARY KEY(email_account_id, message_id, kind)
    );
    CREATE INDEX IF NOT EXISTS idx_provider_sender_events ON provider_sender_events(email_account_id, kind, received_at);
    CREATE TABLE IF NOT EXISTS provider_sender_holds (
      sender_id TEXT NOT NULL,
      channel TEXT NOT NULL CHECK(channel IN ('email', 'linkedin')),
      reason TEXT NOT NULL,
      evidence TEXT NOT NULL,
      held_at TEXT NOT NULL,
      cleared_at TEXT,
      PRIMARY KEY(sender_id, channel, reason)
    );
  `);
}

/** Called only after authenticated IMAP retrieval and exact DSN recipient matching. */
export function recordSenderBounce(db: Db, input: {
  emailAccountId: string; recipient: string; messageId: string; receivedAt: string;
}): void {
  initProviderHealthSchema(db);
  db.transaction(() => {
    db.prepare(`INSERT OR IGNORE INTO provider_sender_events
      (email_account_id, message_id, recipient_email, kind, source, received_at)
      VALUES (?, ?, ?, 'hard_bounce', 'authenticated_imap_dsn', ?)`)
      .run(input.emailAccountId, input.messageId, input.recipient.toLowerCase(), input.receivedAt);
    const count = db.prepare(`SELECT COUNT(DISTINCT recipient_email) AS count FROM provider_sender_events
      WHERE email_account_id = ? AND kind = 'hard_bounce' AND received_at >= ?`)
      .get(input.emailAccountId, new Date(Date.parse(input.receivedAt) - 24 * 60 * 60_000).toISOString()) as { count: number };
    if (count.count >= 3) {
      db.prepare(`INSERT OR IGNORE INTO provider_sender_holds
        (sender_id, channel, reason, evidence, held_at) VALUES (?, 'email', 'hard_bounce_threshold', ?, ?)`)
        .run(input.emailAccountId, `${count.count} distinct hard bounced recipients within 24 hours; latest=${input.messageId}`, input.receivedAt);
    }
  })();
}

/** No public complaint endpoint. A future authenticated provider adapter may call this. */
export function recordTrustedProviderComplaint(db: Db, input: {
  emailAccountId: string; recipient: string; providerEventId: string; receivedAt: string;
  source: "authenticated_provider_adapter";
}): void {
  initProviderHealthSchema(db);
  db.transaction(() => {
    db.prepare(`INSERT OR IGNORE INTO provider_sender_events
      (email_account_id, message_id, recipient_email, kind, source, received_at)
      VALUES (?, ?, ?, 'complaint', ?, ?)`)
      .run(input.emailAccountId, input.providerEventId, input.recipient.toLowerCase(), input.source, input.receivedAt);
    db.prepare(`INSERT OR IGNORE INTO provider_sender_holds
      (sender_id, channel, reason, evidence, held_at) VALUES (?, 'email', 'provider_complaint', ?, ?)`)
      .run(input.emailAccountId, input.providerEventId, input.receivedAt);
  })();
}

export function getProviderDispatchBlockReason(db: Db, senderId: string, channel: Channel): string | null {
  initProviderHealthSchema(db);
  const hold = db.prepare(`SELECT reason, evidence FROM provider_sender_holds
    WHERE sender_id = ? AND channel = ? AND cleared_at IS NULL ORDER BY held_at LIMIT 1`)
    .get(senderId, channel) as { reason: string; evidence: string } | undefined;
  if (hold) return `Provider sender hold: ${hold.reason} (${hold.evidence})`;
  if (channel === "linkedin") {
    const account = db.prepare("SELECT is_authenticated FROM accounts WHERE id = ?")
      .get(senderId) as { is_authenticated: number } | undefined;
    if (!account || account.is_authenticated !== 1) return "LinkedIn session needs re-authentication";
  }
  return null;
}

function signingKey(): string {
  const secret = process.env.NEXTAUTH_SECRET;
  if (!secret || secret.length < 16) throw new Error("NEXTAUTH_SECRET must be set for unsubscribe links");
  return secret;
}

export function createUnsubscribeToken(actionKey: string): string {
  const payload = Buffer.from(JSON.stringify({ v: 1, actionKey })).toString("base64url");
  const signature = createHmac("sha256", signingKey()).update(`linki.unsubscribe.v1.${payload}`).digest("base64url");
  return `${payload}.${signature}`;
}

export function createUnsubscribeUrl(actionKey: string, origin = process.env.NEXTAUTH_URL, oneClick = false): string {
  if (!origin) throw new Error("NEXTAUTH_URL must be set for unsubscribe links");
  const base = new URL(origin);
  if (!(["https:", "http:"].includes(base.protocol)) || (base.protocol === "http:" && !["localhost", "127.0.0.1"].includes(base.hostname))) {
    throw new Error("NEXTAUTH_URL must use HTTPS outside localhost");
  }
  const url = new URL(oneClick ? "/api/unsubscribe" : "/unsubscribe", base);
  url.searchParams.set("token", createUnsubscribeToken(actionKey));
  return url.toString();
}

export function consumeUnsubscribeToken(db: Db, token: string): "suppressed" | "already_suppressed" | "invalid" {
  if (typeof token !== "string" || token.length > 2048 || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(token)) return "invalid";
  const [payload, signature] = token.split(".");
  const expected = createHmac("sha256", signingKey()).update(`linki.unsubscribe.v1.${payload}`).digest();
  let actual: Buffer;
  try { actual = Buffer.from(signature, "base64url"); } catch { return "invalid"; }
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return "invalid";
  let parsed: { v?: unknown; actionKey?: unknown };
  try { parsed = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")); } catch { return "invalid"; }
  if (parsed.v !== 1 || typeof parsed.actionKey !== "string" || parsed.actionKey.length > 512) return "invalid";
  const outbound = db.prepare(`SELECT recipient_email FROM email_outbound WHERE action_key = ?`).get(parsed.actionKey) as { recipient_email: string } | undefined;
  if (!outbound) return "invalid";
  initSuppressionSchema(db);
  const existing = db.prepare(`SELECT 1 FROM suppression_rules WHERE kind = 'email' AND value = ? AND reason = 'unsubscribe_link'`)
    .get(outbound.recipient_email);
  if (existing) return "already_suppressed";
  suppressIdentity(db, { kind: "email", value: outbound.recipient_email, reason: "unsubscribe_link", evidence: `outbound:${parsed.actionKey}` });
  return "suppressed";
}

export async function checkEmailDnsReadiness(fromEmail: string, resolver: TxtResolver = resolveTxt, dkimSelector?: string): Promise<{
  domain: string; spf: "present" | "missing" | "multiple" | "error";
  dmarc: "present" | "missing" | "error"; dkim: "present" | "missing" | "unknown" | "error";
}> {
  const domain = fromEmail.trim().toLowerCase().split("@")[1];
  if (!domain || !/^[a-z0-9.-]+\.[a-z]{2,}$/.test(domain)) throw new Error("Invalid sender email domain");
  const records = async (name: string): Promise<string[] | null> => {
    try { return (await resolver(name)).map(parts => parts.join("")); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENODATA" || (error as NodeJS.ErrnoException).code === "ENOTFOUND") return [];
      return null;
    }
  };
  const [domainRecords, dmarcRecords] = await Promise.all([records(domain), records(`_dmarc.${domain}`)]);
  const spfCount = domainRecords?.filter(record => /^v=spf1(?:\s|$)/i.test(record)).length;
  const spf = spfCount === undefined ? "error" : spfCount === 0 ? "missing" : spfCount === 1 ? "present" : "multiple";
  const dmarc = dmarcRecords === null ? "error" : dmarcRecords.some(record => /^v=dmarc1(?:;|\s|$)/i.test(record)) ? "present" : "missing";
  let dkim: "present" | "missing" | "unknown" | "error" = "unknown";
  if (dkimSelector) {
    if (!/^[a-z0-9-]{1,63}$/i.test(dkimSelector)) throw new Error("Invalid DKIM selector");
    const dkimRecords = await records(`${dkimSelector}._domainkey.${domain}`);
    dkim = dkimRecords === null ? "error" : dkimRecords.some(record => /\bv=DKIM1\b/i.test(record)) ? "present" : "missing";
  }
  return { domain, spf, dmarc, dkim };
}
