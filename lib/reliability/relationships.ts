import type Database from "better-sqlite3";

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
      account_id TEXT NOT NULL,
      target_id TEXT NOT NULL,
      connected_at TEXT NOT NULL,
      source TEXT NOT NULL,
      profile_id TEXT,
      verified_at TEXT NOT NULL,
      PRIMARY KEY (account_id, target_id)
    );
    CREATE TABLE IF NOT EXISTS legacy_relationship_audit (
      target_id TEXT PRIMARY KEY,
      degree INTEGER,
      connected_at TEXT,
      connection_requested_at TEXT,
      captured_at TEXT NOT NULL
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
