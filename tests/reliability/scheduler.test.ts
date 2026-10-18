import test from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { getDb } from "../../lib/db";
import { isWithinScheduleAt, nextScheduledSlotAt } from "../../lib/linkedin/runner";
import { syncAcceptedFromProvider } from "../../lib/linkedin/sync-accepted";
import { claimPoll, completePoll, stillOwnsPoll } from "../../lib/reliability/scheduler";

const sunday = { active_hours_start: 1, active_hours_end: 4, timezone: "America/Toronto", working_days: "7" };

test("schedule uses sender timezone across spring DST gap", () => {
  const from = new Date("2026-03-08T06:55:00.000Z"); // 01:55 EST
  assert.equal(nextScheduledSlotAt({ ...sunday, active_hours_start: 2 }, from), "2026-03-08T07:00:00.000Z");
  assert.equal(isWithinScheduleAt({ ...sunday, active_hours_start: 2 }, new Date("2026-03-08T07:00:00.000Z")), true);
});

test("schedule recognizes second local hour across fall DST fold", () => {
  const from = new Date("2026-11-01T05:55:00.000Z"); // 01:55 EDT
  assert.equal(nextScheduledSlotAt(sunday, from), "2026-11-01T06:00:00.000Z"); // 01:00 EST
  assert.equal(isWithinScheduleAt(sunday, new Date("2026-11-01T06:00:00.000Z")), true);
  assert.equal(isWithinScheduleAt(sunday, new Date("2026-11-01T09:00:00.000Z")), false);
});

test("expired accepted-connections poll cannot stamp relationship evidence after takeover", async () => {
  const old = getDb();
  old.prepare("INSERT INTO accounts (id, name, email, is_authenticated) VALUES ('fenced-li', 'Fenced', 'fenced-li@example.test', 1)").run();
  old.prepare("INSERT INTO targets (id, linkedin_url) VALUES ('fenced-contact', 'https://www.linkedin.com/in/fenced-contact/')").run();
  const start = new Date("2026-10-18T12:00:00.000Z");
  const takeover = new Date(start.getTime() + 600_001);
  const token = claimPoll(old, "connections", "fenced-li", start);
  assert.ok(token);
  let clock = start;
  let release!: () => void;
  const blocked = new Promise<void>(resolve => { release = resolve; });
  const first = syncAcceptedFromProvider(old, "fenced-li", {
    getDeclaredTotal: async () => { await blocked; return 1; },
    getPage: async startIndex => startIndex === 0
      ? [{ profileId: "profile-1", vanity: "fenced-contact", createdAt: start.getTime() }]
      : [],
  }, () => stillOwnsPoll(old, "connections", "fenced-li", token, clock));
  const winner = new Database(process.env.LINKI_DB_PATH!);
  try {
    clock = takeover;
    const newToken = claimPoll(winner, "connections", "fenced-li", takeover);
    assert.ok(newToken);
    assert.equal(completePoll(winner, "connections", "fenced-li", newToken, {}, takeover), true);
    release();
    await assert.rejects(first, /Connections lease lost/);
    assert.equal((winner.prepare("SELECT COUNT(*) AS count FROM account_relationships WHERE account_id = 'fenced-li'")
      .get() as { count: number }).count, 0);
    assert.equal((winner.prepare("SELECT accepted_sync_at FROM accounts WHERE id = 'fenced-li'")
      .get() as { accepted_sync_at: string | null }).accepted_sync_at, null);
    assert.equal((winner.prepare("SELECT last_error FROM scheduler_poll_state WHERE channel = 'connections' AND account_id = 'fenced-li'")
      .get() as { last_error: string | null }).last_error, null);
  } finally {
    release();
    winner.close();
  }
});
