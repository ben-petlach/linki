import test from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { encode } from "next-auth/jwt";
import type { NextApiRequest, NextApiResponse } from "next";
import { beginDispatch, claimAction, confirmAction, getAction, holdUnknown, initActionSchema } from "../../lib/reliability/actions";
import { initInboxStateSchema } from "../../lib/reliability/inbox-state";
import {
  evaluateOperationAlerts, getDispatchBlockReason, getGlobalDispatchControl, getOperationMetrics,
  initOperationsSchema, listOperationAlerts, recordWorkerHeartbeat, reviewHeldAction, setGlobalDispatchPause,
} from "../../lib/reliability/operations";
import { isSameOriginMutation } from "../../lib/reliability/operations-auth";
import pauseHandler from "../../pages/api/operations/pause";
import reviewHandler from "../../pages/api/operations/actions/[actionKey]/review";
import { getDb } from "../../lib/db";

function database(): Database.Database {
  const db = new Database(":memory:");
  initActionSchema(db);
  initOperationsSchema(db);
  initInboxStateSchema(db);
  db.exec(`CREATE TABLE email_outbound (action_key TEXT PRIMARY KEY, target_id TEXT NOT NULL,
    email_account_id TEXT NOT NULL, recipient_email TEXT NOT NULL, message_id TEXT NOT NULL,
    accepted_at TEXT);
    CREATE TABLE email_inbound (email_account_id TEXT, message_id TEXT, kind TEXT, PRIMARY KEY(email_account_id, message_id));
    CREATE TABLE linkedin_inbox_events (account_id TEXT, event_id TEXT, target_id TEXT, received_at TEXT,
      PRIMARY KEY(account_id, event_id));`);
  return db;
}

function hold(db: Database.Database, key: string, channel = "email") {
  const claimed = claimAction(db, { key, senderId: "sender", targetId: "target", channel });
  assert.equal(claimed.claimed, true);
  if (!claimed.claimed) throw new Error("claim failed");
  assert.equal(beginDispatch(db, key, claimed.token, () => getDispatchBlockReason(db)).started, true);
  assert.equal(holdUnknown(db, key, claimed.token, "provider timeout"), true);
}

test("global pause persists and is audited; outbound final gate blocks while inbox state remains writable", () => {
  const db = database();
  try {
    setGlobalDispatchPause(db, { paused: true, actorId: "operator", reason: "investigating provider", now: "2026-10-18T13:00:00.000Z" });
    assert.match(getDispatchBlockReason(db) ?? "", /investigating provider/);
    const claim = claimAction(db, { key: "blocked", senderId: "sender", targetId: "target", channel: "email" });
    if (!claim.claimed) throw new Error("claim failed");
    assert.deepEqual(beginDispatch(db, "blocked", claim.token, () => getDispatchBlockReason(db)).started, false);
    db.prepare(`INSERT INTO inbox_sync_state (account_id,channel,last_successful_at)
      VALUES ('sender','email','2026-10-18T13:01:00.000Z')`).run();
    assert.equal((db.prepare("SELECT COUNT(*) AS count FROM inbox_sync_state").get() as { count: number }).count, 1);
    setGlobalDispatchPause(db, { paused: false, actorId: "operator", reason: "provider healthy" });
    assert.equal(getDispatchBlockReason(db), null);
    assert.equal(getGlobalDispatchControl(db).paused, false);
    const audit = db.prepare("SELECT kind, actor_id, reason, before_state, after_state FROM operation_audit ORDER BY rowid").all() as
      Array<{ kind: string; actor_id: string; reason: string; before_state: string; after_state: string }>;
    assert.deepEqual(audit.map(row => row.kind).sort(), ["global_pause", "global_resume"]);
    assert.ok(audit.every(row => row.actor_id === "operator" && row.reason));
    assert.deepEqual(audit.map(row => [row.before_state, row.after_state]), [["running", "paused"], ["paused", "running"]]);
  } finally { db.close(); }
});

test("unresolved action stays held; only exact durable SMTP acceptance confirms without another send", () => {
  const db = database();
  try {
    hold(db, "email:1");
    assert.deepEqual(reviewHeldAction(db, { actionKey: "email:1", actorId: "operator", reason: "Checked mailbox",
      evidence: "No matching message", decision: "note" }).confirmed, false);
    assert.equal(getAction(db, "email:1")?.state, "unknown");
    assert.throws(() => reviewHeldAction(db, { actionKey: "email:1", actorId: "operator", reason: "I think sent",
      evidence: "Typed provider ID", decision: "confirm_provider_accepted" }), /No durable provider acceptance/);
    assert.equal(getAction(db, "email:1")?.state, "unknown");
    db.prepare(`INSERT INTO email_outbound (action_key,target_id,email_account_id,recipient_email,message_id,accepted_at)
      VALUES ('email:1','target','sender','person@example.test','<provider-id>','2026-10-18T13:00:00.000Z')`).run();
    assert.equal(reviewHeldAction(db, { actionKey: "email:1", actorId: "operator", reason: "SMTP acceptance inspected",
      evidence: "<provider-id> in durable SMTP result", decision: "confirm_provider_accepted" }).confirmed, true);
    assert.equal(getAction(db, "email:1")?.state, "confirmed");
    assert.equal(getAction(db, "email:1")?.evidence, "<provider-id>");
    assert.throws(() => reviewHeldAction(db, { actionKey: "email:1", actorId: "operator", reason: "again",
      evidence: "again", decision: "confirm_provider_accepted" }), /Action is not held/);
    const audit = db.prepare("SELECT kind, reason, evidence FROM operation_audit WHERE action_key = ? ORDER BY created_at")
      .all("email:1") as Array<{ kind: string; reason: string; evidence: string }>;
    assert.deepEqual(audit.map(row => row.kind), ["review_note", "provider_reconciled"]);
    assert.ok(audit.every(row => row.reason && row.evidence));
  } finally { db.close(); }
});

test("operator can reconcile crash-left sending; original recipient and exact worker evidence remain fenced", () => {
  const db = database();
  try {
    const claim = claimAction(db, { key: "inflight", senderId: "sender", targetId: "target", channel: "email",
      recipientIdentity: "original@example.test" });
    if (!claim.claimed) throw new Error("claim failed");
    assert.equal(beginDispatch(db, "inflight", claim.token, () => null).started, true);
    assert.equal(getAction(db, "inflight")?.recipient_identity, "original@example.test");
    db.prepare(`INSERT INTO email_outbound (action_key,target_id,email_account_id,recipient_email,message_id,accepted_at)
      VALUES ('inflight','target','sender','original@example.test','<provider-confirmed>','2026-10-18T13:00:00.000Z')`).run();
    assert.equal(reviewHeldAction(db, { actionKey: "inflight", actorId: "operator", reason: "Durable SMTP accepted",
      evidence: "<provider-confirmed>", decision: "confirm_provider_accepted" }).confirmed, true);
    assert.equal(confirmAction(db, "inflight", claim.token, "<provider-confirmed>"), true);
    assert.equal(confirmAction(db, "inflight", "stale-token", "<provider-confirmed>"), false);
    assert.equal(confirmAction(db, "inflight", claim.token, "wrong-id"), false);
    assert.throws(() => reviewHeldAction(db, { actionKey: "inflight", actorId: "operator", reason: "duplicate",
      evidence: "<provider-confirmed>", decision: "confirm_provider_accepted" }), /Action is not held/);
    const row = db.prepare("SELECT before_state, after_state FROM operation_audit WHERE action_key = 'inflight'")
      .get() as { before_state: string; after_state: string };
    assert.deepEqual(row, { before_state: "sending", after_state: "confirmed" });
  } finally { db.close(); }
});

test("alert sink deduplicates held, inbox, and worker faults then resolves recovered faults", () => {
  const db = database();
  try {
    const at = "2026-10-18T13:00:00.000Z";
    hold(db, "email:2");
    db.prepare(`INSERT INTO inbox_sync_state (account_id,channel,last_successful_at)
      VALUES ('sender','email','2026-10-18T12:00:00.000Z')`).run();
    evaluateOperationAlerts(db, { now: at });
    evaluateOperationAlerts(db, { now: at });
    assert.deepEqual(listOperationAlerts(db).map(alert => alert.kind).sort(), ["action_held", "inbox_stale", "worker_stale"]);
    assert.equal((db.prepare("SELECT COUNT(*) AS count FROM operation_alerts").get() as { count: number }).count, 3);
    recordWorkerHeartbeat(db, "scheduler", at);
    db.prepare("UPDATE inbox_sync_state SET last_successful_at = ? WHERE account_id = 'sender'").run(at);
    db.prepare("UPDATE dispatch_actions SET state = 'confirmed', evidence = 'provider-id' WHERE action_key = 'email:2'").run();
    evaluateOperationAlerts(db, { now: at });
    assert.equal(listOperationAlerts(db).length, 0);
  } finally { db.close(); }
});

test("verified account with no inbox scan alerts; LinkedIn cadence does not flap at 16 minutes", () => {
  const db = database();
  try {
    db.exec("CREATE TABLE email_accounts (id TEXT PRIMARY KEY, is_verified INTEGER NOT NULL);");
    db.exec("CREATE TABLE accounts (id TEXT PRIMARY KEY, is_authenticated INTEGER NOT NULL);");
    db.prepare("INSERT INTO email_accounts (id, is_verified) VALUES ('mail', 1)").run();
    db.prepare("INSERT INTO accounts (id, is_authenticated) VALUES ('li', 1)").run();
    const at = "2026-10-18T13:00:00.000Z";
    recordWorkerHeartbeat(db, "scheduler", at);
    evaluateOperationAlerts(db, { now: at });
    assert.deepEqual(listOperationAlerts(db).map(alert => alert.subject_id).sort(), ["email:mail", "linkedin:li"]);
    db.prepare(`INSERT INTO inbox_sync_state (account_id, channel, last_successful_at)
      VALUES ('mail','email',?), ('li','linkedin',?)`).run(at, "2026-10-18T12:44:00.000Z");
    evaluateOperationAlerts(db, { now: at });
    assert.equal(listOperationAlerts(db).length, 0);
  } finally { db.close(); }
});

test("metrics come from durable actions and inbound events; logs and claims do not inflate sends", () => {
  const db = database();
  try {
    hold(db, "email:3");
    const claim = claimAction(db, { key: "claimed-only", senderId: "sender", targetId: "target", channel: "email" });
    assert.equal(claim.claimed, true);
    db.prepare(`INSERT INTO email_outbound (action_key,target_id,email_account_id,recipient_email,message_id,accepted_at)
      VALUES ('email:3','target','sender','person@example.test','<accepted>','2026-10-18T13:00:00.000Z')`).run();
    db.prepare(`INSERT INTO email_inbound (email_account_id,message_id,kind) VALUES
      ('sender','<reply>','reply'),('sender','<bounce>','bounce'),('sender','<stop>','unsubscribe')`).run();
    db.prepare(`INSERT INTO linkedin_inbox_events (account_id,event_id,target_id,received_at)
      VALUES ('li-sender','urn:li:msg_message:(reply)','target','2026-10-18T13:00:00.000Z')`).run();
    assert.deepEqual(getOperationMetrics(db), {
      attempted: 1, confirmed: 0, emailAccepted: 1, replied: 2, bounced: 1, unsubscribed: 1, unknown: 1,
    });
  } finally { db.close(); }
});

test("operator pause API requires signed session and same origin; actor comes from session", async () => {
  const db = getDb();
  db.prepare("INSERT INTO users (id, email, password_hash) VALUES (?, ?, ?)")
    .run("operator-api", "operator-api@example.test", "synthetic-hash");
  const token = await encode({ token: { sub: "operator-api", email: "operator-api@example.test" },
    secret: process.env.NEXTAUTH_SECRET!, maxAge: 60 });
  const cookie = `next-auth.session-token=${token}`;
  const key = "operator-api:review";
  hold(db, key);
  function request(origin: string | undefined, cookieValue: string | undefined): NextApiRequest {
    const headers: Record<string, string> = { host: "localhost:3000" };
    if (origin) headers.origin = origin;
    if (cookieValue) headers.cookie = cookieValue;
    return { method: "POST", headers, cookies: cookieValue ? { "next-auth.session-token": token } : {},
      body: { paused: true, reason: "synthetic test", actorId: "forged-client-id" } } as unknown as NextApiRequest;
  }
  function response() {
    let code = 200;
    let body: unknown;
    const headers: Record<string, string | string[]> = {};
    const res = {
      status(value: number) { code = value; return res; },
      json(value: unknown) { body = value; return res; },
      end() { return res; },
      setHeader(key: string, value: string | string[]) { headers[key.toLowerCase()] = value; return res; },
      getHeader(key: string) { return headers[key.toLowerCase()]; },
    } as unknown as NextApiResponse;
    return { res, get code() { return code; }, get body() { return body; } };
  }
  assert.equal(isSameOriginMutation(request("https://evil.example", cookie)), false);
  const unauth = response();
  await pauseHandler(request("http://localhost:3000", undefined), unauth.res);
  assert.equal(unauth.code, 401);
  const cross = response();
  await pauseHandler(request("https://evil.example", cookie), cross.res);
  assert.equal(cross.code, 403);
  const same = response();
  await pauseHandler(request("http://localhost:3000", cookie), same.res);
  assert.equal(same.code, 200);
  const audit = db.prepare("SELECT actor_id FROM operation_audit WHERE kind = 'global_pause' ORDER BY rowid DESC LIMIT 1")
    .get() as { actor_id: string };
  assert.equal(audit.actor_id, "operator-api");

  const reviewRequest = (origin: string | undefined, cookieValue: string | undefined) => {
    const req = request(origin, cookieValue);
    req.query = { actionKey: key };
    req.body = { decision: "note", reason: "provider not yet confirmed", evidence: "checked durable ledger", actorId: "forged-client-id" };
    return req;
  };
  const badReview = response();
  await reviewHandler(reviewRequest("https://evil.example", cookie), badReview.res);
  assert.equal(badReview.code, 403);
  const validReview = response();
  await reviewHandler(reviewRequest("http://localhost:3000", cookie), validReview.res);
  assert.equal(validReview.code, 200);
  const reviewAudit = db.prepare("SELECT actor_id, before_state, after_state FROM operation_audit WHERE action_key = ?")
    .get(key) as { actor_id: string; before_state: string; after_state: string };
  assert.deepEqual(reviewAudit, { actor_id: "operator-api", before_state: "unknown", after_state: "unknown" });
});
