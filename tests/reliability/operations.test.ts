import test from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { beginDispatch, claimAction, getAction, holdUnknown, initActionSchema } from "../../lib/reliability/actions";
import { initInboxStateSchema } from "../../lib/reliability/inbox-state";
import {
  evaluateOperationAlerts, getDispatchBlockReason, getGlobalDispatchControl, getOperationMetrics,
  initOperationsSchema, listOperationAlerts, recordWorkerHeartbeat, reviewHeldAction, setGlobalDispatchPause,
} from "../../lib/reliability/operations";

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
    const audit = db.prepare("SELECT kind, actor_id, reason FROM operation_audit ORDER BY created_at").all() as
      Array<{ kind: string; actor_id: string; reason: string }>;
    assert.deepEqual(audit.map(row => row.kind).sort(), ["global_pause", "global_resume"]);
    assert.ok(audit.every(row => row.actor_id === "operator" && row.reason));
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
