import test from "node:test";
import { createHash } from "node:crypto";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { SMTPServer } from "smtp-server";
import net from "node:net";
import tls from "node:tls";
import { spawn, execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { initEmailReliabilitySchema, registerOutboundEmail, markOutboundAccepted, processInboundEmail, syncEmailInbox, isEmailInboxFresh } from "../../lib/email/inbox";
import { initSuppressionSchema, evaluateEligibility, suppressIdentity } from "../../lib/reliability/suppression";
import { testSmtpConnection } from "../../lib/email/sender";
import { sendDirectEmail } from "../../lib/email/direct";
import { claimAction, initActionSchema } from "../../lib/reliability/actions";
import { initInboxStateSchema, recordInboxSyncSuccess } from "../../lib/reliability/inbox-state";

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
    assert.equal(await processInboundEmail(db, "account", raw({ id: "unrelated@example.com" })), "ambiguous");
    assert.equal((db.prepare("SELECT count(*) c FROM email_replies").get() as { c: number }).c, 0);
    assert.equal(await processInboundEmail(db, "account", raw({ id: "wrong@example.com", from: "mallory@example.net", references: "<other@sender.test>" })), "ignored");
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
    assert.equal((db.prepare("SELECT COUNT(*) AS count FROM dispatch_actions").get() as { count: number }).count, 0);
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
    markOutboundAccepted(db, "already-today");
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


test("complete local TLS IMAP scan captures threaded reply and marks inbox fresh", async () => {
  const dir = mkdtempSync(join(tmpdir(), "linki-imap-"));
  const cert = join(dir, "cert.pem");
  const key = join(dir, "key.pem");
  execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1",
    "-keyout", key, "-out", cert, "-subj", "/CN=localhost", "-addext", "subjectAltName=IP:127.0.0.1"],
    { stdio: "ignore" });
  const message = raw({ id: "imap-reply@example.com", references: "<sent-a@sender.test>" });
  let sawFetch = false;
  const server = tls.createServer({ key: readFileSync(key), cert: readFileSync(cert) }, socket => {
    socket.write("* OK local IMAP ready\r\n");
    let pending = "";
    socket.on("data", chunk => {
      pending += chunk.toString();
      for (;;) {
        const end = pending.indexOf("\r\n");
        if (end < 0) break;
        const line = pending.slice(0, end);
        pending = pending.slice(end + 2);
        const tag = line.split(" ")[0];
        const command = line.toUpperCase();
        if (command.includes("CAPABILITY")) socket.write(`* CAPABILITY IMAP4rev1 UIDPLUS\r\n${tag} OK capability\r\n`);
        else if (command.includes("LOGIN")) socket.write(`${tag} OK login\r\n`);
        else if (command.includes("EXAMINE") || command.includes("SELECT"))
          socket.write(`* FLAGS (\\Seen)\r\n* 1 EXISTS\r\n* OK [UIDVALIDITY 1] valid\r\n${tag} OK [READ-ONLY] selected\r\n`);
        else if (command.includes("SEARCH")) socket.write(`* SEARCH 1\r\n${tag} OK search\r\n`);
        else if (command.includes("FETCH")) {
          sawFetch = true;
          socket.write(`* 1 FETCH (UID 1 BODY[] {${Buffer.byteLength(message)}}\r\n${message}\r\n)\r\n${tag} OK fetch\r\n`);
        } else if (command.includes("LOGOUT")) {
          socket.write(`* BYE closing\r\n${tag} OK logout\r\n`);
          socket.end();
        } else socket.write(`${tag} OK done\r\n`);
      }
    });
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const dbPath = join(dir, "test.sqlite");
  const memory = fixture();
  await memory.backup(dbPath);
  memory.close();
  const db = new Database(dbPath);
  const port = (server.address() as { port: number }).port;
  db.prepare("UPDATE email_accounts SET imap_host='127.0.0.1', imap_port=? WHERE id='account'").run(port);
  db.close();
  try {
    const childPath = resolve("tests/reliability/fixtures/imap-sync-child.ts");
    const output = await new Promise<string>((resolveOutput, reject) => {
      const child = spawn(resolve("node_modules/.bin/tsx"), [childPath, dbPath], {
        env: { ...process.env, NODE_EXTRA_CA_CERTS: cert }, stdio: ["ignore", "pipe", "pipe"] });
      let out = ""; let error = "";
      child.stdout.on("data", data => { out += data; });
      child.stderr.on("data", data => { error += data; });
      child.on("error", reject);
      child.on("close", code => code === 0 ? resolveOutput(out) : reject(new Error(error)));
    });
    assert.match(output, /"replies":1/);
    assert.equal(sawFetch, true);
    const verify = new Database(dbPath);
    try {
      assert.equal((verify.prepare("SELECT count(*) c FROM email_replies").get() as { c: number }).c, 1);
      assert.equal(isEmailInboxFresh(verify, "account").fresh, true);
    } finally { verify.close(); }
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
    rmSync(dir, { recursive: true, force: true });
  }
});


test("local TLS SMTP sends once per direct action and late suppression blocks next action", async () => {
  const dir = mkdtempSync(join(tmpdir(), "linki-smtp-"));
  const cert = join(dir, "cert.pem");
  const key = join(dir, "key.pem");
  execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1",
    "-keyout", key, "-out", cert, "-subj", "/CN=localhost", "-addext", "subjectAltName=IP:127.0.0.1"],
    { stdio: "ignore" });
  let received = 0;
  const receivedMessages: string[] = [];
  const server = new SMTPServer({ secure: true, key: readFileSync(key), cert: readFileSync(cert),
    authOptional: true, onAuth(auth, _session, callback) { callback(null, { user: auth.username }); },
    onData(stream, _session, callback) {
      const chunks: Buffer[] = [];
      stream.on("data", chunk => chunks.push(chunk));
      stream.on("end", () => { received++; receivedMessages.push(Buffer.concat(chunks).toString()); callback(); });
    },
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const dbPath = join(dir, "test.sqlite");
  const memory = fixture();
  await memory.backup(dbPath);
  memory.close();
  const db = new Database(dbPath);
  initInboxStateSchema(db);
  recordInboxSyncSuccess(db, { accountId: "account", channel: "email" });
  db.close();
  const port = (server.server.address() as { port: number }).port;
  const childPath = resolve("tests/reliability/fixtures/direct-send-child.ts");
  async function invoke(idempotencyKey: string, replyTo?: string): Promise<{ ok: boolean; error?: string }> {
    const output = await new Promise<string>((resolveOutput, reject) => {
      const child = spawn(resolve("node_modules/.bin/tsx"), [childPath, dbPath, String(port), idempotencyKey, ...(replyTo ? [replyTo] : [])], {
        env: { ...process.env, NODE_EXTRA_CA_CERTS: cert }, stdio: ["ignore", "pipe", "pipe"] });
      let out = ""; let error = "";
      child.stdout.on("data", data => { out += data; });
      child.stderr.on("data", data => { error += data; });
      child.on("error", reject);
      child.on("close", code => code === 0 ? resolveOutput(out) : reject(new Error(error)));
    });
    return JSON.parse(output);
  }
  try {
    assert.equal((await invoke("direct-request-1")).ok, true);
    assert.equal((await invoke("direct-request-1")).ok, false);
    assert.equal(received, 1);
    assert.equal((await invoke("direct-request-reply", "<inbound-1@example.com>")).ok, true);
    assert.equal(received, 2);
    assert.match(receivedMessages[1], /In-Reply-To: <inbound-1@example.com>/i);
    assert.match(receivedMessages[1], /References: <inbound-1@example.com>/i);
    const update = new Database(dbPath);
    try { suppressIdentity(update, { kind: "email", value: "alice@example.com", reason: "unsubscribe" }); }
    finally { update.close(); }
    const blocked = await invoke("direct-request-2");
    assert.equal(blocked.ok, false);
    assert.match(blocked.error ?? "", /Suppressed/);
    assert.equal(received, 2);
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
    rmSync(dir, { recursive: true, force: true });
  }
});


test("inbox query binds latest reply to receiving sender and POST rejects other sender", async () => {
  const dir = mkdtempSync(join(tmpdir(), "linki-inbox-route-"));
  const dbPath = join(dir, "test.sqlite");
  try {
    const childPath = resolve("tests/reliability/fixtures/inbox-routing-child.ts");
    const output = await new Promise<string>((resolveOutput, reject) => {
      const child = spawn(resolve("node_modules/.bin/tsx"), [childPath], {
        env: { ...process.env, LINKI_DB_PATH: dbPath, NEXTAUTH_SECRET: "synthetic-test-only-secret" },
        stdio: ["ignore", "pipe", "pipe"] });
      let out = ""; let error = "";
      child.stdout.on("data", data => { out += data; });
      child.stderr.on("data", data => { error += data; });
      child.on("error", reject);
      child.on("close", code => code === 0 ? resolveOutput(out) : reject(new Error(error)));
    });
    const result = JSON.parse(output) as { account: string; replyId: string; wrongStatus: number; rightStatus: number; rightBody: { error?: string } };
    assert.equal(result.account, "sender-a");
    assert.equal(result.replyId, "reply-a");
    assert.equal(result.wrongStatus, 409);
    assert.notEqual(result.rightBody.error, "Reply is not bound to this contact, sender, or message");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});


test("hard DSN after 17 KB explanatory text still suppresses exact address", async () => {
  const db = fixture();
  try {
    const report = `From: Mailer-Daemon <mailer-daemon@sender.test>\r\nTo: sender@sender.test\r\nDate: Mon, 2 Feb 2026 12:00:00 +0000\r\nMessage-ID: <long-dsn@example.com>\r\nMIME-Version: 1.0\r\nContent-Type: multipart/report; report-type=delivery-status; boundary="long"\r\n\r\n--long\r\nContent-Type: text/plain\r\n\r\n${"Explanation. ".repeat(1600)}\r\n--long\r\nContent-Type: message/delivery-status\r\n\r\nFinal-Recipient: rfc822; alice@example.com\r\nAction: failed\r\nStatus: 5.1.1\r\n\r\n--long--\r\n`;
    assert.ok(report.length > 17_000);
    assert.equal(await processInboundEmail(db, "account", report), "bounce");
    assert.equal(evaluateEligibility(db, "a", { channel: "email" }).allowed, false);
    assert.equal(evaluateEligibility(db, "b", { channel: "email" }).allowed, true);
  } finally { db.close(); }
});


test("previous-day registered action consumes cap when dispatched today", async () => {
  const db = fixture();
  const idempotencyKey = "old-request-123";
  const key = `manual-email:a:account:${idempotencyKey}`;
  const messageId = `<${createHash("sha256").update(key).digest("hex")}@sender.test>`;
  const yesterday = new Date(Date.now() - 86_400_000).toISOString();
  const account = {
    id: "account", from_email: "sender@sender.test", from_name: null,
    smtp_host: "127.0.0.1", smtp_port: 1, smtp_secure: 0,
    username: "sender", password: "pass",
  };
  try {
    db.prepare("UPDATE email_accounts SET daily_email_limit=1 WHERE id='account'").run();
    initInboxStateSchema(db);
    recordInboxSyncSuccess(db, { accountId: "account", channel: "email" });
    initActionSchema(db);
    const claim = claimAction(db, { key, senderId: "account", targetId: "a", channel: "email",
      now: Date.now() - 86_400_000, leaseMs: 60_000 });
    assert.equal(claim.claimed, true);
    registerOutboundEmail(db, { actionKey: key, targetId: "a", emailAccountId: "account",
      recipient: "alice@example.com", messageId, subject: "Hello",
      payloadHash: createHash("sha256").update("Hello\0Test\0\0").digest("hex"), createdAt: yesterday });
    const first = await sendDirectEmail(db, { targetId: "a", account, recipient: "alice@example.com",
      subject: "Hello", body: "Test", idempotencyKey });
    assert.equal(first.ok, false); // local port rejects SMTP; outcome held after dispatch begins
    const action = db.prepare("SELECT state, dispatched_at FROM dispatch_actions WHERE action_key = ?")
      .get(key) as { state: string; dispatched_at: string | null };
    assert.equal(action.state, "unknown");
    assert.equal(action.dispatched_at?.slice(0, 10), new Date().toISOString().slice(0, 10));
    assert.equal((db.prepare("SELECT created_at FROM email_outbound WHERE action_key = ?").get(key) as { created_at: string }).created_at, yesterday);
    const next = await sendDirectEmail(db, { targetId: "a", account, recipient: "alice@example.com",
      subject: "Another", body: "Test", idempotencyKey: "next-request-123" });
    assert.equal(next.ok, false);
    if (!next.ok) assert.match(next.error, /Daily email limit reached/);
  } finally { db.close(); }
});
