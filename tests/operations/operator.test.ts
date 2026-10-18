import assert from "node:assert/strict";
import test from "node:test";
import { getDb } from "../../lib/db";
import { markOutboundAccepted, registerOutboundEmail } from "../../lib/email/inbox";
import { beginDispatch, claimAction, getAction, holdUnknown } from "../../lib/reliability/actions";
import {
  evaluateOperationAlerts, getDispatchBlockReason, getOperationMetrics, initOperationsSchema,
  listHeldActions, listOperationAlerts, recordWorkerHeartbeat, reviewHeldAction, setGlobalDispatchPause,
} from "../../lib/reliability/operations";

const db = getDb();
initOperationsSchema(db);
const at = "2026-10-18T12:00:00.000Z";

test("unknown action stays held until exact durable provider acceptance; review is audited", () => {
  db.prepare("INSERT INTO email_accounts (id, name, from_email, smtp_host, username, password) VALUES (?, ?, ?, ?, ?, ?)")
    .run("operator-mail", "Operator Mail", "operator@example.test", "localhost", "operator", "fixture");
  db.prepare("INSERT INTO targets (id, email, full_name) VALUES (?, ?, ?)")
    .run("operator-target", "contact@example.test", "Contact Test");
  const key = "operator-track:email-step";
  const claim = claimAction(db, { key, senderId: "operator-mail", targetId: "operator-target", channel: "email",
    recipientIdentity: "contact@example.test" });
  assert.equal(claim.claimed, true);
  if (!claim.claimed) return;
  assert.equal(beginDispatch(db, key, claim.token, () => null).started, true);
  assert.equal(holdUnknown(db, key, claim.token, "SMTP timeout after DATA"), true);
  const held = listHeldActions(db).find(row => row.action_key === key);
  assert.equal(held?.sender_id, "operator-mail");
  assert.equal(held?.recipient, "contact@example.test");
  assert.equal(held?.reason, "SMTP timeout after DATA");
  assert.equal(held?.state, "unknown");
  assert.throws(() => reviewHeldAction(db, { actionKey: key, actorId: "reviewer", reason: "Check provider",
    evidence: "operator typed a claimed ID", decision: "confirm_provider_accepted", now: at }),
  /No durable provider acceptance/);
  assert.deepEqual(reviewHeldAction(db, { actionKey: key, actorId: "reviewer", reason: "Still investigating",
    evidence: "provider search found no accepted event", decision: "note", now: at }),
  { confirmed: false, reason: "Action remains held" });
  assert.equal(getAction(db, key)?.state, "unknown");
  assert.equal(claimAction(db, { key, senderId: "operator-mail", targetId: "operator-target", channel: "email" }).claimed, false);

  registerOutboundEmail(db, { actionKey: key, targetId: "operator-target", emailAccountId: "operator-mail",
    recipient: "contact@example.test", messageId: "<accepted@example.test>", subject: "Fixture" });
  markOutboundAccepted(db, key, at);
  assert.deepEqual(reviewHeldAction(db, { actionKey: key, actorId: "reviewer", reason: "Provider ledger matched",
    evidence: "<accepted@example.test>", decision: "confirm_provider_accepted", now: at }),
  { confirmed: true, reason: "Provider acceptance reconciled without resend" });
  assert.equal(getAction(db, key)?.state, "confirmed");
  assert.equal(getAction(db, key)?.evidence, "<accepted@example.test>");
  assert.equal(listHeldActions(db).some(row => row.action_key === key), false);
  assert.throws(() => reviewHeldAction(db, { actionKey: key, actorId: "reviewer", reason: "Again",
    evidence: "<accepted@example.test>", decision: "confirm_provider_accepted", now: at }), /Action is not held/);
  const audit = db.prepare("SELECT kind, actor_id, reason, evidence FROM operation_audit WHERE action_key = ? ORDER BY rowid")
    .all(key) as Array<{ kind: string; actor_id: string; reason: string; evidence: string }>;
  assert.deepEqual(audit.map(x => x.kind), ["review_note", "provider_reconciled"]);
  assert.equal(audit[1].actor_id, "reviewer");
  assert.equal(audit[1].evidence, "<accepted@example.test>");
});

test("global pause persists, records actor, and local alert sink deduplicates and resolves", () => {
  setGlobalDispatchPause(db, { paused: true, actorId: "operator-1", reason: "mailbox incident", now: at });
  assert.match(getDispatchBlockReason(db) ?? "", /mailbox incident/);
  const control = db.prepare("SELECT paused, updated_by, reason FROM global_dispatch_control WHERE id = 1")
    .get() as { paused: number; updated_by: string; reason: string };
  assert.deepEqual(control, { paused: 1, updated_by: "operator-1", reason: "mailbox incident" });

  evaluateOperationAlerts(db, { now: at });
  const first = listOperationAlerts(db);
  assert.ok(first.some(x => x.fingerprint === "worker:scheduler"));
  const firstSeen = first.find(x => x.fingerprint === "worker:scheduler")?.first_seen_at;
  evaluateOperationAlerts(db, { now: "2026-10-18T12:01:00.000Z" });
  assert.equal(listOperationAlerts(db).filter(x => x.fingerprint === "worker:scheduler").length, 1);
  assert.equal(listOperationAlerts(db).find(x => x.fingerprint === "worker:scheduler")?.first_seen_at, firstSeen);
  recordWorkerHeartbeat(db, "scheduler", "2026-10-18T12:02:00.000Z");
  evaluateOperationAlerts(db, { now: "2026-10-18T12:02:00.000Z" });
  assert.equal(listOperationAlerts(db).some(x => x.fingerprint === "worker:scheduler"), false);
  assert.equal((db.prepare("SELECT status FROM operation_alerts WHERE fingerprint = 'worker:scheduler'")
    .get() as { status: string }).status, "resolved");
  setGlobalDispatchPause(db, { paused: false, actorId: "operator-2", reason: "fixture cleared", now: "2026-10-18T12:03:00.000Z" });
  assert.equal(getDispatchBlockReason(db), null);
  assert.deepEqual((db.prepare("SELECT kind, actor_id FROM operation_audit WHERE kind IN ('global_pause','global_resume') ORDER BY rowid")
    .all() as Array<{ kind: string; actor_id: string }>), [
      { kind: "global_pause", actor_id: "operator-1" }, { kind: "global_resume", actor_id: "operator-2" },
    ]);
});

test("metrics separate accepted, reply, bounce and unknown durable events", () => {
  db.prepare(`INSERT INTO email_inbound (email_account_id, message_id, target_id, kind, received_at)
    VALUES ('operator-mail', '<reply@example.test>', 'operator-target', 'reply', ?),
           ('operator-mail', '<bounce@example.test>', 'operator-target', 'bounce', ?)`).run(at, at);
  const second = claimAction(db, { key: "operator-track:unknown-step", senderId: "operator-mail",
    targetId: "operator-target", channel: "email" });
  assert.equal(second.claimed, true);
  if (!second.claimed) return;
  assert.equal(beginDispatch(db, "operator-track:unknown-step", second.token, () => null).started, true);
  assert.equal(holdUnknown(db, "operator-track:unknown-step", second.token, "response lost"), true);
  assert.deepEqual(getOperationMetrics(db), {
    attempted: 2, confirmed: 1, emailAccepted: 1, replied: 1, bounced: 1, unsubscribed: 0, unknown: 1,
  });
  evaluateOperationAlerts(db, { now: "2026-10-18T12:03:00.000Z" });
  assert.ok(listOperationAlerts(db).some(x => x.fingerprint === "action:operator-track:unknown-step"));
});
