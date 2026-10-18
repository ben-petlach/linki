import { randomUUID } from "crypto";
import type Database from "better-sqlite3";

export type ActionState = "claimed" | "sending" | "confirmed" | "unknown";
export interface ActionRecord {
  action_key: string;
  state: ActionState;
  token: string;
  lease_until: number | null;
  dispatched_at: string | null;
  sender_id: string;
  target_id: string;
  channel: string;
  recipient_identity: string | null;
  payload: string | null;
  evidence: string | null;
  reason: string | null;
}
export type ClaimResult = { claimed: true; token: string } | { claimed: false; state: ActionState; reason: string };

export function initActionSchema(db: Database.Database): void {
  db.exec(`CREATE TABLE IF NOT EXISTS dispatch_actions (
    action_key TEXT PRIMARY KEY,
    state TEXT NOT NULL CHECK(state IN ('claimed','sending','confirmed','unknown')),
    token TEXT NOT NULL,
    lease_until INTEGER,
    dispatched_at TEXT,
    sender_id TEXT NOT NULL,
    target_id TEXT NOT NULL,
    channel TEXT NOT NULL,
    recipient_identity TEXT,
    payload TEXT,
    evidence TEXT,
    reason TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`);
  db.exec("CREATE INDEX IF NOT EXISTS idx_dispatch_actions_sender ON dispatch_actions(sender_id, channel, state)");
  const columns = db.prepare("PRAGMA table_info(dispatch_actions)").all() as Array<{ name: string }>;
  if (!columns.some(column => column.name === "recipient_identity")) db.exec("ALTER TABLE dispatch_actions ADD COLUMN recipient_identity TEXT");
}

export function actionKey(trackRunId: string, stepId: string): string {
  return `${trackRunId}:${stepId}`;
}

export function getAction(db: Database.Database, key: string): ActionRecord | undefined {
  return db.prepare("SELECT * FROM dispatch_actions WHERE action_key = ?").get(key) as ActionRecord | undefined;
}

export function claimAction(db: Database.Database, input: {
  key: string; senderId: string; targetId: string; channel: string; recipientIdentity?: string;
  payload?: string; leaseMs?: number; now?: number;
}): ClaimResult {
  initActionSchema(db);
  const now = input.now ?? Date.now();
  const token = randomUUID();
  return db.transaction(() => {
    const row = getAction(db, input.key);
    if (!row) {
      db.prepare(`INSERT INTO dispatch_actions
        (action_key,state,token,lease_until,sender_id,target_id,channel,recipient_identity,payload)
        VALUES (?, 'claimed', ?, ?, ?, ?, ?, ?, ?)`)
        .run(input.key, token, now + (input.leaseMs ?? 60_000), input.senderId, input.targetId,
          input.channel, input.recipientIdentity ?? null, input.payload ?? null);
      return { claimed: true, token } as ClaimResult;
    }
    if (row.sender_id !== input.senderId || row.target_id !== input.targetId || row.channel !== input.channel ||
        (row.recipient_identity !== null && input.recipientIdentity !== undefined && row.recipient_identity !== input.recipientIdentity))
      return { claimed: false, state: row.state, reason: "action identity mismatch" } as ClaimResult;
    if (row.state === "claimed" && row.lease_until !== null && row.lease_until <= now) {
      db.prepare(`UPDATE dispatch_actions SET token = ?, lease_until = ?, payload = ?,
        recipient_identity = COALESCE(recipient_identity, ?), updated_at = CURRENT_TIMESTAMP
        WHERE action_key = ? AND state = 'claimed' AND token = ?`)
        .run(token, now + (input.leaseMs ?? 60_000), input.payload ?? null, input.recipientIdentity ?? null, input.key, row.token);
      return { claimed: true, token } as ClaimResult;
    }
    const reason = row.state === "claimed" ? "another worker owns action" :
      row.state === "confirmed" ? "action already confirmed" :
      row.state === "unknown" ? (row.reason ?? "outcome unknown; review required") :
      "dispatch began; outcome unknown until reconciled";
    return { claimed: false, state: row.state, reason } as ClaimResult;
  }).immediate();
}

// Gates execute inside same write transaction as transition to sending. No await is allowed.
export function beginDispatch(db: Database.Database, key: string, token: string, gate: () => string | null, now = Date.now()): { started: boolean; reason?: string } {
  return db.transaction(() => {
    const row = getAction(db, key);
    if (!row || row.state !== "claimed" || row.token !== token || row.lease_until === null || row.lease_until <= now)
      return { started: false, reason: "claim lost or expired" };
    const reason = gate();
    if (reason) return { started: false, reason };
    db.prepare(`UPDATE dispatch_actions SET state = 'sending', lease_until = NULL, dispatched_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
      WHERE action_key = ? AND token = ? AND state = 'claimed'`).run(key, token);
    return { started: true };
  }).immediate();
}

export function confirmAction(db: Database.Database, key: string, token: string, evidence: string): boolean {
  if (!evidence.trim()) throw new Error("confirmed action requires external evidence");
  const result = db.prepare(`UPDATE dispatch_actions SET state = 'confirmed', evidence = ?, reason = NULL, updated_at = CURRENT_TIMESTAMP
    WHERE action_key = ? AND token = ? AND state = 'sending'`).run(evidence, key, token);
  if (result.changes === 1) return true;
  const row = getAction(db, key);
  return row?.state === "confirmed" && row.token === token && row.evidence === evidence;
}

export function holdUnknown(db: Database.Database, key: string, token: string, reason: string): boolean {
  const result = db.prepare(`UPDATE dispatch_actions SET state = 'unknown', reason = ?, updated_at = CURRENT_TIMESTAMP
    WHERE action_key = ? AND token = ? AND state = 'sending'`).run(reason, key, token);
  return result.changes === 1;
}

export function releaseClaim(db: Database.Database, key: string, token: string): boolean {
  const result = db.prepare("DELETE FROM dispatch_actions WHERE action_key = ? AND token = ? AND state = 'claimed'").run(key, token);
  return result.changes === 1;
}
