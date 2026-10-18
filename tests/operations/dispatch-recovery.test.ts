import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { getDb } from "../../lib/db";
import { sendDirectEmail } from "../../lib/email/direct";
import { markOutboundAccepted, registerOutboundEmail } from "../../lib/email/inbox";
import { dispatchStep } from "../../lib/linkedin/runner";
import { actionKey, getAction } from "../../lib/reliability/actions";
import { recordInboxSyncSuccess } from "../../lib/reliability/inbox-state";
import { reviewHeldAction, setGlobalDispatchPause } from "../../lib/reliability/operations";

const db = getDb();
const schedule = { active_hours_start: 0, active_hours_end: 24, timezone: "UTC", working_days: "1,2,3,4,5,6,7" };

function seed(prefix: string) {
  const senderId = `${prefix}-mail`;
  const targetId = `${prefix}-target`;
  const runId = `${prefix}-run`;
  const trackId = `${prefix}-track`;
  const stepId = `${prefix}-step`;
  const recipient = `${prefix}@example.test`;
  db.prepare("INSERT INTO accounts (id, name, email) VALUES (?, ?, ?)").run(`${prefix}-li`, prefix, `${prefix}-li@example.test`);
  db.prepare(`INSERT INTO email_accounts (id, name, from_email, smtp_host, username, password, is_verified,
    active_hours_start, active_hours_end, working_days)
    VALUES (?, ?, ?, 'localhost', ?, 'fixture', 1, 0, 24, '1,2,3,4,5,6,7')`)
    .run(senderId, prefix, `${prefix}-sender@example.test`, prefix);
  db.prepare("INSERT INTO targets (id, email) VALUES (?, ?)").run(targetId, recipient);
  db.prepare("INSERT INTO workflows (id, name) VALUES (?, ?)").run(`${prefix}-flow`, prefix);
  db.prepare(`INSERT INTO runs (id, workflow_id, account_id, email_account_id, status)
    VALUES (?, ?, ?, ?, 'running')`).run(runId, `${prefix}-flow`, `${prefix}-li`, senderId);
  db.prepare("INSERT INTO run_profiles (id, run_id, target_id, email_account_id) VALUES (?, ?, ?, ?)")
    .run(`${prefix}-profile`, runId, targetId, senderId);
  db.prepare(`INSERT INTO run_profile_tracks (id, run_profile_id, track, state, current_step)
    VALUES (?, ?, 'email', 'in_progress', 0)`).run(trackId, `${prefix}-profile`);
  recordInboxSyncSuccess(db, { accountId: senderId, channel: "email", completedAt: new Date().toISOString() });
  return {
    senderId, targetId, runId, trackId, stepId, recipient,
    track: { id: trackId, run_profile_id: `${prefix}-profile`, run_id: runId, current_step: 0 } as Parameters<typeof dispatchStep>[1],
    step: { id: stepId } as Parameters<typeof dispatchStep>[2],
    target: { id: targetId } as Parameters<typeof dispatchStep>[3],
  };
}

test("pre-SMTP pause after registration retries same action without duplicate outbound or send", async () => {
  const f = seed("retry");
  const key = actionKey(f.trackId, f.stepId);
  const messageId = `<${createHash("sha256").update(key).digest("hex")}@retry-sender@example.test>`;
  let providerCalls = 0;
  const first = await dispatchStep(db, f.track, f.step, f.target, f.senderId, "email", 50, schedule,
    "initial generated payload", f.recipient, async beforeSend => {
      registerOutboundEmail(db, { actionKey: key, targetId: f.targetId, emailAccountId: f.senderId,
        recipient: f.recipient, messageId, subject: "Initial generated subject" });
      setGlobalDispatchPause(db, { paused: true, actorId: "fixture", reason: "incident before SMTP" });
      beforeSend();
      providerCalls++;
      return { messageId };
    }, result => result.messageId);
  assert.equal(first, "deferred");
  assert.equal(providerCalls, 0);
  assert.equal(getAction(db, key), undefined);
  assert.equal((db.prepare("SELECT COUNT(*) AS count FROM email_outbound WHERE action_key = ?").get(key) as { count: number }).count, 0,
    "pre-SMTP refusal must clear only unaccepted reservation so edited content can retry");

  setGlobalDispatchPause(db, { paused: false, actorId: "fixture", reason: "incident cleared" });
  const second = await dispatchStep(db, f.track, f.step, f.target, f.senderId, "email", 50, schedule,
    "revised generated payload", f.recipient, async beforeSend => {
      registerOutboundEmail(db, { actionKey: key, targetId: f.targetId, emailAccountId: f.senderId,
        recipient: f.recipient, messageId, subject: "Revised generated subject" });
      beforeSend();
      providerCalls++;
      markOutboundAccepted(db, key);
      return { messageId };
    }, result => result.messageId);
  assert.equal(second, "sent");
  assert.equal(providerCalls, 1);
  assert.equal(getAction(db, key)?.state, "confirmed");
  assert.equal((db.prepare("SELECT COUNT(*) AS count FROM email_outbound WHERE action_key = ?").get(key) as { count: number }).count, 1);
  assert.equal((db.prepare("SELECT subject FROM email_outbound WHERE action_key = ?").get(key) as { subject: string }).subject,
    "Revised generated subject");
});

test("operator reconciliation during adapter completion preserves confirmed dispatch", async () => {
  const f = seed("race");
  const key = actionKey(f.trackId, f.stepId);
  const messageId = "<race-accepted@example.test>";
  const result = await dispatchStep(db, f.track, f.step, f.target, f.senderId, "email", 50, schedule,
    "fixture payload", f.recipient, async beforeSend => {
      registerOutboundEmail(db, { actionKey: key, targetId: f.targetId, emailAccountId: f.senderId,
        recipient: f.recipient, messageId, subject: "Fixture" });
      beforeSend();
      markOutboundAccepted(db, key);
      assert.deepEqual(reviewHeldAction(db, { actionKey: key, actorId: "operator", reason: "provider ledger confirmed",
        evidence: messageId, decision: "confirm_provider_accepted" }),
      { confirmed: true, reason: "Provider acceptance reconciled without resend" });
      await Promise.resolve();
      return { messageId };
    }, accepted => accepted.messageId);
  assert.equal(result, "sent");
  assert.equal(getAction(db, key)?.state, "confirmed");
  assert.equal((db.prepare("SELECT state FROM run_profile_tracks WHERE id = ?").get(f.trackId) as { state: string }).state,
    "in_progress", "dispatch boundary must not mark successful track failed");
});

test("global pause blocks production direct email before SMTP or durable action", async () => {
  const f = seed("directpause");
  setGlobalDispatchPause(db, { paused: true, actorId: "operator", reason: "all outbound stopped" });
  try {
    const result = await sendDirectEmail(db, {
      targetId: f.targetId, recipient: f.recipient, subject: "Fixture", body: "Synthetic",
      idempotencyKey: "direct-pause-fixture", account: {
        id: f.senderId, from_email: "directpause-sender@example.test", from_name: null,
        smtp_host: "127.0.0.1", smtp_port: 1, smtp_secure: 1, username: "fixture", password: "fixture",
      },
    });
    assert.equal(result.ok, false);
    if (!result.ok) assert.match(result.error, /Global dispatch paused/);
    assert.equal((db.prepare("SELECT COUNT(*) AS count FROM dispatch_actions WHERE target_id = ?")
      .get(f.targetId) as { count: number }).count, 0);
  } finally {
    setGlobalDispatchPause(db, { paused: false, actorId: "operator", reason: "fixture complete" });
  }
});
