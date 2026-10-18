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
      last_success_started_at TEXT,
      last_failure_at TEXT,
      last_failure_started_at TEXT,
      last_failure TEXT,
      PRIMARY KEY (account_id, channel)
    );
  `);
  const columns = db.prepare("PRAGMA table_info(inbox_sync_state)").all() as Array<{ name: string }>;
  for (const name of ["last_success_started_at", "last_failure_started_at"]) {
    if (!columns.some((column) => column.name === name)) {
      db.exec(`ALTER TABLE inbox_sync_state ADD COLUMN ${name} TEXT`);
    }
  }
}

export function recordInboxSyncSuccess(
  db: Database.Database,
  input: { accountId: string; channel: InboxChannel; startedAt?: string; completedAt?: string }
): void {
  const completedAt = input.completedAt ?? new Date().toISOString();
  const startedAt = input.startedAt ?? completedAt;
  db.prepare(`
    INSERT INTO inbox_sync_state (account_id, channel, last_successful_at,
      last_success_started_at, last_failure_at, last_failure_started_at, last_failure)
    VALUES (?, ?, ?, ?, NULL, NULL, NULL)
    ON CONFLICT(account_id, channel) DO UPDATE SET
      last_successful_at = CASE WHEN inbox_sync_state.last_success_started_at IS NULL
        OR excluded.last_success_started_at >= inbox_sync_state.last_success_started_at
        THEN excluded.last_successful_at ELSE inbox_sync_state.last_successful_at END,
      last_success_started_at = CASE WHEN inbox_sync_state.last_success_started_at IS NULL
        OR excluded.last_success_started_at >= inbox_sync_state.last_success_started_at
        THEN excluded.last_success_started_at ELSE inbox_sync_state.last_success_started_at END,
      last_failure_at = CASE WHEN inbox_sync_state.last_failure_started_at IS NULL
        OR excluded.last_success_started_at > inbox_sync_state.last_failure_started_at
        THEN NULL ELSE inbox_sync_state.last_failure_at END,
      last_failure_started_at = CASE WHEN inbox_sync_state.last_failure_started_at IS NULL
        OR excluded.last_success_started_at > inbox_sync_state.last_failure_started_at
        THEN NULL ELSE inbox_sync_state.last_failure_started_at END,
      last_failure = CASE WHEN inbox_sync_state.last_failure_started_at IS NULL
        OR excluded.last_success_started_at > inbox_sync_state.last_failure_started_at
        THEN NULL ELSE inbox_sync_state.last_failure END
  `).run(input.accountId, input.channel, completedAt, startedAt);
}

export function recordInboxSyncFailure(
  db: Database.Database,
  input: { accountId: string; channel: InboxChannel; error: string; startedAt?: string; failedAt?: string }
): void {
  const failedAt = input.failedAt ?? new Date().toISOString();
  const startedAt = input.startedAt ?? failedAt;
  db.prepare(`
    INSERT INTO inbox_sync_state (account_id, channel, last_failure_at, last_failure_started_at, last_failure)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(account_id, channel) DO UPDATE SET
      last_failure_at = CASE WHEN (inbox_sync_state.last_success_started_at IS NULL
        OR excluded.last_failure_started_at >= inbox_sync_state.last_success_started_at)
        AND (inbox_sync_state.last_failure_started_at IS NULL
          OR excluded.last_failure_started_at >= inbox_sync_state.last_failure_started_at)
        THEN excluded.last_failure_at ELSE inbox_sync_state.last_failure_at END,
      last_failure_started_at = CASE WHEN (inbox_sync_state.last_success_started_at IS NULL
        OR excluded.last_failure_started_at >= inbox_sync_state.last_success_started_at)
        AND (inbox_sync_state.last_failure_started_at IS NULL
          OR excluded.last_failure_started_at >= inbox_sync_state.last_failure_started_at)
        THEN excluded.last_failure_started_at ELSE inbox_sync_state.last_failure_started_at END,
      last_failure = CASE WHEN (inbox_sync_state.last_success_started_at IS NULL
        OR excluded.last_failure_started_at >= inbox_sync_state.last_success_started_at)
        AND (inbox_sync_state.last_failure_started_at IS NULL
          OR excluded.last_failure_started_at >= inbox_sync_state.last_failure_started_at)
        THEN excluded.last_failure ELSE inbox_sync_state.last_failure END
  `).run(input.accountId, input.channel, failedAt, startedAt, input.error);
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
    : Date.parse(lastSuccessfulAt) > (input.now ?? new Date()).getTime() + 60_000 ? "future_sync_time"
    : (input.now ?? new Date()).getTime() - Date.parse(lastSuccessfulAt) > input.maxAgeMs ? "stale"
    : null;
  return { fresh: reason === null, reason, lastSuccessfulAt, lastFailureAt };
}
