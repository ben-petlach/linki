import Imap from "imap";
import { simpleParser, type ParsedMail } from "mailparser";
import { randomUUID, createHash } from "crypto";
import type Database from "better-sqlite3";
import { getDb } from "@/lib/db";
import { decryptSecret } from "@/lib/crypto";
import { initInboxStateSchema, recordInboxSyncFailure, recordInboxSyncSuccess, getInboxFreshness } from "@/lib/reliability/inbox-state";
import { suppressIdentity, suppressTarget } from "@/lib/reliability/suppression";
import { recordSenderBounce } from "@/lib/reliability/provider-health";

export const MAX_EMAIL_INBOX_AGE_MS = 5 * 60_000;
const POLL_INTERVAL_MS = 2 * 60_000;

type Db = Database.Database;
interface EmailAccount {
  id: string;
  imap_host: string | null;
  imap_port: number | null;
  username: string;
  password: string;
  imap_username: string | null;
  imap_password: string | null;
}

export function initEmailReliabilitySchema(db: Db): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS email_outbound (
      action_key TEXT PRIMARY KEY,
      target_id TEXT NOT NULL,
      email_account_id TEXT NOT NULL,
      recipient_email TEXT NOT NULL,
      message_id TEXT NOT NULL UNIQUE,
      subject TEXT NOT NULL,
      payload_hash TEXT,
      accepted_at TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_email_outbound_recipient ON email_outbound(recipient_email, accepted_at);
    CREATE TABLE IF NOT EXISTS email_inbound (
      email_account_id TEXT NOT NULL,
      message_id TEXT NOT NULL,
      target_id TEXT,
      kind TEXT NOT NULL,
      received_at TEXT NOT NULL,
      PRIMARY KEY (email_account_id, message_id)
    );
  `);
  const replyTable = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'email_replies'").get();
  if (replyTable) {
    const columns = db.prepare("PRAGMA table_info(email_replies)").all() as Array<{ name: string }>;
    if (!columns.some(column => column.name === "email_account_id")) db.exec("ALTER TABLE email_replies ADD COLUMN email_account_id TEXT");
    if (!columns.some(column => column.name === "message_id")) db.exec("ALTER TABLE email_replies ADD COLUMN message_id TEXT");
  }
}

export function registerOutboundEmail(db: Db, input: {
  actionKey: string; targetId: string; emailAccountId: string;
  recipient: string; messageId: string; subject: string; payloadHash?: string; createdAt?: string;
}): void {
  db.prepare(`INSERT OR IGNORE INTO email_outbound
    (action_key, target_id, email_account_id, recipient_email, message_id, subject, payload_hash, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(input.actionKey, input.targetId, input.emailAccountId,
      input.recipient.trim().toLowerCase(), input.messageId.trim().toLowerCase(), input.subject, input.payloadHash ?? null, input.createdAt ?? new Date().toISOString());
  const row = db.prepare("SELECT target_id, email_account_id, recipient_email, message_id, subject, payload_hash FROM email_outbound WHERE action_key = ?")
    .get(input.actionKey) as { target_id: string; email_account_id: string; recipient_email: string; message_id: string; subject: string; payload_hash: string | null };
  if (row.target_id !== input.targetId || row.email_account_id !== input.emailAccountId ||
      row.recipient_email !== input.recipient.trim().toLowerCase() || row.message_id !== input.messageId.trim().toLowerCase() ||
      row.subject !== input.subject || row.payload_hash !== (input.payloadHash ?? null)) {
    throw new Error("Outbound action key reused with different recipient or message");
  }
}

export function markOutboundAccepted(db: Db, actionKey: string, acceptedAt = new Date().toISOString()): void {
  const result = db.prepare("UPDATE email_outbound SET accepted_at = COALESCE(accepted_at, ?) WHERE action_key = ?")
    .run(acceptedAt, actionKey);
  if (!result.changes) throw new Error("Outbound email record missing");
}

function normalizedMessageId(value: string | null | undefined): string {
  return (value ?? "").trim().toLowerCase();
}

function address(mail: ParsedMail): string {
  return mail.from?.value?.[0]?.address?.trim().toLowerCase() ?? "";
}

function textBody(mail: ParsedMail): string {
  return (mail.text ?? (typeof mail.html === "string" ? mail.html.replace(/<[^>]+>/g, " ") : ""))
    .replace(/\r\n/g, "\n").trim().slice(0, 16_000);
}

function hardBounceRecipient(report: string): string | null {
  for (const section of report.split(/\r?\n\s*\r?\n/)) {
    const recipient = section.match(/Final-Recipient:\s*rfc822;\s*([^\s\r\n]+)/i)?.[1]?.toLowerCase();
    if (recipient && /Action:\s*failed\b/i.test(section) && /Status:\s*5\.\d(?:\.\d+)?\b/i.test(section)) return recipient;
  }
  return null;
}

function headerIds(mail: ParsedMail): string[] {
  const refs = typeof mail.references === "string" ? [mail.references] : (mail.references ?? []);
  return [...refs, mail.inReplyTo ?? ""].flatMap(x => x.match(/<[^<>]+>/g) ?? [])
    .map(normalizedMessageId);
}

/** Returns true only when a durable state change was made. */
export async function processInboundEmail(db: Db, emailAccountId: string, raw: Buffer | string,
  authenticatedImapScan = false, stillOwnsLease?: () => boolean): Promise<"reply" | "unsubscribe" | "bounce" | "ambiguous" | "ignored" | "duplicate"> {
  db.transaction(() => {
    if (stillOwnsLease && !stillOwnsLease()) throw new Error("Inbox lease lost");
    initEmailReliabilitySchema(db);
  }).immediate();
  const mail = await simpleParser(raw);
  if (stillOwnsLease && !stillOwnsLease()) throw new Error("Inbox lease lost");
  const messageId = normalizedMessageId(mail.messageId) || `sha256:${createHash("sha256").update(raw).digest("hex")}`;
  const duplicate = db.prepare("SELECT 1 FROM email_inbound WHERE email_account_id = ? AND message_id = ?")
    .get(emailAccountId, messageId);
  if (duplicate) return "duplicate";
  const receivedAt = (mail.date ?? new Date()).toISOString();
  const from = address(mail);
  const body = textBody(mail);
  const dsnReport = [mail.text ?? "", ...mail.attachments.filter(attachment => attachment.contentType === "message/delivery-status").map(attachment => attachment.content.toString())].join("\n");
  const ids = headerIds(mail);
  let threaded = false;
  let matched: { target_id: string; recipient_email: string; accepted_at: string | null; created_at: string } | undefined;
  for (const id of ids) {
    matched = db.prepare(`SELECT target_id, recipient_email, accepted_at, created_at FROM email_outbound
      WHERE email_account_id = ? AND message_id = ?`).get(emailAccountId, id) as typeof matched;
    if (matched) { threaded = true; break; }
  }
  const isDsn = /mailer-daemon|postmaster|mail-delivery-subsystem|delivery-status/i.test(from);
  const finalRecipient = isDsn ? hardBounceRecipient(dsnReport) : null;
  const unsubscribed = /\b(unsubscribe|remove me|stop emailing|do not email|don't email|opt out)\b/i.test(body);
  // Unthreaded opt-outs and DSNs use exact address plus accepted outbound chronology.
  // Ordinary replies require RFC threading IDs; old unrelated email cannot pause a campaign.
  if (!matched && (finalRecipient || from)) {
    matched = db.prepare(`SELECT target_id, recipient_email, accepted_at, created_at FROM email_outbound
      WHERE email_account_id = ? AND recipient_email = ? AND accepted_at IS NOT NULL AND accepted_at <= ?
      ORDER BY accepted_at DESC LIMIT 1`).get(emailAccountId, finalRecipient ?? from, receivedAt) as typeof matched;
  }
  if (!matched || Date.parse(receivedAt) < Date.parse(matched.accepted_at ?? matched.created_at)) return "ignored";
  if (isDsn) {
    if (!finalRecipient || finalRecipient !== matched.recipient_email) return "ignored";
    db.transaction(() => {
      if (stillOwnsLease && !stillOwnsLease()) throw new Error("Inbox lease lost");
      db.prepare("INSERT INTO email_inbound (email_account_id, message_id, target_id, kind, received_at) VALUES (?, ?, ?, 'bounce', ?)")
        .run(emailAccountId, messageId, matched!.target_id, receivedAt);
      db.prepare("UPDATE targets SET email_status = 'invalid' WHERE id = ?").run(matched!.target_id);
      suppressIdentity(db, { kind: "email", value: finalRecipient, reason: "hard_bounce", evidence: messageId });
      if (authenticatedImapScan) recordSenderBounce(db, { emailAccountId, recipient: finalRecipient, messageId,
        receivedAt: new Date().toISOString() });
      db.prepare(`UPDATE run_profile_tracks SET state = 'skipped', error_message = 'Email bounced — invalid address'
        WHERE run_profile_id IN (SELECT id FROM run_profiles WHERE target_id = ?) AND track = 'email' AND state IN ('pending', 'in_progress')`)
        .run(matched!.target_id);
    }).immediate();
    return "bounce";
  }
  if (from !== matched.recipient_email) return "ignored";
  if (!threaded && !unsubscribed) {
    db.transaction(() => {
      if (stillOwnsLease && !stillOwnsLease()) throw new Error("Inbox lease lost");
      db.prepare("INSERT INTO email_inbound (email_account_id, message_id, target_id, kind, received_at) VALUES (?, ?, ?, 'ambiguous', ?)")
        .run(emailAccountId, messageId, matched!.target_id, receivedAt);
      suppressTarget(db, matched!.target_id, "ambiguous_inbound", messageId);
    }).immediate();
    return "ambiguous";
  }
  const kind = unsubscribed ? "unsubscribe" : "reply";
  db.transaction(() => {
    if (stillOwnsLease && !stillOwnsLease()) throw new Error("Inbox lease lost");
    db.prepare("INSERT INTO email_inbound (email_account_id, message_id, target_id, kind, received_at) VALUES (?, ?, ?, ?, ?)")
      .run(emailAccountId, messageId, matched!.target_id, kind, receivedAt);
    db.prepare(`INSERT INTO email_replies (id, target_id, run_id, email_account_id, message_id, from_email, subject, body_text, received_at)
      VALUES (?, ?, (SELECT rp.run_id FROM run_profiles rp WHERE rp.target_id = ? AND rp.email_account_id = ? ORDER BY rp.created_at DESC LIMIT 1), ?, ?, ?, ?, ?, ?)`)
      .run(randomUUID(), matched!.target_id, matched!.target_id, emailAccountId, emailAccountId, messageId, from, mail.subject ?? null, body, receivedAt);
    db.prepare("UPDATE targets SET email_replied_at = COALESCE(email_replied_at, ?) WHERE id = ?")
      .run(receivedAt, matched!.target_id);
    suppressTarget(db, matched!.target_id, "inbound_reply", messageId);
    if (unsubscribed) {
      suppressTarget(db, matched!.target_id, "unsubscribe", messageId);
      suppressIdentity(db, { kind: "email", value: from, reason: "unsubscribe", evidence: messageId });
    }
    db.prepare(`UPDATE run_profile_tracks SET state = 'skipped', error_message = 'Lead replied'
      WHERE run_profile_id IN (SELECT id FROM run_profiles WHERE target_id = ?) AND state IN ('pending', 'in_progress')`)
      .run(matched!.target_id);
  }).immediate();
  return kind;
}

export function isEmailInboxFresh(db: Db, emailAccountId: string): { fresh: boolean; reason: string | null } {
  initInboxStateSchema(db);
  return getInboxFreshness(db, { accountId: emailAccountId, channel: "email", maxAgeMs: MAX_EMAIL_INBOX_AGE_MS });
}

export function shouldSyncEmailInbox(emailAccountId: string): boolean {
  const db = getDb();
  const row = db.prepare("SELECT inbox_synced_at FROM email_accounts WHERE id = ?").get(emailAccountId) as { inbox_synced_at: string | null } | undefined;
  if (!row?.inbox_synced_at || !isEmailInboxFresh(db, emailAccountId).fresh) return true;
  return Date.now() - Date.parse(row.inbox_synced_at + (row.inbox_synced_at.includes("T") ? "" : "Z")) >= POLL_INTERVAL_MS;
}

function readMessage(imap: Imap, uid: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    const fetch = imap.fetch(uid, { bodies: "", struct: false });
    fetch.on("message", msg => msg.on("body", stream => stream.on("data", (chunk: Buffer) => chunks.push(chunk))));
    fetch.once("error", reject);
    fetch.once("end", () => resolve(Buffer.concat(chunks)));
  });
}

function search(imap: Imap, criteria: unknown[]): Promise<number[]> {
  return new Promise((resolve, reject) => imap.search(criteria as Parameters<Imap["search"]>[0], (err, uids) => err ? reject(err) : resolve(uids)));
}

function withTimeout<T>(operation: Promise<T>, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  return Promise.race([
    operation,
    new Promise<T>((_, reject) => { timer = setTimeout(() => reject(new Error(`${label} timed out`)), 30_000); }),
  ]).finally(() => clearTimeout(timer!));
}

export async function syncEmailInbox(emailAccountId: string, db: Db = getDb(), stillOwnsLease?: () => boolean): Promise<{ replies: number; bounces: number }> {
  const startedAt = new Date().toISOString();
  db.transaction(() => {
    if (stillOwnsLease && !stillOwnsLease()) throw new Error("Inbox lease lost");
    initEmailReliabilitySchema(db);
    initInboxStateSchema(db);
  }).immediate();
  const account = db.prepare(`SELECT id, imap_host, imap_port, username, password, imap_username, imap_password
    FROM email_accounts WHERE id = ?`).get(emailAccountId) as EmailAccount | undefined;
  if (!account?.imap_host) {
    db.transaction(() => {
      if (stillOwnsLease && !stillOwnsLease()) return;
      recordInboxSyncFailure(db, { accountId: emailAccountId, channel: "email", error: "IMAP not configured", startedAt });
    }).immediate();
    throw new Error("IMAP not configured");
  }
  const earliest = db.prepare(`SELECT MIN(COALESCE(accepted_at, created_at)) AS at FROM email_outbound WHERE email_account_id = ?`)
    .get(emailAccountId) as { at: string | null };
  const since = earliest.at ? new Date(earliest.at) : new Date();
  since.setUTCDate(since.getUTCDate() - 1); // IMAP SINCE compares calendar dates.
  const imap = new Imap({ host: account.imap_host, port: account.imap_port ?? 993, tls: true,
    tlsOptions: { rejectUnauthorized: true }, user: account.imap_username ?? account.username,
    password: decryptSecret(account.imap_password) ?? decryptSecret(account.password)!,
    authTimeout: 10_000, connTimeout: 12_000 });
  let replies = 0;
  let bounces = 0;
  let connectionError: Error | null = null;
  imap.on("error", err => { connectionError = err; });
  try {
    await withTimeout(new Promise<void>((resolve, reject) => {
      imap.once("ready", () => resolve());
      imap.once("error", reject);
      imap.connect();
    }), "IMAP connection");
    await withTimeout(new Promise<void>((resolve, reject) => imap.openBox("INBOX", true, err => err ? reject(err) : resolve())), "IMAP openBox");
    const uids = await withTimeout(search(imap, [["SINCE", since]]), "IMAP search");
    for (const uid of uids) {
      if (connectionError) throw connectionError;
      const kind = await processInboundEmail(db, emailAccountId, await withTimeout(readMessage(imap, uid), "IMAP fetch"), true, stillOwnsLease);
      if (kind === "reply" || kind === "unsubscribe") replies++;
      if (kind === "bounce") bounces++;
    }
    if (connectionError) throw connectionError;
    db.transaction(() => {
      if (stillOwnsLease && !stillOwnsLease()) throw new Error("Inbox lease lost");
      recordInboxSyncSuccess(db, { accountId: emailAccountId, channel: "email", startedAt });
      db.prepare("UPDATE email_accounts SET inbox_synced_at = datetime('now') WHERE id = ?").run(emailAccountId);
    }).immediate();
    return { replies, bounces };
  } catch (err) {
    db.transaction(() => {
      if (stillOwnsLease && !stillOwnsLease()) return;
      recordInboxSyncFailure(db, { accountId: emailAccountId, channel: "email", error: err instanceof Error ? err.message : String(err), startedAt });
    }).immediate();
    throw err;
  } finally {
    try { imap.end(); } catch { /* connection may have failed before setup */ }
  }
}
