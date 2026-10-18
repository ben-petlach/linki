import type Database from "better-sqlite3";

export type InboxChannel = "linkedin" | "email";

export interface InboxFreshness {
  fresh: boolean;
  reason: string | null;
  lastSuccessfulAt: string | null;
  lastFailureAt: string | null;
}

export function initInboxStateSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS inbox_sync_state (
      account_id TEXT NOT NULL,
      channel TEXT NOT NULL CHECK(channel IN ('linkedin', 'email')),
      last_successful_at TEXT,
      last_failure_at TEXT,
      last_failure TEXT,
      PRIMARY KEY (account_id, channel)
    );
  `);
}

export function recordInboxSyncSuccess(
  db: Database.Database,
  input: { accountId: string; channel: InboxChannel; completedAt?: string }
): void {
  const completedAt = input.completedAt ?? new Date().toISOString();
  db.prepare(`
    INSERT INTO inbox_sync_state (account_id, channel, last_successful_at, last_failure_at, last_failure)
    VALUES (?, ?, ?, NULL, NULL)
    ON CONFLICT(account_id, channel) DO UPDATE SET
      last_successful_at = excluded.last_successful_at,
      last_failure_at = NULL,
      last_failure = NULL
  `).run(input.accountId, input.channel, completedAt);
}

export function recordInboxSyncFailure(
  db: Database.Database,
  input: { accountId: string; channel: InboxChannel; error: string; failedAt?: string }
): void {
  const failedAt = input.failedAt ?? new Date().toISOString();
  db.prepare(`
    INSERT INTO inbox_sync_state (account_id, channel, last_failure_at, last_failure)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(account_id, channel) DO UPDATE SET
      last_failure_at = excluded.last_failure_at,
      last_failure = excluded.last_failure
  `).run(input.accountId, input.channel, failedAt, input.error);
}

export function getInboxFreshness(
  db: Database.Database,
  input: { accountId: string; channel: InboxChannel; maxAgeMs: number; now?: Date }
): InboxFreshness {
  const row = db.prepare(`
    SELECT last_successful_at AS lastSuccessfulAt, last_failure_at AS lastFailureAt
    FROM inbox_sync_state WHERE account_id = ? AND channel = ?
  `).get(input.accountId, input.channel) as {
    lastSuccessfulAt: string | null; lastFailureAt: string | null
  } | undefined;
  const lastSuccessfulAt = row?.lastSuccessfulAt ?? null;
  const lastFailureAt = row?.lastFailureAt ?? null;
  const reason = !lastSuccessfulAt ? "never_synced"
    : lastFailureAt ? "sync_failed"
    : !Number.isFinite(Date.parse(lastSuccessfulAt)) ? "invalid_sync_time"
    : (input.now ?? new Date()).getTime() - Date.parse(lastSuccessfulAt) > input.maxAgeMs ? "stale"
    : null;
  return { fresh: reason === null, reason, lastSuccessfulAt, lastFailureAt };
}
