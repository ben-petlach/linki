import test from "node:test";
import assert from "node:assert/strict";
import { isWithinScheduleAt, nextScheduledSlotAt } from "../../lib/linkedin/runner";

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
