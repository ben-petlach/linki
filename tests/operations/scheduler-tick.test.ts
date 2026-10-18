import assert from "node:assert/strict";
import test from "node:test";
import Database from "better-sqlite3";
import { getDb } from "../../lib/db";
import { markOutboundAccepted, processInboundEmail, registerOutboundEmail } from "../../lib/email/inbox";
import { isWithinScheduleAt, nextScheduledSlotAt, tick } from "../../lib/linkedin/runner";
import { recordInboxSyncSuccess } from "../../lib/reliability/inbox-state";
import { setGlobalDispatchPause } from "../../lib/reliability/operations";
import { initSchedulerSchema } from "../../lib/reliability/scheduler";
import { evaluateEligibility } from "../../lib/reliability/suppression";

const db = getDb();
initSchedulerSchema(db);
const now = new Date("2026-10-18T12:00:00.000Z");

function emailAccount(id: string): void {
  db.prepare(`INSERT INTO email_accounts
    (id, name, from_email, smtp_host, imap_host, username, password, is_verified)
    VALUES (?, ?, ?, 'localhost', 'localhost', ?, 'fixture', 1)`)
    .run(id, id, `${id}@example.test`, id);
}

function historicalRun(id: string, status: "completed" | "paused", accountId: string, emailId: string, targetId: string): void {
  db.prepare("INSERT INTO accounts (id, name, email, is_authenticated) VALUES (?, ?, ?, 0)")
    .run(accountId, accountId, `${accountId}@example.test`);
  db.prepare("INSERT INTO workflows (id, name) VALUES (?, ?)").run(`${id}-workflow`, id);
  db.prepare("INSERT INTO runs (id, workflow_id, account_id, email_account_id, status) VALUES (?, ?, ?, ?, ?)")
    .run(id, `${id}-workflow`, accountId, emailId, status);
  db.prepare("INSERT INTO run_profiles (id, run_id, target_id, email_account_id) VALUES (?, ?, ?, ?)")
    .run(`${id}-profile`, id, targetId, emailId);
}

test("production tick polls email-only completed and paused senders, records late reply, and isolates failed account", async () => {
  db.prepare("INSERT INTO targets (id, email) VALUES ('late-target', 'late@example.test')").run();
  emailAccount("completed-mail");
  emailAccount("paused-mail");
  emailAccount("broken-mail");
  historicalRun("completed-run", "completed", "completed-linkedin", "completed-mail", "late-target");
  historicalRun("paused-run", "paused", "paused-linkedin", "paused-mail", "late-target");
  registerOutboundEmail(db, { actionKey: "late-outbound", targetId: "late-target", emailAccountId: "completed-mail",
    recipient: "late@example.test", messageId: "<late-outbound@example.test>", subject: "Fixture" });
  markOutboundAccepted(db, "late-outbound", now.toISOString());
  const calls: string[] = [];
  const rawReply = [
    "From: Late Contact <late@example.test>",
    "To: Completed <completed-mail@example.test>",
    "Message-ID: <late-reply@example.test>",
    "In-Reply-To: <late-outbound@example.test>",
    "Date: Sun, 18 Oct 2026 12:00:00 +0000",
    "Subject: Re: Fixture",
    "Content-Type: text/plain; charset=utf-8", "", "Please stop."
  ].join("\r\n");
  await tick(db, {
    now: () => now,
    syncEmailInbox: async (accountId, connection) => {
      calls.push(accountId);
      if (accountId === "broken-mail") throw new Error("synthetic IMAP disconnect");
      if (accountId === "completed-mail") assert.equal(await processInboundEmail(connection, accountId, rawReply), "reply");
      recordInboxSyncSuccess(connection, { accountId, channel: "email", completedAt: now.toISOString() });
      return { replies: accountId === "completed-mail" ? 1 : 0, bounces: 0 };
    },
  });
  assert.deepEqual(calls.sort(), ["broken-mail", "completed-mail", "paused-mail"]);
  assert.equal((db.prepare("SELECT COUNT(*) AS count FROM email_replies WHERE target_id = 'late-target'")
    .get() as { count: number }).count, 1);
  assert.equal(evaluateEligibility(db, "late-target", { channel: "email" }).allowed, false);
  const states = db.prepare(`SELECT account_id, last_success_at, last_error, consecutive_failures
    FROM scheduler_poll_state WHERE channel = 'email' ORDER BY account_id`).all() as Array<{
    account_id: string; last_success_at: string | null; last_error: string | null; consecutive_failures: number;
  }>;
  assert.equal(states.find(x => x.account_id === "completed-mail")?.last_success_at, now.toISOString());
  assert.equal(states.find(x => x.account_id === "paused-mail")?.last_success_at, now.toISOString());
  assert.equal(states.find(x => x.account_id === "broken-mail")?.last_success_at, null);
  assert.equal(states.find(x => x.account_id === "broken-mail")?.last_error, "synthetic IMAP disconnect");

  const restarted = new Database(process.env.LINKI_DB_PATH!);
  try {
    assert.equal((restarted.prepare("SELECT COUNT(*) AS count FROM email_replies WHERE target_id = 'late-target'").get() as { count: number }).count, 1);
    assert.equal((restarted.prepare("SELECT consecutive_failures FROM scheduler_poll_state WHERE channel = 'email' AND account_id = 'broken-mail'").get() as { consecutive_failures: number }).consecutive_failures, 1);
  } finally { restarted.close(); }
});

test("two production ticks race one due mailbox poll and next interval is durable", async () => {
  emailAccount("race-mail");
  const second = new Database(process.env.LINKI_DB_PATH!);
  second.pragma("foreign_keys = ON");
  let polls = 0;
  let release!: () => void;
  const blocked = new Promise<void>(resolve => { release = resolve; });
  const options = {
    now: () => now,
    syncEmailInbox: async (accountId: string, connection: Database.Database) => {
      if (accountId === "race-mail") { polls++; await blocked; }
      recordInboxSyncSuccess(connection, { accountId, channel: "email" as const, completedAt: now.toISOString() });
      return { replies: 0, bounces: 0 };
    },
  };
  try {
    const firstTick = tick(db, options);
    await tick(second, options);
    assert.equal(polls, 1);
    release();
    await firstTick;
    await tick(second, options);
    assert.equal(polls, 1);
    const state = second.prepare("SELECT next_attempt_at FROM scheduler_poll_state WHERE channel = 'email' AND account_id = 'race-mail'")
      .get() as { next_attempt_at: string };
    assert.equal(state.next_attempt_at, new Date(now.getTime() + 120_000).toISOString());
  } finally {
    release();
    second.close();
  }
});

test("failed mailbox retries at durable boundary; global pause leaves inbox poll active", async () => {
  emailAccount("healthy-during-pause");
  setGlobalDispatchPause(db, { paused: true, actorId: "fixture", reason: "controlled pause" });
  const retryAt = new Date(now.getTime() + 120_000);
  const called: string[] = [];
  try {
    await tick(db, { now: () => retryAt, syncEmailInbox: async (accountId, connection) => {
      called.push(accountId);
      recordInboxSyncSuccess(connection, { accountId, channel: "email", completedAt: retryAt.toISOString() });
      return { replies: 0, bounces: 0 };
    } });
    assert.ok(called.includes("broken-mail"), "previous failure must retry at +2 minutes");
    assert.ok(called.includes("healthy-during-pause"), "global pause must not stop inbound polling");
    assert.equal((db.prepare(`SELECT consecutive_failures FROM scheduler_poll_state
      WHERE channel = 'email' AND account_id = 'broken-mail'`).get() as { consecutive_failures: number }).consecutive_failures, 0);
  } finally {
    setGlobalDispatchPause(db, { paused: false, actorId: "fixture", reason: "fixture complete" });
  }
});

test("production tick bounds a hung mailbox and completes healthy mailbox", async () => {
  emailAccount("aa-hung-mail");
  emailAccount("ab-healthy-after-hung");
  const at = new Date(now.getTime() + 240_000);
  const began = Date.now();
  await tick(db, { now: () => at, pollTimeoutMs: 20,
    syncEmailInbox: async (accountId, connection) => {
      if (accountId === "aa-hung-mail") return new Promise(() => {});
      recordInboxSyncSuccess(connection, { accountId, channel: "email", completedAt: at.toISOString() });
      return { replies: 0, bounces: 0 };
    },
  });
  assert.ok(Date.now() - began < 2_000, "hung provider must not trap scheduler tick");
  assert.equal((db.prepare(`SELECT last_success_at FROM scheduler_poll_state
    WHERE channel = 'email' AND account_id = 'ab-healthy-after-hung'`).get() as { last_success_at: string }).last_success_at, at.toISOString());
  const hung = db.prepare(`SELECT token, last_success_at FROM scheduler_poll_state
    WHERE channel = 'email' AND account_id = 'aa-hung-mail'`).get() as { token: string | null; last_success_at: string | null };
  assert.ok(hung.token, "hung poll keeps lease until timeout or eventual completion");
  assert.equal(hung.last_success_at, null);
});

test("email-only running run reaches production tick execution without LinkedIn authentication", async () => {
  db.prepare("INSERT INTO targets (id, email) VALUES ('email-only-target', 'email-only@example.test')").run();
  emailAccount("email-only-mail");
  db.prepare("INSERT INTO accounts (id, name, email, is_authenticated) VALUES ('email-only-li', 'Email Only', 'email-only-li@example.test', 0)").run();
  db.prepare("INSERT INTO workflows (id, name) VALUES ('email-only-workflow', 'Email Only')").run();
  db.prepare(`INSERT INTO workflow_steps (id, workflow_id, step_order, step_type, track, email_subject, email_body)
    VALUES ('email-only-step', 'email-only-workflow', 1, 'email', 'email', 'Fixture', 'Synthetic')`).run();
  db.prepare(`INSERT INTO runs (id, workflow_id, account_id, email_account_id, status)
    VALUES ('email-only-run', 'email-only-workflow', 'email-only-li', 'email-only-mail', 'running')`).run();
  db.prepare(`INSERT INTO run_profiles (id, run_id, target_id, email_account_id)
    VALUES ('email-only-profile', 'email-only-run', 'email-only-target', 'email-only-mail')`).run();
  db.prepare(`INSERT INTO run_profile_tracks (id, run_profile_id, track, state, current_step)
    VALUES ('email-only-track', 'email-only-profile', 'email', 'in_progress', 0)`).run();
  const at = new Date(now.getTime() + 360_000);
  const executed: string[] = [];
  await tick(db, { now: () => at,
    syncEmailInbox: async (accountId, connection) => {
      recordInboxSyncSuccess(connection, { accountId, channel: "email", completedAt: at.toISOString() });
      return { replies: 0, bounces: 0 };
    },
    executeStep: async (_connection, _runId, track) => { executed.push(track.id); },
    sleep: async () => undefined,
    pollTimeoutMs: 20,
  });
  assert.deepEqual(executed, ["email-only-track"]);
});

test("timezone schedule handles skipped spring hour and repeated fall hour", () => {
  const spring = { active_hours_start: 2, active_hours_end: 3, timezone: "America/Toronto", working_days: "7" };
  assert.equal(isWithinScheduleAt(spring, new Date("2026-03-08T06:59:00.000Z")), false);
  assert.equal(isWithinScheduleAt(spring, new Date("2026-03-08T07:00:00.000Z")), false);
  assert.equal(nextScheduledSlotAt(spring, new Date("2026-03-08T06:50:00.000Z")), "2026-03-15T06:00:00.000Z");
  const fall = { active_hours_start: 1, active_hours_end: 2, timezone: "America/Toronto", working_days: "7" };
  assert.equal(isWithinScheduleAt(fall, new Date("2026-11-01T05:15:00.000Z")), true);
  assert.equal(isWithinScheduleAt(fall, new Date("2026-11-01T06:15:00.000Z")), true);
  assert.equal(nextScheduledSlotAt(fall, new Date("2026-11-01T05:55:00.000Z")), "2026-11-01T06:00:00.000Z");
});
