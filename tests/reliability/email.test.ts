import test from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { SMTPServer } from "smtp-server";
import net from "node:net";
import { initEmailReliabilitySchema, registerOutboundEmail, markOutboundAccepted, processInboundEmail, syncEmailInbox, isEmailInboxFresh } from "../../lib/email/inbox";
import { initSuppressionSchema, evaluateEligibility } from "../../lib/reliability/suppression";
import { testSmtpConnection } from "../../lib/email/sender";
import { sendDirectEmail } from "../../lib/email/direct";

function fixture() {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE email_accounts (id TEXT PRIMARY KEY, imap_host TEXT, imap_port INTEGER, username TEXT, password TEXT, imap_username TEXT, imap_password TEXT, inbox_synced_at TEXT, is_verified INTEGER DEFAULT 1, daily_email_limit INTEGER DEFAULT 50, active_hours_start INTEGER DEFAULT 0, active_hours_end INTEGER DEFAULT 24, timezone TEXT DEFAULT 'UTC', working_days TEXT DEFAULT '1,2,3,4,5,6,7');
    CREATE TABLE companies (id TEXT PRIMARY KEY, domain TEXT, email_domain_invalid INTEGER DEFAULT 0);
    CREATE TABLE targets (id TEXT PRIMARY KEY, email TEXT, linkedin_url TEXT, company_id TEXT, email_status TEXT DEFAULT 'valid', email_replied_at TEXT);
    CREATE TABLE run_profiles (id TEXT PRIMARY KEY, run_id TEXT, target_id TEXT, email_account_id TEXT, created_at TEXT);
    CREATE TABLE run_profile_tracks (id TEXT PRIMARY KEY, run_profile_id TEXT, track TEXT, state TEXT, error_message TEXT);
    CREATE TABLE email_replies (id TEXT PRIMARY KEY, target_id TEXT, run_id TEXT, from_email TEXT, subject TEXT, body_text TEXT, received_at TEXT);
    INSERT INTO email_accounts (id,username,password) VALUES ('account','sender','pass');
    INSERT INTO companies (id, domain) VALUES ('c','example.com');
    INSERT INTO targets (id,email,linkedin_url,company_id) VALUES
      ('a','alice@example.com','https://www.linkedin.com/in/alice','c'),
      ('b','bob@example.com','https://www.linkedin.com/in/bob','c');
    INSERT INTO run_profiles (id,run_id,target_id,email_account_id,created_at) VALUES
      ('p','r','a','account','2026-01-01T00:00:00Z'),
      ('q','r','b','account','2026-01-01T00:00:00Z');
    INSERT INTO run_profile_tracks (id,run_profile_id,track,state) VALUES
      ('pa','p','email','in_progress'),('pb','q','email','in_progress');
  `);
  initEmailReliabilitySchema(db);
  initSuppressionSchema(db);
  registerOutboundEmail(db, { actionKey: "send-a", targetId: "a", emailAccountId: "account",
    recipient: "alice@example.com", messageId: "<sent-a@sender.test>", subject: "Hello" });
  markOutboundAccepted(db, "send-a", "2026-02-01T00:00:00.000Z");
  return db;
}

function raw(input: { id: string; from?: string; date?: string; references?: string; body?: string }) {
  return `From: <${input.from ?? "alice@example.com"}>\r\nTo: sender@sender.test\r\nDate: ${input.date ?? "Mon, 2 Feb 2026 12:00:00 +0000"}\r\nMessage-ID: <${input.id}>\r\nSubject: Re: Hello\r\n${input.references ? `In-Reply-To: ${input.references}\r\nReferences: ${input.references}\r\n` : ""}Content-Type: text/plain; charset=utf-8\r\n\r\n${input.body ?? "Thanks"}`;
}

test("only exact outbound threading counts; duplicate inbound message is idempotent", async () => {
  const db = fixture();
  try {
    assert.equal(await processInboundEmail(db, "account", raw({ id: "old@example.com", date: "Thu, 1 Jan 2026 12:00:00 +0000" })), "ignored");
    assert.equal(await processInboundEmail(db, "account", raw({ id: "unrelated@example.com" })), "ignored");
    assert.equal(await processInboundEmail(db, "account", raw({ id: "wrong@example.com", references: "<other@sender.test>" })), "ignored");
    assert.equal(await processInboundEmail(db, "account", raw({ id: "reply@example.com", references: "<sent-a@sender.test>" })), "reply");
    assert.equal(await processInboundEmail(db, "account", raw({ id: "reply@example.com", references: "<sent-a@sender.test>" })), "duplicate");
    assert.equal((db.prepare("SELECT count(*) c FROM email_replies").get() as { c: number }).c, 1);
    assert.ok((db.prepare("SELECT email_replied_at FROM targets WHERE id='a'").get() as { email_replied_at: string }).email_replied_at);
    assert.equal((db.prepare("SELECT state FROM run_profile_tracks WHERE id='pa'").get() as { state: string }).state, "skipped");
    assert.equal((db.prepare("SELECT state FROM run_profile_tracks WHERE id='pb'").get() as { state: string }).state, "in_progress");
    assert.equal(evaluateEligibility(db, "a", { channel: "linkedin" }).allowed, false);
  } finally { db.close(); }
});

test("out-of-office reply pauses all channels", async () => {
  const db = fixture();
  try {
    assert.equal(await processInboundEmail(db, "account", raw({ id: "ooo@example.com", references: "<sent-a@sender.test>", body: "Out of office until Monday" })), "reply");
    assert.equal(evaluateEligibility(db, "a", { channel: "linkedin" }).allowed, false);
  } finally { db.close(); }
});

test("unthreaded explicit opt-out persists through reimport", async () => {
  const db = fixture();
  try {
    assert.equal(await processInboundEmail(db, "account", raw({ id: "optout@example.com", body: "Please remove me" })), "unsubscribe");
    db.prepare("DELETE FROM targets WHERE id='a'").run();
    db.prepare("INSERT INTO targets (id,email,company_id) VALUES ('new','alice@example.com','c')").run();
    assert.equal(evaluateEligibility(db, "new", { channel: "email" }).allowed, false);
  } finally { db.close(); }
});

test("hard bounce blocks exact address but leaves same-company sibling eligible", async () => {
  const db = fixture();
  try {
    const dsn = `From: Mailer-Daemon <mailer-daemon@sender.test>\r\nTo: sender@sender.test\r\nDate: Mon, 2 Feb 2026 12:00:00 +0000\r\nMessage-ID: <dsn@example.com>\r\nMIME-Version: 1.0\r\nContent-Type: multipart/report; report-type=delivery-status; boundary="b"\r\n\r\n--b\r\nContent-Type: text/plain\r\n\r\nUndeliverable\r\n--b\r\nContent-Type: message/delivery-status\r\n\r\nFinal-Recipient: rfc822; alice@example.com\r\nAction: failed\r\nStatus: 5.1.1\r\n\r\n--b--\r\n`;
    assert.equal(await processInboundEmail(db, "account", dsn), "bounce");
    assert.equal(evaluateEligibility(db, "a", { channel: "email" }).allowed, false);
    assert.equal(evaluateEligibility(db, "b", { channel: "email" }).allowed, true);
    assert.equal((db.prepare("SELECT email_domain_invalid FROM companies WHERE id='c'").get() as { email_domain_invalid: number }).email_domain_invalid, 0);
  } finally { db.close(); }
});

test("SMTP connection rejects local self-signed STARTTLS certificate", async () => {
  const server = new SMTPServer({ authOptional: true, logger: false, onData(stream, _session, callback) { stream.on("data", () => {}); stream.on("end", () => callback()); } });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  try {
    const port = (server.server.address() as { port: number }).port;
    const result = await testSmtpConnection({ from_email: "sender@sender.test", from_name: null,
      smtp_host: "127.0.0.1", smtp_port: port, smtp_secure: 0,
      username: "sender", password: "pass" });
    assert.match(result ?? "", /certificate|self.signed/i, "self-signed certificate must fail connection verification");
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});


test("failed IMAP synchronization records failure and blocks freshness", async () => {
  const db = fixture();
  const server = net.createServer(socket => socket.destroy());
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  try {
    const port = (server.address() as { port: number }).port;
    db.prepare("UPDATE email_accounts SET imap_host='127.0.0.1', imap_port=? WHERE id='account'").run(port);
    await assert.rejects(syncEmailInbox("account", db));
    assert.equal(isEmailInboxFresh(db, "account").fresh, false);
    const state = db.prepare("SELECT last_successful_at, last_failure_at FROM inbox_sync_state WHERE account_id='account'")
      .get() as { last_successful_at: string | null; last_failure_at: string | null };
    assert.equal(state.last_successful_at, null);
    assert.ok(state.last_failure_at);
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
    db.close();
  }
});


test("direct email cannot bypass incomplete inbox sync", async () => {
  const db = fixture();
  try {
    const result = await sendDirectEmail(db, {
      targetId: "a", recipient: "alice@example.com", subject: "Hello", body: "Test",
      idempotencyKey: "fixed-request-123", account: {
        id: "account", from_email: "sender@sender.test", from_name: null,
        smtp_host: "127.0.0.1", smtp_port: 1, smtp_secure: 0,
        username: "sender", password: "pass",
      },
    });
    assert.equal(result.ok, false);
    if (!result.ok) assert.match(result.error, /Inbox sync unavailable/);
    const actions = db.prepare("SELECT name FROM sqlite_master WHERE name='dispatch_actions'").get();
    assert.equal(actions, undefined);
  } finally { db.close(); }
});


test("temporary DSN leaves address and company eligible", async () => {
  const db = fixture();
  try {
    const dsn = raw({ id: "soft@example.com", from: "mailer-daemon@sender.test",
      body: "Final-Recipient: rfc822; alice@example.com\nAction: delayed\nStatus: 4.2.0" });
    assert.equal(await processInboundEmail(db, "account", dsn), "ignored");
    assert.equal(evaluateEligibility(db, "a", { channel: "email" }).allowed, true);
  } finally { db.close(); }
});

test("reply after SMTP acceptance but before local acknowledgement still pauses recipient", async () => {
  const db = fixture();
  try {
    db.prepare("UPDATE email_outbound SET accepted_at = NULL, created_at = '2026-02-01T00:00:00.000Z' WHERE action_key = 'send-a'").run();
    assert.equal(await processInboundEmail(db, "account", raw({ id: "crash-window@example.com", references: "<sent-a@sender.test>" })), "reply");
    assert.equal(evaluateEligibility(db, "a", { channel: "email" }).allowed, false);
    assert.equal((db.prepare("SELECT accepted_at FROM email_outbound WHERE action_key='send-a'").get() as { accepted_at: string | null }).accepted_at, null);
  } finally { db.close(); }
});


test("direct send enforces verified sender and daily cap before SMTP", async () => {
  const db = fixture();
  const input = {
    targetId: "a", recipient: "alice@example.com", subject: "Hello", body: "Test",
    idempotencyKey: "fixed-request-123", account: {
      id: "account", from_email: "sender@sender.test", from_name: null,
      smtp_host: "127.0.0.1", smtp_port: 1, smtp_secure: 0,
      username: "sender", password: "pass",
    },
  };
  try {
    db.prepare("UPDATE email_accounts SET is_verified=0 WHERE id='account'").run();
    const unverified = await sendDirectEmail(db, input);
    assert.equal(unverified.ok, false);
    if (!unverified.ok) assert.match(unverified.error, /not verified/);
    db.prepare("UPDATE email_accounts SET is_verified=1, daily_email_limit=1 WHERE id='account'").run();
    registerOutboundEmail(db, { actionKey: "already-today", targetId: "b", emailAccountId: "account",
      recipient: "bob@example.com", messageId: "<sent-b@sender.test>", subject: "Hello" });
    const capped = await sendDirectEmail(db, input);
    assert.equal(capped.ok, false);
    if (!capped.ok) assert.match(capped.error, /Daily email limit/);
  } finally { db.close(); }
});

test("reusing action key with changed payload is rejected", () => {
  const db = fixture();
  try {
    registerOutboundEmail(db, { actionKey: "same", targetId: "a", emailAccountId: "account",
      recipient: "alice@example.com", messageId: "<same@sender.test>", subject: "Hello", payloadHash: "old" });
    assert.throws(() => registerOutboundEmail(db, { actionKey: "same", targetId: "a", emailAccountId: "account",
      recipient: "alice@example.com", messageId: "<same@sender.test>", subject: "Hello", payloadHash: "new" }),
      /reused with different/);
  } finally { db.close(); }
});
