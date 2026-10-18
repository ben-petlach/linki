import test from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { actionKey, beginDispatch, claimAction, confirmAction, getAction, holdUnknown, initActionSchema, releaseClaim } from "../../lib/reliability/actions";

test("stable action key and expired pre-dispatch claim recover with new fencing token", () => {
  const db = new Database(":memory:");
  initActionSchema(db);
  const key = actionKey("track", "step");
  assert.equal(key, actionKey("track", "step"));
  const first = claimAction(db, { key, senderId: "sender", targetId: "target", channel: "email", now: 100, leaseMs: 10 });
  assert.equal(first.claimed, true);
  const blocked = claimAction(db, { key, senderId: "sender", targetId: "target", channel: "email", now: 105 });
  assert.deepEqual(blocked, { claimed: false, state: "claimed", reason: "another worker owns action" });
  const second = claimAction(db, { key, senderId: "sender", targetId: "target", channel: "email", now: 111 });
  assert.equal(second.claimed, true);
  if (!first.claimed || !second.claimed) throw new Error("claim failed");
  assert.notEqual(first.token, second.token);
  assert.deepEqual(beginDispatch(db, key, first.token, () => null, 112), { started: false, reason: "claim lost or expired" });
  assert.deepEqual(beginDispatch(db, key, second.token, () => null, 112), { started: true });
  assert.equal(getAction(db, key)?.state, "sending");
  assert.ok(getAction(db, key)?.dispatched_at);
  db.close();
});

test("gate refusal leaves action retryable; dispatched action never becomes retryable", () => {
  const db = new Database(":memory:");
  const key = actionKey("track", "step");
  const first = claimAction(db, { key, senderId: "sender", targetId: "target", channel: "email", now: 100 });
  if (!first.claimed) throw new Error("claim failed");
  assert.deepEqual(beginDispatch(db, key, first.token, () => "suppressed", 101), { started: false, reason: "suppressed" });
  assert.equal(releaseClaim(db, key, first.token), true);
  const second = claimAction(db, { key, senderId: "sender", targetId: "target", channel: "email", now: 200 });
  if (!second.claimed) throw new Error("claim failed");
  assert.equal(beginDispatch(db, key, second.token, () => null, 201).started, true);
  assert.deepEqual(claimAction(db, { key, senderId: "sender", targetId: "target", channel: "email", now: 999_999 }), {
    claimed: false, state: "sending", reason: "dispatch began; outcome unknown until reconciled",
  });
  assert.equal(releaseClaim(db, key, second.token), false);
  assert.equal(holdUnknown(db, key, second.token, "provider timeout after acceptance"), true);
  assert.deepEqual(claimAction(db, { key, senderId: "sender", targetId: "target", channel: "email", now: 999_999 }), {
    claimed: false, state: "unknown", reason: "provider timeout after acceptance",
  });
  db.close();
});

test("confirmed action cannot resend; stale worker cannot confirm", () => {
  const db = new Database(":memory:");
  const key = "a";
  const first = claimAction(db, { key, senderId: "sender", targetId: "target", channel: "email", now: 100, leaseMs: 10 });
  const second = claimAction(db, { key, senderId: "sender", targetId: "target", channel: "email", now: 111 });
  if (!first.claimed || !second.claimed) throw new Error("claim failed");
  assert.equal(beginDispatch(db, key, first.token, () => null, 112).started, false);
  assert.equal(confirmAction(db, key, first.token, "smtp-id"), false);
  assert.equal(beginDispatch(db, key, second.token, () => null, 112).started, true);
  assert.equal(confirmAction(db, key, second.token, "smtp-id"), true);
  assert.equal(getAction(db, key)?.evidence, "smtp-id");
  assert.deepEqual(claimAction(db, { key, senderId: "sender", targetId: "target", channel: "email", now: 999_999 }), {
    claimed: false, state: "confirmed", reason: "action already confirmed",
  });
  db.close();
});

test("two SQLite connections to same file cannot both claim", async () => {
  const { mkdtempSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const dir = mkdtempSync(join(tmpdir(), "linki-actions-"));
  const path = join(dir, "test.sqlite");
  const left = new Database(path);
  const right = new Database(path);
  try {
    const input = { key: "same", senderId: "sender", targetId: "target", channel: "linkedin", now: 100 };
    const outcomes = [claimAction(left, input), claimAction(right, input)];
    assert.equal(outcomes.filter(x => x.claimed).length, 1);
  } finally {
    left.close(); right.close(); rmSync(dir, { recursive: true, force: true });
  }
});
