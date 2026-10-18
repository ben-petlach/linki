import type Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import { suppressTarget } from "@/lib/reliability/suppression";

export interface ConnectedEvidence {
  accountId: string;
  targetId: string;
  connectedAt: string;
  source: string;
  profileId?: string | null;
}

export interface Relationship {
  accountId: string;
  targetId: string;
  connectedAt: string;
  source: string;
  profileId: string | null;
  verifiedAt: string;
}

export function initRelationshipSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS account_relationships (
      account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
      target_id TEXT NOT NULL REFERENCES targets(id) ON DELETE CASCADE,
      connected_at TEXT NOT NULL,
      source TEXT NOT NULL,
      profile_id TEXT,
      verified_at TEXT NOT NULL,
      PRIMARY KEY (account_id, target_id)
    );
    CREATE TABLE IF NOT EXISTS account_target_state (
      account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
      target_id TEXT NOT NULL REFERENCES targets(id) ON DELETE CASCADE,
      connection_requested_at TEXT,
      messaging_urn TEXT,
      PRIMARY KEY (account_id, target_id)
    );
    CREATE TABLE IF NOT EXISTS legacy_relationship_audit (
      target_id TEXT PRIMARY KEY,
      degree INTEGER,
      connected_at TEXT,
      connection_requested_at TEXT,
      captured_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS connection_sync_state (
      account_id TEXT PRIMARY KEY,
      last_failure_at TEXT,
      last_error TEXT
    );
  `);
  // Old target fields have no sender identity. Preserve them for audit only.
  const targets = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'targets'").get();
  if (targets) {
    db.prepare(`
      INSERT OR IGNORE INTO legacy_relationship_audit
        (target_id, degree, connected_at, connection_requested_at, captured_at)
      SELECT id, degree, connected_at, connection_requested_at, datetime('now')
      FROM targets
      WHERE degree IS NOT NULL OR connected_at IS NOT NULL OR connection_requested_at IS NOT NULL
    `).run();
  }
}

export function recordConnectedEvidence(db: Database.Database, evidence: ConnectedEvidence): void {
  if (!evidence.accountId || !evidence.targetId || !evidence.connectedAt || !evidence.source) {
    throw new Error("Complete account-scoped connection evidence required");
  }
  db.prepare(`
    INSERT INTO account_relationships
      (account_id, target_id, connected_at, source, profile_id, verified_at)
    VALUES (?, ?, ?, ?, ?, datetime('now'))
    ON CONFLICT(account_id, target_id) DO UPDATE SET
      connected_at = excluded.connected_at,
      source = excluded.source,
      profile_id = COALESCE(excluded.profile_id, account_relationships.profile_id),
      verified_at = excluded.verified_at
  `).run(evidence.accountId, evidence.targetId, evidence.connectedAt,
    evidence.source, evidence.profileId ?? null);
}

export function getRelationship(
  db: Database.Database, accountId: string, targetId: string
): Relationship | null {
  const row = db.prepare(`
    SELECT account_id AS accountId, target_id AS targetId, connected_at AS connectedAt,
      source, profile_id AS profileId, verified_at AS verifiedAt
    FROM account_relationships WHERE account_id = ? AND target_id = ?
  `).get(accountId, targetId) as Relationship | undefined;
  return row ?? null;
}

export function isConnectedForAccount(
  db: Database.Database, accountId: string, targetId: string
): boolean {
  return getRelationship(db, accountId, targetId) !== null;
}

export function clearConnectedEvidence(
  db: Database.Database, accountId: string, targetId: string
): void {
  db.prepare("DELETE FROM account_relationships WHERE account_id = ? AND target_id = ?")
    .run(accountId, targetId);
}

export function recordConnectionRequested(
  db: Database.Database,
  input: { accountId: string; targetId: string; requestedAt: string }
): void {
  db.prepare(`INSERT INTO account_target_state (account_id, target_id, connection_requested_at)
    VALUES (?, ?, ?) ON CONFLICT(account_id, target_id) DO UPDATE SET
    connection_requested_at = COALESCE(account_target_state.connection_requested_at,
      excluded.connection_requested_at)`).run(input.accountId, input.targetId, input.requestedAt);
}

export function getConnectionRequestedAt(
  db: Database.Database, accountId: string, targetId: string
): string | null {
  const row = db.prepare(`SELECT connection_requested_at AS requestedAt
    FROM account_target_state WHERE account_id = ? AND target_id = ?`).get(accountId, targetId) as
    { requestedAt: string | null } | undefined;
  return row?.requestedAt ?? null;
}

export function recordMessagingIdentity(
  db: Database.Database,
  input: { accountId: string; targetId: string; messagingUrn: string }
): void {
  db.prepare(`INSERT INTO account_target_state (account_id, target_id, messaging_urn)
    VALUES (?, ?, ?) ON CONFLICT(account_id, target_id) DO UPDATE SET
    messaging_urn = excluded.messaging_urn`).run(input.accountId, input.targetId, input.messagingUrn);
}

export function getMessagingIdentity(
  db: Database.Database, accountId: string, targetId: string
): string | null {
  const row = db.prepare(`SELECT messaging_urn AS messagingUrn
    FROM account_target_state WHERE account_id = ? AND target_id = ?`).get(accountId, targetId) as
    { messagingUrn: string | null } | undefined;
  return row?.messagingUrn ?? null;
}

/** One-time hold for runs whose pre-upgrade sends cannot be attributed safely. */
export function initLegacyOutreachReview(db: Database.Database): number {
  db.exec(`
    CREATE TABLE IF NOT EXISTS reliability_migrations (
      name TEXT PRIMARY KEY,
      completed_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS legacy_outreach_review (
      run_id TEXT PRIMARY KEY REFERENCES runs(id) ON DELETE CASCADE,
      prior_status TEXT NOT NULL,
      reason TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
  const hasTracks = !!db.prepare(`SELECT 1 FROM sqlite_master
    WHERE type = 'table' AND name = 'run_profile_tracks'`).get();
  const trackCriterion = hasTracks ? `OR EXISTS (
    SELECT 1 FROM run_profile_tracks rpt WHERE rpt.run_profile_id = rp.id
      AND (rpt.current_step > 0 OR rpt.last_step_at IS NOT NULL
        OR rpt.state IN ('in_progress', 'completed'))
  )` : "";
  const trackSelect = hasTracks ? `,
    (SELECT id FROM run_profile_tracks WHERE run_profile_id = rp.id ORDER BY id LIMIT 1) AS trackId`
    : ", NULL AS trackId";
  const runProfileColumns = db.prepare("PRAGMA table_info(run_profiles)").all() as Array<{ name: string }>;
  const legacyStepCriterion = runProfileColumns.some((column) => column.name === "current_step")
    ? "OR rp.current_step > 0 OR rp.last_step_at IS NOT NULL" : "";
  const reason = "Legacy outreach may have occurred before sender-scoped send records; review before resuming";
  return db.transaction(() => {
    if (db.prepare(`SELECT 1 FROM reliability_migrations
      WHERE name = 'legacy_outreach_review_v1'`).get()) return 0;
    const participants = db.prepare(`
      SELECT r.id AS runId, r.status, rp.id AS profileId, rp.target_id AS targetId
        ${trackSelect}
      FROM runs r JOIN run_profiles rp ON rp.run_id = r.id
      JOIN targets t ON t.id = rp.target_id
      WHERE r.status IN ('running', 'paused') AND (
        r.started_at IS NOT NULL
        OR t.message_sent_at IS NOT NULL OR t.connection_requested_at IS NOT NULL
        OR t.email_replied_at IS NOT NULL OR t.email_status = 'sent'
        OR EXISTS (SELECT 1 FROM logs l WHERE l.run_id = r.id
          AND l.target_id = rp.target_id AND l.message LIKE 'Email sent%')
        ${legacyStepCriterion} ${trackCriterion}
      )
    `).all() as Array<{ runId: string; status: string; profileId: string; targetId: string; trackId: string | null }>;
    const pause = db.prepare("UPDATE runs SET status = 'paused' WHERE id = ?");
    const review = db.prepare(`INSERT INTO legacy_outreach_review
      (run_id, prior_status, reason) VALUES (?, ?, ?)`);
    const log = db.prepare(`INSERT INTO logs (id, run_id, level, message)
      VALUES (?, ?, 'warn', ?)`);
    const reviewedRuns = new Set<string>();
    for (const participant of participants) {
      suppressTarget(db, participant.targetId, "legacy_outreach_review",
        `run:${participant.runId};profile:${participant.profileId}` +
          (participant.trackId ? `;track:${participant.trackId}` : ""));
      if (reviewedRuns.has(participant.runId)) continue;
      reviewedRuns.add(participant.runId);
      pause.run(participant.runId);
      review.run(participant.runId, participant.status, reason);
      log.run(randomUUID(), participant.runId, reason);
    }
    db.prepare(`INSERT INTO reliability_migrations (name, completed_at)
      VALUES ('legacy_outreach_review_v1', datetime('now'))`).run();
    return reviewedRuns.size;
  })();
}
