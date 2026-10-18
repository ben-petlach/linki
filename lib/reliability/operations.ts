import { randomUUID } from "crypto";
import type Database from "better-sqlite3";

type Db = Database.Database;

export interface HeldAction {
  action_key: string;
  state: "sending" | "unknown";
  sender_id: string;
  sender_name: string | null;
  target_id: string;
  target_name: string | null;
  recipient: string | null;
  channel: string;
  payload: string | null;
  evidence: string | null;
  reason: string | null;
  dispatched_at: string | null;
  updated_at: string;
  provider_message_id: string | null;
  provider_accepted_at: string | null;
}

export function initOperationsSchema(db: Db): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS global_dispatch_control (
      id INTEGER PRIMARY KEY CHECK(id = 1),
      paused INTEGER NOT NULL CHECK(paused IN (0, 1)),
      reason TEXT NOT NULL,
      updated_by TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS operation_audit (
      id TEXT PRIMARY KEY,
      action_key TEXT,
      kind TEXT NOT NULL,
      actor_id TEXT NOT NULL,
      reason TEXT NOT NULL,
      evidence TEXT,
      before_state TEXT,
      after_state TEXT,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_operation_audit_action ON operation_audit(action_key, created_at);
    CREATE TABLE IF NOT EXISTS operation_worker_health (
      worker_kind TEXT PRIMARY KEY,
      last_heartbeat_at TEXT
    );
    CREATE TABLE IF NOT EXISTS operation_alerts (
      fingerprint TEXT PRIMARY KEY,
      kind TEXT NOT NULL,
      subject_id TEXT NOT NULL,
      message TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('open','resolved')),
      first_seen_at TEXT NOT NULL,
      last_seen_at TEXT NOT NULL,
      resolved_at TEXT
    );
  `);
  const auditColumns = db.prepare("PRAGMA table_info(operation_audit)").all() as Array<{ name: string }>;
  if (!auditColumns.some(column => column.name === "before_state")) db.exec("ALTER TABLE operation_audit ADD COLUMN before_state TEXT");
  if (!auditColumns.some(column => column.name === "after_state")) db.exec("ALTER TABLE operation_audit ADD COLUMN after_state TEXT");
  db.prepare("INSERT OR IGNORE INTO operation_worker_health (worker_kind, last_heartbeat_at) VALUES ('scheduler', NULL)").run();
}

export function getDispatchBlockReason(db: Db): string | null {
  const row = db.prepare("SELECT paused, reason FROM global_dispatch_control WHERE id = 1")
    .get() as { paused: number; reason: string } | undefined;
  return row?.paused ? `Global dispatch paused: ${row.reason}` : null;
}

export function getGlobalDispatchControl(db: Db): { paused: boolean; reason: string; updatedBy: string | null; updatedAt: string | null } {
  const row = db.prepare("SELECT paused, reason, updated_by, updated_at FROM global_dispatch_control WHERE id = 1")
    .get() as { paused: number; reason: string; updated_by: string; updated_at: string } | undefined;
  return { paused: row?.paused === 1, reason: row?.reason ?? "", updatedBy: row?.updated_by ?? null, updatedAt: row?.updated_at ?? null };
}

export function setGlobalDispatchPause(db: Db, input: { paused: boolean; actorId: string; reason: string; now?: string }): void {
  const reason = input.reason.trim();
  if (!input.actorId.trim() || !reason || reason.length > 2000) throw new Error("Actor and reason are required for pause changes");
  const now = input.now ?? new Date().toISOString();
  initOperationsSchema(db);
  db.transaction(() => {
    const before = getGlobalDispatchControl(db).paused ? "paused" : "running";
    const after = input.paused ? "paused" : "running";
    db.prepare(`INSERT INTO global_dispatch_control (id, paused, reason, updated_by, updated_at)
      VALUES (1, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET paused = excluded.paused, reason = excluded.reason,
        updated_by = excluded.updated_by, updated_at = excluded.updated_at`)
      .run(input.paused ? 1 : 0, reason, input.actorId, now);
    db.prepare(`INSERT INTO operation_audit
      (id, action_key, kind, actor_id, reason, evidence, before_state, after_state, created_at)
      VALUES (?, NULL, ?, ?, ?, NULL, ?, ?, ?)`)
      .run(randomUUID(), input.paused ? "global_pause" : "global_resume", input.actorId, reason, before, after, now);
  }).immediate();
}

export function listHeldActions(db: Db): HeldAction[] {
  return db.prepare(`SELECT a.action_key, a.state, a.sender_id,
      CASE WHEN a.channel = 'email' THEN ea.name ELSE la.name END AS sender_name,
      a.target_id, t.full_name AS target_name,
      CASE WHEN a.channel = 'email' THEN COALESCE(o.recipient_email, t.email) ELSE t.linkedin_url END AS recipient,
      a.channel, a.payload, a.evidence, a.reason, a.dispatched_at, a.updated_at,
      o.message_id AS provider_message_id, o.accepted_at AS provider_accepted_at
    FROM dispatch_actions a
    LEFT JOIN targets t ON t.id = a.target_id
    LEFT JOIN email_accounts ea ON ea.id = a.sender_id AND a.channel = 'email'
    LEFT JOIN accounts la ON la.id = a.sender_id AND a.channel != 'email'
    LEFT JOIN email_outbound o ON o.action_key = a.action_key
    WHERE a.state IN ('sending','unknown')
    ORDER BY a.updated_at DESC, a.action_key`).all() as HeldAction[];
}

export function reviewHeldAction(db: Db, input: {
  actionKey: string; actorId: string; reason: string; evidence: string;
  decision: "note" | "confirm_provider_accepted"; now?: string;
}): { confirmed: boolean; reason: string } {
  const reason = input.reason.trim();
  const evidence = input.evidence.trim();
  if (!input.actorId.trim() || !reason || !evidence || reason.length > 2000 || evidence.length > 4000)
    throw new Error("Actor, reason, and evidence are required for action review");
  const now = input.now ?? new Date().toISOString();
  initOperationsSchema(db);
  return db.transaction(() => {
    const action = db.prepare("SELECT state, channel, target_id, sender_id FROM dispatch_actions WHERE action_key = ?")
      .get(input.actionKey) as { state: string; channel: string; target_id: string; sender_id: string } | undefined;
    if (!action || !["unknown", "sending"].includes(action.state)) throw new Error("Action is not held");
    let confirmed = false;
    if (input.decision === "confirm_provider_accepted") {
      // A note or operator-provided ID is insufficient proof of a send. Only a
      // previously persisted SMTP acceptance for this exact action can confirm.
      const outbound = db.prepare(`SELECT message_id, accepted_at FROM email_outbound
        WHERE action_key = ? AND target_id = ? AND email_account_id = ? AND accepted_at IS NOT NULL`)
        .get(input.actionKey, action.target_id, action.sender_id) as { message_id: string; accepted_at: string } | undefined;
      if (action.channel !== "email" || !outbound?.message_id) throw new Error("No durable provider acceptance for this exact action");
      const result = db.prepare(`UPDATE dispatch_actions SET state = 'confirmed', evidence = ?, reason = NULL,
        updated_at = ? WHERE action_key = ? AND state IN ('unknown','sending')`)
        .run(outbound.message_id, now, input.actionKey);
      if (result.changes !== 1) throw new Error("Action changed during review");
      confirmed = true;
    }
    db.prepare(`INSERT INTO operation_audit
      (id, action_key, kind, actor_id, reason, evidence, before_state, after_state, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(randomUUID(), input.actionKey, confirmed ? "provider_reconciled" : "review_note",
        input.actorId, reason, evidence, action.state, confirmed ? "confirmed" : action.state, now);
    return { confirmed, reason: confirmed ? "Provider acceptance reconciled without resend" : "Action remains held" };
  }).immediate();
}

export function getOperationMetrics(db: Db): Record<string, number> {
  const action = db.prepare(`SELECT
      SUM(CASE WHEN dispatched_at IS NOT NULL THEN 1 ELSE 0 END) AS attempted,
      SUM(CASE WHEN state = 'confirmed' THEN 1 ELSE 0 END) AS confirmed,
      SUM(CASE WHEN state IN ('sending','unknown') THEN 1 ELSE 0 END) AS unknown
    FROM dispatch_actions`).get() as { attempted: number | null; confirmed: number | null; unknown: number | null };
  const outbound = db.prepare("SELECT COUNT(*) AS count FROM email_outbound WHERE accepted_at IS NOT NULL").get() as { count: number };
  const inbound = db.prepare(`SELECT
      SUM(CASE WHEN kind = 'reply' THEN 1 ELSE 0 END) AS replied,
      SUM(CASE WHEN kind = 'bounce' THEN 1 ELSE 0 END) AS bounced,
      SUM(CASE WHEN kind = 'unsubscribe' THEN 1 ELSE 0 END) AS unsubscribed
    FROM email_inbound`).get() as { replied: number | null; bounced: number | null; unsubscribed: number | null };
  const linkedInReplies = db.prepare("SELECT COUNT(*) AS count FROM linkedin_inbox_events").get() as { count: number };
  return {
    attempted: action.attempted ?? 0,
    confirmed: action.confirmed ?? 0,
    emailAccepted: outbound.count,
    replied: (inbound.replied ?? 0) + linkedInReplies.count,
    bounced: inbound.bounced ?? 0,
    unsubscribed: inbound.unsubscribed ?? 0,
    unknown: action.unknown ?? 0,
  };
}

export function recordWorkerHeartbeat(db: Db, workerKind = "scheduler", now = new Date().toISOString()): void {
  initOperationsSchema(db);
  db.prepare(`INSERT INTO operation_worker_health (worker_kind, last_heartbeat_at) VALUES (?, ?)
    ON CONFLICT(worker_kind) DO UPDATE SET last_heartbeat_at = excluded.last_heartbeat_at`).run(workerKind, now);
}

export function evaluateOperationAlerts(db: Db, input: { now?: string; workerMaxAgeMs?: number; emailMaxAgeMs?: number; linkedinMaxAgeMs?: number } = {}): void {
  initOperationsSchema(db);
  const now = input.now ?? new Date().toISOString();
  const nowMs = Date.parse(now);
  if (!Number.isFinite(nowMs)) throw new Error("Invalid alert evaluation time");
  const wanted = new Map<string, { kind: string; subjectId: string; message: string }>();
  const worker = db.prepare("SELECT last_heartbeat_at FROM operation_worker_health WHERE worker_kind = 'scheduler'")
    .get() as { last_heartbeat_at: string | null };
  if (!worker.last_heartbeat_at || !Number.isFinite(Date.parse(worker.last_heartbeat_at)) ||
      nowMs - Date.parse(worker.last_heartbeat_at) > (input.workerMaxAgeMs ?? 5 * 60_000) ||
      Date.parse(worker.last_heartbeat_at) > nowMs + 60_000) {
    wanted.set("worker:scheduler", { kind: "worker_stale", subjectId: "scheduler", message: "Scheduler heartbeat missing or stale" });
  }
  const inboxes = db.prepare("SELECT account_id, channel, last_successful_at, last_failure_at FROM inbox_sync_state").all() as
    Array<{ account_id: string; channel: string; last_successful_at: string | null; last_failure_at: string | null }>;
  const expected = new Map(inboxes.map(inbox => [`${inbox.channel}:${inbox.account_id}`, inbox]));
  const tableExists = (name: string) => !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name);
  if (tableExists("email_accounts")) {
    const rows = db.prepare("SELECT id FROM email_accounts WHERE is_verified = 1").all() as Array<{ id: string }>;
    for (const row of rows) if (!expected.has(`email:${row.id}`)) {
      expected.set(`email:${row.id}`, { account_id: row.id, channel: "email", last_successful_at: null, last_failure_at: null });
    }
  }
  if (tableExists("accounts")) {
    const rows = db.prepare("SELECT id FROM accounts WHERE is_authenticated = 1").all() as Array<{ id: string }>;
    for (const row of rows) if (!expected.has(`linkedin:${row.id}`)) {
      expected.set(`linkedin:${row.id}`, { account_id: row.id, channel: "linkedin", last_successful_at: null, last_failure_at: null });
    }
  }
  for (const inbox of expected.values()) {
    const successMs = Date.parse(inbox.last_successful_at ?? "");
    // LinkedIn polling is due every 15 minutes; allow one missed interval
    // before alerting, while final send gates apply their stricter freshness.
    const maxAge = inbox.channel === "email" ? (input.emailMaxAgeMs ?? 5 * 60_000) : (input.linkedinMaxAgeMs ?? 30 * 60_000);
    if (!Number.isFinite(successMs) || successMs > nowMs + 60_000 || nowMs - successMs > maxAge || inbox.last_failure_at) {
      const key = `inbox:${inbox.channel}:${inbox.account_id}`;
      wanted.set(key, { kind: "inbox_stale", subjectId: `${inbox.channel}:${inbox.account_id}`,
        message: `${inbox.channel} inbox sync missing, failed, or stale` });
    }
  }
  const held = db.prepare("SELECT action_key, state FROM dispatch_actions WHERE state IN ('sending','unknown')").all() as
    Array<{ action_key: string; state: string }>;
  for (const action of held) wanted.set(`action:${action.action_key}`, {
    kind: "action_held", subjectId: action.action_key, message: `Dispatch action ${action.state}; review required`,
  });
  db.transaction(() => {
    const upsert = db.prepare(`INSERT INTO operation_alerts
      (fingerprint, kind, subject_id, message, status, first_seen_at, last_seen_at, resolved_at)
      VALUES (?, ?, ?, ?, 'open', ?, ?, NULL)
      ON CONFLICT(fingerprint) DO UPDATE SET message = excluded.message, last_seen_at = excluded.last_seen_at,
        status = 'open', first_seen_at = CASE WHEN operation_alerts.status = 'resolved'
          THEN excluded.first_seen_at ELSE operation_alerts.first_seen_at END, resolved_at = NULL`);
    for (const [key, item] of wanted) upsert.run(key, item.kind, item.subjectId, item.message, now, now);
    const open = db.prepare("SELECT fingerprint FROM operation_alerts WHERE status = 'open'").all() as Array<{ fingerprint: string }>;
    const resolve = db.prepare("UPDATE operation_alerts SET status = 'resolved', resolved_at = ? WHERE fingerprint = ?");
    for (const row of open) if (!wanted.has(row.fingerprint)) resolve.run(now, row.fingerprint);
  }).immediate();
}

export function listOperationAlerts(db: Db): Array<{ fingerprint: string; kind: string; subject_id: string; message: string; status: string; first_seen_at: string; last_seen_at: string }> {
  return db.prepare(`SELECT fingerprint, kind, subject_id, message, status, first_seen_at, last_seen_at
    FROM operation_alerts WHERE status = 'open' ORDER BY first_seen_at DESC`).all() as ReturnType<typeof listOperationAlerts>;
}
