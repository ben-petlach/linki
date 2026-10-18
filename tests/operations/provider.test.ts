import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import type { NextApiRequest, NextApiResponse } from "next";
import { simpleParser } from "mailparser";
import { SMTPServer } from "smtp-server";
import { getDb } from "../../lib/db";
import { registerOutboundEmail } from "../../lib/email/inbox";
import unsubscribeHandler from "../../pages/api/unsubscribe";
import {
  checkEmailDnsReadiness, createUnsubscribeToken, createUnsubscribeUrl, getProviderDispatchBlockReason,
  initProviderHealthSchema, recordSenderBounce, recordTrustedProviderComplaint,
} from "../../lib/reliability/provider-health";
import { evaluateEligibility } from "../../lib/reliability/suppression";

const db = getDb();
initProviderHealthSchema(db);

function invokeUnsubscribe(method: string, token: string): { status: number; body: unknown } {
  let status = 0;
  let body: unknown;
  const request = { method, query: { token }, body: {} } as unknown as NextApiRequest;
  const response = {
    setHeader: () => undefined,
    status(value: number) { status = value; return this; },
    json(value: unknown) { body = value; return this; },
  } as unknown as NextApiResponse;
  unsubscribeHandler(request, response);
  return { status, body };
}

test("one-click API requires signed POST and durably suppresses exact outbound recipient", () => {
  db.prepare("INSERT INTO targets (id, email) VALUES ('unsubscribe-a', 'a@example.test'), ('unsubscribe-b', 'b@example.test')").run();
  registerOutboundEmail(db, { actionKey: "unsubscribe-action", targetId: "unsubscribe-a", emailAccountId: "sender-a",
    recipient: "a@example.test", messageId: "<unsubscribe@example.test>", subject: "Fixture" });
  const token = createUnsubscribeToken("unsubscribe-action");
  assert.match(createUnsubscribeUrl("unsubscribe-action", "https://linki.example.test", true), /\/api\/unsubscribe\?token=/);
  assert.equal(invokeUnsubscribe("GET", token).status, 405);
  assert.equal(evaluateEligibility(db, "unsubscribe-a", { channel: "email" }).allowed, true);
  assert.equal(invokeUnsubscribe("POST", `${token}x`).status, 400);
  assert.equal(evaluateEligibility(db, "unsubscribe-a", { channel: "email" }).allowed, true);
  assert.deepEqual(invokeUnsubscribe("POST", token), { status: 200, body: { ok: true, status: "suppressed" } });
  assert.equal(evaluateEligibility(db, "unsubscribe-a", { channel: "email" }).allowed, false);
  assert.equal(evaluateEligibility(db, "unsubscribe-b", { channel: "email" }).allowed, true);
  assert.deepEqual(invokeUnsubscribe("POST", token), { status: 200, body: { ok: true, status: "already_suppressed" } });
  assert.equal((db.prepare("SELECT COUNT(*) AS count FROM suppression_rules WHERE kind = 'email' AND value = 'a@example.test' AND reason = 'unsubscribe_link'")
    .get() as { count: number }).count, 1);
  db.prepare("UPDATE targets SET email = 'changed@example.test' WHERE id = 'unsubscribe-a'").run();
  assert.equal(evaluateEligibility(db, "unsubscribe-a", { channel: "linkedin" }).allowed, false,
    "email edit cannot reopen another outreach channel after opt-out");
});

test("DNS readiness uses injected resolver and reports missing records without network", async () => {
  const queries: string[] = [];
  const result = await checkEmailDnsReadiness("Sender@domain.test", async name => {
    queries.push(name);
    if (name === "domain.test") return [["v=spf1 include:example.test -all"]];
    if (name === "_dmarc.domain.test") return [["v=DMARC1; p=reject"]];
    if (name === "selector._domainkey.domain.test") return [["v=DKIM1; k=rsa; p=fixture"]];
    return [];
  }, "selector");
  assert.deepEqual(result, { domain: "domain.test", spf: "present", dmarc: "present", dkim: "present" });
  assert.deepEqual(queries.sort(), ["_dmarc.domain.test", "domain.test", "selector._domainkey.domain.test"].sort());
  assert.deepEqual(await checkEmailDnsReadiness("sender@domain.test", async () => []),
    { domain: "domain.test", spf: "missing", dmarc: "missing", dkim: "unknown" });
  await assert.rejects(checkEmailDnsReadiness("bad-address", async () => []), /Invalid sender email domain/);
});

test("distinct hard bounces and trusted complaint create durable sender holds", () => {
  db.prepare(`INSERT INTO email_accounts (id, name, from_email, smtp_host, username, password)
    VALUES ('bounce-mail', 'Bounce', 'bounce@example.test', 'localhost', 'bounce', 'fixture'),
           ('complaint-mail', 'Complaint', 'complaint@example.test', 'localhost', 'complaint', 'fixture')`).run();
  const at = "2026-10-18T12:00:00.000Z";
  for (const [recipient, messageId] of [
    ["a@example.test", "<bounce-a@example.test>"], ["b@example.test", "<bounce-b@example.test>"],
  ]) recordSenderBounce(db, { emailAccountId: "bounce-mail", recipient, messageId, receivedAt: at });
  assert.equal(getProviderDispatchBlockReason(db, "bounce-mail", "email"), null);
  recordSenderBounce(db, { emailAccountId: "bounce-mail", recipient: "b@example.test",
    messageId: "<bounce-b@example.test>", receivedAt: at });
  assert.equal(getProviderDispatchBlockReason(db, "bounce-mail", "email"), null);
  recordSenderBounce(db, { emailAccountId: "bounce-mail", recipient: "c@example.test",
    messageId: "<bounce-c@example.test>", receivedAt: at });
  assert.match(getProviderDispatchBlockReason(db, "bounce-mail", "email") ?? "", /hard_bounce_threshold/);
  recordTrustedProviderComplaint(db, { emailAccountId: "complaint-mail", recipient: "someone@example.test",
    providerEventId: "local-provider-event", receivedAt: at, source: "authenticated_provider_adapter" });
  assert.match(getProviderDispatchBlockReason(db, "complaint-mail", "email") ?? "", /provider_complaint/);
  assert.equal((db.prepare("SELECT COUNT(*) AS count FROM provider_sender_events WHERE email_account_id = 'bounce-mail'")
    .get() as { count: number }).count, 3);
});

test("expired LinkedIn session blocks sender until re-authenticated", () => {
  db.prepare("INSERT INTO accounts (id, name, email, is_authenticated) VALUES ('expired-li', 'Expired', 'expired@example.test', 0)").run();
  assert.match(getProviderDispatchBlockReason(db, "expired-li", "linkedin") ?? "", /re-authentication/);
  db.prepare("UPDATE accounts SET is_authenticated = 1 WHERE id = 'expired-li'").run();
  assert.equal(getProviderDispatchBlockReason(db, "expired-li", "linkedin"), null);
});

test("production SMTP output includes one-click headers and visible opt-out only for outreach", async () => {
  const directory = mkdtempSync(join(tmpdir(), "linki-unsubscribe-smtp-"));
  const cert = join(directory, "cert.pem");
  const key = join(directory, "key.pem");
  execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1",
    "-keyout", key, "-out", cert, "-subj", "/CN=localhost", "-addext", "subjectAltName=IP:127.0.0.1"],
  { stdio: "ignore" });
  const received: string[] = [];
  const server = new SMTPServer({ secure: true, key: readFileSync(key), cert: readFileSync(cert),
    authOptional: true, onAuth(auth, _session, callback) { callback(null, { user: auth.username }); },
    onData(stream, _session, callback) {
      const chunks: Buffer[] = [];
      stream.on("data", chunk => chunks.push(chunk));
      stream.on("end", () => { received.push(Buffer.concat(chunks).toString()); callback(); });
    },
  });
  await new Promise<void>(done => server.listen(0, "127.0.0.1", done));
  try {
    const port = (server.server.address() as { port: number }).port;
    const program = `import { sendEmail } from './lib/email/sender.ts';
      (async () => {
      const account = { id:'fixture', from_email:'sender@example.test', from_name:null,
        smtp_host:'127.0.0.1', smtp_port:Number(process.argv[1]), smtp_secure:1,
        username:'fixture', password:'fixture' };
      await sendEmail(account, 'recipient@example.test', 'Campaign', 'Synthetic body',
        { unsubscribeActionKey:'header-fixture-action' });
      await sendEmail(account, 'sender@example.test', 'Connection test', 'Synthetic diagnostic');
      })().catch(error => { console.error(error); process.exitCode = 1; });`;
    const result = await new Promise<{ code: number | null; stderr: string }>((done, fail) => {
      const child = spawn(resolve("node_modules/.bin/tsx"), ["--eval", program, String(port)], {
        env: { ...process.env, NEXTAUTH_URL: "http://localhost:3000", NODE_EXTRA_CA_CERTS: cert },
        stdio: ["ignore", "ignore", "pipe"],
      });
      let stderr = "";
      child.stderr.on("data", chunk => { stderr += chunk; });
      child.on("error", fail);
      child.on("close", code => done({ code, stderr }));
    });
    assert.equal(result.code, 0, result.stderr);
    assert.equal(received.length, 2);
    assert.match(received[0], /List-Unsubscribe:\s*<http:\/\/localhost:3000\/api\/unsubscribe\?token=/i);
    assert.match(received[0], /List-Unsubscribe-Post: List-Unsubscribe=One-Click/i);
    const parsed = await simpleParser(received[0]);
    assert.match(parsed.text ?? "", /Unsubscribe: http:\/\/localhost:3000\/unsubscribe\?token=/i);
    assert.doesNotMatch(received[1], /List-Unsubscribe|Unsubscribe: http/i);
  } finally {
    await new Promise<void>(done => server.close(() => done()));
    rmSync(directory, { recursive: true, force: true });
  }
});
