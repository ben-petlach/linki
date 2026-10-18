import { randomUUID } from "crypto";
import type Database from "better-sqlite3";
import type { InboxChannel } from "./inbox-state";

export type PollChannel = InboxChannel | "connections";

export function initSchedulerSchema(db: Database.Database): void {
  db.exec(`CREATE TABLE IF NOT EXISTS scheduler_poll_state (
    channel TEXT NOT NULL CHECK(channel IN ('linkedin', 'email', 'connections')),
    account_id TEXT NOT NULL,
    token TEXT,
    lease_until TEXT,
    next_attempt_at TEXT,
    consecutive_failures INTEGER NOT NULL DEFAULT 0,
    last_success_at TEXT,
    last_error TEXT,
    PRIMARY KEY (channel, account_id)
  )`);
}

export function claimPoll(db: Database.Database, channel: PollChannel, accountId: string, now = new Date()): string | null {
  const at = now.toISOString();
  const leaseUntil = new Date(now.getTime() + 10 * 60_000).toISOString();
  const token = randomUUID();
  return db.transaction(() => {
    db.prepare(`INSERT OR IGNORE INTO scheduler_poll_state (channel, account_id) VALUES (?, ?)`).run(channel, accountId);
    const changed = db.prepare(`UPDATE scheduler_poll_state SET token = ?, lease_until = ?
      WHERE channel = ? AND account_id = ?
        AND (token IS NULL OR lease_until <= ?)
        AND (next_attempt_at IS NULL OR next_attempt_at <= ?)`).run(token, leaseUntil, channel, accountId, at, at);
    return changed.changes ? token : null;
  }).immediate();
}

export function completePoll(
  db: Database.Database, channel: PollChannel, accountId: string, token: string,
  result: { error?: string }, now = new Date()
): boolean {
  return db.transaction(() => {
    const row = db.prepare(`SELECT consecutive_failures FROM scheduler_poll_state
      WHERE channel = ? AND account_id = ? AND token = ?`).get(channel, accountId, token) as { consecutive_failures: number } | undefined;
    if (!row) return false;
    const failures = result.error ? row.consecutive_failures + 1 : 0;
    const base = channel === "linkedin" ? 15 * 60_000 : channel === "connections" ? 23 * 60 * 60_000 : 2 * 60_000;
    const wait = result.error ? Math.min(base * 2 ** Math.min(failures - 1, 4), 60 * 60_000) : base;
    const updated = db.prepare(`UPDATE scheduler_poll_state SET token = NULL, lease_until = NULL,
      next_attempt_at = ?, consecutive_failures = ?, last_success_at = CASE WHEN ? IS NULL THEN ? ELSE last_success_at END,
      last_error = ? WHERE channel = ? AND account_id = ? AND token = ?`).run(
      new Date(now.getTime() + wait).toISOString(), failures, result.error ?? null,
      now.toISOString(), result.error ?? null, channel, accountId, token);
    return updated.changes === 1;
  }).immediate();
}
