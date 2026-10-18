import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import Database from "better-sqlite3";
import { claimPoll, completePoll, initSchedulerSchema } from "../../lib/reliability/scheduler";

test("poll lease has one owner across SQLite connections and fences stale completion", () => {
  const directory = mkdtempSync(join(tmpdir(), "linki-poll-lease-"));
  const path = join(directory, "poll.sqlite");
  const first = new Database(path);
  const second = new Database(path);
  try {
    initSchedulerSchema(first);
    const start = new Date("2026-10-18T12:00:00.000Z");
    const oldToken = claimPoll(first, "email", "mail-1", start);
    assert.ok(oldToken);
    assert.equal(claimPoll(second, "email", "mail-1", start), null);
    assert.equal(claimPoll(second, "email", "mail-1", new Date(start.getTime() + 599_999)), null);

    const newToken = claimPoll(second, "email", "mail-1", new Date(start.getTime() + 600_001));
    assert.ok(newToken);
    assert.notEqual(newToken, oldToken);
    assert.equal(completePoll(first, "email", "mail-1", oldToken, {}, new Date(start.getTime() + 600_002)), false);
    assert.equal(completePoll(second, "email", "mail-1", newToken, {}, new Date(start.getTime() + 600_003)), true);

    const row = first.prepare(`SELECT token, consecutive_failures, last_success_at FROM scheduler_poll_state
      WHERE channel = 'email' AND account_id = 'mail-1'`).get() as {
      token: string | null; consecutive_failures: number; last_success_at: string | null;
    };
    assert.equal(row.token, null);
    assert.equal(row.consecutive_failures, 0);
    assert.equal(row.last_success_at, new Date(start.getTime() + 600_003).toISOString());
  } finally {
    first.close(); second.close(); rmSync(directory, { recursive: true, force: true });
  }
});

test("poll failure, backoff and retry survive process restart", () => {
  const directory = mkdtempSync(join(tmpdir(), "linki-poll-restart-"));
  const path = join(directory, "poll.sqlite");
  const start = new Date("2026-10-18T12:00:00.000Z");
  const first = new Database(path);
  initSchedulerSchema(first);
  const token = claimPoll(first, "email", "mail-1", start);
  assert.ok(token);
  assert.equal(completePoll(first, "email", "mail-1", token, { error: "local IMAP fixture disconnected" }, start), true);
  first.close();
  const second = new Database(path);
  try {
    assert.equal(claimPoll(second, "email", "mail-1", new Date(start.getTime() + 119_999)), null);
    const retry = claimPoll(second, "email", "mail-1", new Date(start.getTime() + 120_000));
    assert.ok(retry);
    assert.equal(completePoll(second, "email", "mail-1", retry,
      { error: "local IMAP fixture disconnected" }, new Date(start.getTime() + 120_000)), true);
    const state = second.prepare(`SELECT consecutive_failures, next_attempt_at, last_error
      FROM scheduler_poll_state WHERE channel = 'email' AND account_id = 'mail-1'`).get() as {
      consecutive_failures: number; next_attempt_at: string; last_error: string;
    };
    assert.equal(state.consecutive_failures, 2);
    assert.equal(state.next_attempt_at, new Date(start.getTime() + 360_000).toISOString());
    assert.equal(state.last_error, "local IMAP fixture disconnected");
    assert.equal(claimPoll(second, "email", "mail-1", new Date(start.getTime() + 359_999)), null);
  } finally {
    second.close(); rmSync(directory, { recursive: true, force: true });
  }
});
