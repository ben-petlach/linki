import test from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import {
  checkEmailDnsReadiness, consumeUnsubscribeToken, createUnsubscribeToken, createUnsubscribeUrl,
  getProviderDispatchBlockReason, initProviderHealthSchema, recordSenderBounce,
  recordTrustedProviderComplaint,
} from "../../lib/reliability/provider-health";
import { evaluateEligibility, initSuppressionSchema } from "../../lib/reliability/suppression";
import { safeConnectionError } from "../../pages/api/email-accounts/[id]/readiness";

function fixture() {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE accounts (id TEXT PRIMARY KEY, is_authenticated INTEGER NOT NULL);
    CREATE TABLE companies (id TEXT PRIMARY KEY, domain TEXT);
    CREATE TABLE targets (id TEXT PRIMARY KEY, email TEXT, linkedin_url TEXT, company_id TEXT);
    CREATE TABLE email_outbound (action_key TEXT PRIMARY KEY, recipient_email TEXT NOT NULL, target_id TEXT NOT NULL);
    INSERT INTO accounts VALUES ('li-live', 1), ('li-expired', 0);
    INSERT INTO companies VALUES ('company', 'example.com');
    INSERT INTO targets VALUES ('person', 'person@example.com', 'https://www.linkedin.com/in/person', 'company');
    INSERT INTO email_outbound VALUES ('action:one', 'person@example.com', 'person');
  `);
  initSuppressionSchema(db);
  initProviderHealthSchema(db);
  return db;
}

test("signed one-click token rejects tampering, and repeated opt-out durably blocks both channels", () => {
  const db = fixture();
  try {
    const token = createUnsubscribeToken("action:one");
    const [payload, signature] = token.split(".");
    assert.equal(consumeUnsubscribeToken(db, `${payload}.${signature.startsWith("A") ? "B" : "A"}${signature.slice(1)}`), "invalid");
    assert.equal(evaluateEligibility(db, "person", { channel: "email" }).allowed, true);
    assert.equal(consumeUnsubscribeToken(db, token), "suppressed");
    assert.equal(consumeUnsubscribeToken(db, token), "already_suppressed");
    assert.equal(evaluateEligibility(db, "person", { channel: "email" }).allowed, false);
    assert.equal(evaluateEligibility(db, "person", { channel: "linkedin" }).allowed, false);
    db.prepare("DELETE FROM targets WHERE id = 'person'").run();
    db.prepare("INSERT INTO targets VALUES ('reimport', 'person@example.com', NULL, 'company')").run();
    assert.equal(evaluateEligibility(db, "reimport", { channel: "email" }).allowed, false);
  } finally { db.close(); }
});

test("one-click API URL requires HTTPS outside localhost; visible link is separate", () => {
  const visible = createUnsubscribeUrl("action:one", "http://localhost:3000");
  const oneClick = createUnsubscribeUrl("action:one", "http://localhost:3000", true);
  assert.match(visible, /^http:\/\/localhost:3000\/unsubscribe\?token=/);
  assert.match(oneClick, /^http:\/\/localhost:3000\/api\/unsubscribe\?token=/);
  assert.throws(() => createUnsubscribeUrl("action:one", "http://example.com"), /HTTPS/);
});

test("three distinct hard bounces hold one sender; repeats and other senders do not count", () => {
  const db = fixture();
  try {
    const at = "2026-10-18T12:00:00.000Z";
    recordSenderBounce(db, { emailAccountId: "sender-a", recipient: "one@example.com", messageId: "dsn-1", receivedAt: at });
    recordSenderBounce(db, { emailAccountId: "sender-a", recipient: "one@example.com", messageId: "dsn-1", receivedAt: at });
    recordSenderBounce(db, { emailAccountId: "sender-a", recipient: "one@example.com", messageId: "dsn-2", receivedAt: at });
    recordSenderBounce(db, { emailAccountId: "sender-a", recipient: "two@example.com", messageId: "dsn-3", receivedAt: at });
    assert.equal(getProviderDispatchBlockReason(db, "sender-a", "email"), null);
    recordSenderBounce(db, { emailAccountId: "sender-a", recipient: "three@example.com", messageId: "dsn-4", receivedAt: at });
    assert.match(getProviderDispatchBlockReason(db, "sender-a", "email") ?? "", /hard_bounce_threshold/);
    assert.equal(getProviderDispatchBlockReason(db, "sender-b", "email"), null);
  } finally { db.close(); }
});

test("authenticated provider complaint holds sender; expired LinkedIn account blocks independently", () => {
  const db = fixture();
  try {
    assert.equal(getProviderDispatchBlockReason(db, "li-live", "linkedin"), null);
    assert.match(getProviderDispatchBlockReason(db, "li-expired", "linkedin") ?? "", /re-authentication/);
    recordTrustedProviderComplaint(db, { emailAccountId: "sender-a", recipient: "person@example.com",
      providerEventId: "provider-42", receivedAt: "2026-10-18T12:00:00Z", source: "authenticated_provider_adapter" });
    assert.match(getProviderDispatchBlockReason(db, "sender-a", "email") ?? "", /provider_complaint/);
    assert.equal(getProviderDispatchBlockReason(db, "sender-b", "email"), null);
  } finally { db.close(); }
});

test("DNS readiness uses injected resolver; unconfigured DKIM selector stays unknown", async () => {
  const seen: string[] = [];
  const resolver = async (name: string): Promise<string[][]> => {
    seen.push(name);
    if (name === "example.com") return [["v=spf1 include:_spf.example.net -all"]];
    if (name === "_dmarc.example.com") return [["v=DMARC1; p=reject"]];
    if (name === "selector._domainkey.example.com") return [["v=DKIM1; p=abc"]];
    throw Object.assign(new Error("missing"), { code: "ENODATA" });
  };
  const unknown = await checkEmailDnsReadiness("sender@example.com", resolver);
  assert.deepEqual(unknown, { domain: "example.com", spf: "present", dmarc: "present", dkim: "unknown" });
  assert.equal(seen.some(name => name.includes("_domainkey")), false);
  const configured = await checkEmailDnsReadiness("sender@example.com", resolver, "selector");
  assert.equal(configured.dkim, "present");
  await assert.rejects(checkEmailDnsReadiness("sender@example.com", resolver, "evil.example.com"), /Invalid DKIM/);
});

test("readiness diagnostics redact provider messages that echo credentials", () => {
  const secret = "synthetic-password";
  const username = "sender@example.com";
  for (const raw of [
    `535 Authentication failed for ${username} password ${secret}`,
    `TLS certificate rejected; attempted password ${secret}`,
    `ECONNRESET: ${username}:${secret}`,
  ]) {
    const safe = safeConnectionError(raw);
    assert.ok(safe);
    assert.equal(safe.includes(secret), false);
    assert.equal(safe.includes(username), false);
  }
});
