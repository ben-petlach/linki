import assert from "node:assert/strict";
import { test } from "node:test";
import { getDb } from "../../lib/db";
import { dispatchStep } from "../../lib/linkedin/runner";
import { WeeklyLimitError } from "../../lib/linkedin/connect";
import { recordInboxSyncFailure, recordInboxSyncSuccess } from "../../lib/reliability/inbox-state";
import { actionKey, getAction } from "../../lib/reliability/actions";
import { suppressTarget } from "../../lib/reliability/suppression";

const db = getDb();
const schedule = { active_hours_start: 0, active_hours_end: 24, timezone: "UTC", working_days: "1,2,3,4,5,6,7" };
db.prepare("INSERT INTO accounts (id, name, email, is_authenticated) VALUES (?, ?, ?, 1)")
  .run("ben", "Ben", "ben@example.test");
db.prepare("INSERT INTO accounts (id, name, email, is_authenticated) VALUES (?, ?, ?, 1)")
  .run("philipp", "Philipp", "philipp@example.test");
db.prepare(`INSERT INTO email_accounts (id, name, from_email, smtp_host, username, password, is_verified)
  VALUES (?, ?, ?, 'localhost', ?, 'fixture', 1)`).run("mail", "Mail", "mail@example.test", "mail");
db.prepare("INSERT INTO workflows (id, name) VALUES ('guard-workflow', 'Guards')").run();
db.prepare("INSERT INTO workflow_steps (id, workflow_id, step_order, step_type) VALUES ('guard-step', 'guard-workflow', 1, 'connect')").run();

function fixture(id: string, targetId: string, accountId: string, channel: "email" | "linkedin",
  status: "running" | "completed" = "running", trackState: "in_progress" | "completed" = "in_progress") {
  db.prepare("INSERT OR IGNORE INTO targets (id, linkedin_url, email) VALUES (?, ?, ?)")
    .run(targetId, `https://www.linkedin.com/in/${targetId}/`, `${targetId}@example.test`);
  db.prepare("INSERT INTO runs (id, workflow_id, account_id, status) VALUES (?, 'guard-workflow', ?, ?)")
    .run(id, accountId, status);
  db.prepare("INSERT INTO run_profiles (id, run_id, target_id, email_account_id) VALUES (?, ?, ?, ?)")
    .run(`${id}-profile`, id, targetId, channel === "email" ? "mail" : null);
  db.prepare(`INSERT INTO run_profile_tracks (id, run_profile_id, track, state, current_step)
    VALUES (?, ?, ?, ?, 0)`).run(`${id}-track`, `${id}-profile`, channel, trackState);
  return { id: `${id}-track`, run_profile_id: `${id}-profile`, run_id: id, current_step: 0 } as Parameters<typeof dispatchStep>[1];
}

function send(track: Parameters<typeof dispatchStep>[1], targetId: string, senderId: string,
  channel: "email" | "connect", callback: Parameters<typeof dispatchStep>[10]) {
  const recipient = channel === "email" ? `${targetId}@example.test` : `https://www.linkedin.com/in/${targetId}/`;
  return dispatchStep(db, track, { id: "guard-step" } as Parameters<typeof dispatchStep>[2],
    { id: targetId } as Parameters<typeof dispatchStep>[3], senderId, channel, 50, schedule,
    "fixture", recipient, callback, result => (result as { evidence: string }).evidence);
}

test("same target's completed LinkedIn run blocks email when historical sender inbox fails", async () => {
  fixture("old-li", "cross-a", "ben", "linkedin", "completed", "completed");
  db.prepare("INSERT INTO logs (id, run_id, target_id, message) VALUES (?, ?, ?, ?)")
    .run("old-li-log", "old-li", "cross-a", "Message sent historical fixture");
  const email = fixture("new-email", "cross-a", "philipp", "email");
  const unrelated = fixture("unrelated-email", "cross-b", "philipp", "email");
  recordInboxSyncSuccess(db, { accountId: "mail", channel: "email", completedAt: new Date().toISOString() });
  recordInboxSyncSuccess(db, { accountId: "ben", channel: "linkedin", completedAt: new Date().toISOString() });
  recordInboxSyncFailure(db, { accountId: "ben", channel: "linkedin", error: "incomplete historical inbox" });
  let providerCalls = 0;
  const blocked = await send(email, "cross-a", "mail", "email", async beforeSend => {
    beforeSend(); providerCalls++; return { evidence: "unexpected" };
  });
  assert.equal(blocked, "deferred");
  assert.equal(providerCalls, 0);
  assert.match((db.prepare("SELECT error_message FROM run_profile_tracks WHERE id = 'new-email-track'").get() as { error_message: string }).error_message,
    /linkedin inbox sync_failed/);
  const control = await send(unrelated, "cross-b", "mail", "email", async beforeSend => {
    beforeSend(); providerCalls++; return { evidence: "fixture SMTP accepted" };
  });
  assert.equal(control, "sent");
  assert.equal(providerCalls, 1);
  assert.equal(getAction(db, actionKey("unrelated-email-track", "guard-step"))?.state, "confirmed");
});

test("same target's completed email run blocks LinkedIn when historical mailbox fails", async () => {
  fixture("old-email", "cross-c", "ben", "email", "completed", "completed");
  db.prepare("INSERT INTO logs (id, run_id, target_id, message) VALUES (?, ?, ?, ?)")
    .run("old-email-log", "old-email", "cross-c", "Email sent historical fixture");
  const linkedin = fixture("new-li", "cross-c", "philipp", "linkedin");
  recordInboxSyncSuccess(db, { accountId: "philipp", channel: "linkedin", completedAt: new Date().toISOString() });
  recordInboxSyncFailure(db, { accountId: "mail", channel: "email", error: "mailbox unavailable" });
  let providerCalls = 0;
  const blocked = await send(linkedin, "cross-c", "philipp", "connect", async beforeSend => {
    beforeSend(); providerCalls++; return { evidence: "unexpected" };
  });
  assert.equal(blocked, "deferred");
  assert.equal(providerCalls, 0);
  assert.match((db.prepare("SELECT error_message FROM run_profile_tracks WHERE id = 'new-li-track'").get() as { error_message: string }).error_message,
    /email inbox sync_failed/);
});

test("suppression added after first dispatch gate blocks final invitation confirmation", async () => {
  const track = fixture("late-policy", "late-policy-target", "philipp", "linkedin");
  recordInboxSyncSuccess(db, { accountId: "philipp", channel: "linkedin", completedAt: new Date().toISOString() });
  let providerCalls = 0;
  const result = await send(track, "late-policy-target", "philipp", "connect", async (beforeSend, finalEligibility) => {
    beforeSend();
    suppressTarget(db, "late-policy-target", "new_exclusion", "between-dialog-and-confirmation");
    finalEligibility();
    providerCalls++;
    return { evidence: "unexpected" };
  });
  assert.equal(result, "held");
  assert.equal(providerCalls, 0);
  assert.equal(getAction(db, actionKey("late-policy-track", "guard-step"))?.state, "unknown");
  const retry = await send(track, "late-policy-target", "philipp", "connect", async () => {
    providerCalls++;
    return { evidence: "unexpected retry" };
  });
  assert.equal(retry, "held");
  assert.equal(providerCalls, 0);
});

test("final recheck excludes current action from daily cap", async () => {
  db.prepare("INSERT INTO accounts (id, name, email, is_authenticated) VALUES (?, ?, ?, 1)")
    .run("third", "Third", "third@example.test");
  const track = fixture("cap-one", "cap-one-target", "third", "linkedin");
  recordInboxSyncSuccess(db, { accountId: "third", channel: "linkedin", completedAt: new Date().toISOString() });
  let providerCalls = 0;
  const result = await dispatchStep(db, track, { id: "guard-step" } as Parameters<typeof dispatchStep>[2],
    { id: "cap-one-target" } as Parameters<typeof dispatchStep>[3], "third", "connect", 1,
    schedule, "fixture", "https://www.linkedin.com/in/cap-one-target/", async (beforeSend, finalEligibility) => {
      beforeSend();
      finalEligibility();
      providerCalls++;
      return { evidence: "fixture accepted" };
    }, receipt => receipt.evidence);
  assert.equal(result, "sent");
  assert.equal(providerCalls, 1);
});

test("weekly limit holds attempted action and pauses only that sender's running runs", async () => {
  const first = fixture("weekly-first", "weekly-a", "ben", "linkedin");
  const queued = fixture("weekly-queued", "weekly-b", "ben", "linkedin");
  fixture("weekly-other", "weekly-c", "philipp", "linkedin");
  recordInboxSyncSuccess(db, { accountId: "ben", channel: "linkedin", completedAt: new Date().toISOString() });
  recordInboxSyncSuccess(db, { accountId: "philipp", channel: "linkedin", completedAt: new Date().toISOString() });
  let providerCalls = 0;
  const attempted = await send(first, "weekly-a", "ben", "connect", async beforeSend => {
    beforeSend(); providerCalls++; throw new WeeklyLimitError("Weekly connection limit reached");
  });
  assert.equal(attempted, "held");
  assert.equal(providerCalls, 1);
  assert.equal(getAction(db, actionKey("weekly-first-track", "guard-step"))?.state, "unknown");
  const statuses = db.prepare("SELECT id, status FROM runs WHERE id LIKE 'weekly-%' ORDER BY id").all() as Array<{ id: string; status: string }>;
  assert.deepEqual(statuses, [
    { id: "weekly-first", status: "paused" },
    { id: "weekly-other", status: "running" },
    { id: "weekly-queued", status: "paused" },
  ]);
  const later = await send(queued, "weekly-b", "ben", "connect", async beforeSend => {
    beforeSend(); providerCalls++; return { evidence: "unexpected" };
  });
  assert.equal(later, "deferred");
  assert.equal(providerCalls, 1);
});
