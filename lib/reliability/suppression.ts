import type Database from "better-sqlite3";

type DB = Database.Database;
export type SuppressionKind = "target" | "email" | "linkedin" | "company" | "company_domain";
export type SuppressionScope = "all" | "net_new";
export interface SuppressionInput {
  kind: SuppressionKind;
  value: string;
  reason: string;
  evidence?: string | null;
  scope?: SuppressionScope;
}
export interface SuppressionBlock extends SuppressionInput {
  scope: SuppressionScope;
  created_at: string;
}

export function initSuppressionSchema(db: DB): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS suppression_rules (
      kind TEXT NOT NULL CHECK(kind IN ('target', 'email', 'linkedin', 'company', 'company_domain')),
      value TEXT NOT NULL,
      reason TEXT NOT NULL,
      evidence TEXT NOT NULL DEFAULT '',
      scope TEXT NOT NULL DEFAULT 'all' CHECK(scope IN ('all', 'net_new')),
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY(kind, value, reason, evidence, scope)
    );
    CREATE INDEX IF NOT EXISTS idx_suppression_lookup ON suppression_rules(kind, value, scope);
  `);
}

export function normalizeSuppressionValue(kind: SuppressionKind, raw: string): string | null {
  const value = raw.trim();
  if (!value) return null;
  if (kind === "target" || kind === "company") return value;
  if (kind === "email") return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value) ? value.toLowerCase() : null;
  if (kind === "company_domain") {
    const domain = value.toLowerCase().replace(/\.$/, "");
    return /^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?\.[a-z]{2,}$/.test(domain) ? domain : null;
  }
  try {
    const url = new URL(value);
    const host = url.hostname.toLowerCase();
    if (url.protocol !== "https:" || (host !== "linkedin.com" && host !== "www.linkedin.com")) return null;
    const match = /^\/in\/([^/]+)\/?$/.exec(url.pathname);
    return match ? `https://www.linkedin.com/in/${decodeURIComponent(match[1]).toLowerCase()}` : null;
  } catch { return null; }
}

export function suppressIdentity(db: DB, input: SuppressionInput): void {
  initSuppressionSchema(db);
  const value = normalizeSuppressionValue(input.kind, input.value);
  if (!value || !input.reason.trim()) throw new Error("valid suppression identifier and reason required");
  db.prepare(`INSERT OR IGNORE INTO suppression_rules (kind, value, reason, evidence, scope)
    VALUES (?, ?, ?, ?, ?)`).run(input.kind, value, input.reason.trim(), input.evidence ?? "", input.scope ?? "all");
}

export function suppressTarget(db: DB, targetId: string, reason: string, evidence?: string): void {
  initSuppressionSchema(db);
  const target = db.prepare("SELECT id, email, linkedin_url FROM targets WHERE id = ?")
    .get(targetId) as { id: string; email: string | null; linkedin_url: string | null } | undefined;
  if (!target) throw new Error(`target_not_found: ${targetId}`);
  db.transaction(() => {
    suppressIdentity(db, { kind: "target", value: target.id, reason, evidence });
    if (target.email) suppressIdentity(db, { kind: "email", value: target.email, reason, evidence });
    if (target.linkedin_url) suppressIdentity(db, { kind: "linkedin", value: target.linkedin_url, reason, evidence });
  })();
}

// Keep historical outreach and explicit exclusions when a target row is removed.
// Sourced-only rows remain eligible after reimport.
export function preserveTargetSuppressionOnDelete(db: DB, targetId: string): void {
  initSuppressionSchema(db);
  const target = db.prepare(`SELECT id, email, linkedin_url, message_sent_at, inmail_sent_at,
    connection_requested_at, last_replied_at, email_replied_at FROM targets WHERE id = ?`)
    .get(targetId) as Record<string, string | null> | undefined;
  if (!target) return;
  db.transaction(() => {
    const existing = evaluateEligibility(db, targetId, { netNew: true }).blocks;
    for (const block of existing) {
      if (block.kind !== "target") continue;
      if (target.email) suppressIdentity(db, { ...block, kind: "email", value: target.email });
      if (target.linkedin_url) suppressIdentity(db, { ...block, kind: "linkedin", value: target.linkedin_url });
    }
    const historical = target.message_sent_at || target.inmail_sent_at || target.connection_requested_at || target.last_replied_at || target.email_replied_at;
    if (historical) {
      if (target.email) suppressIdentity(db, { kind: "email", value: target.email, reason: "previously_contacted", evidence: `deleted_target:${targetId}`, scope: "net_new" });
      if (target.linkedin_url) suppressIdentity(db, { kind: "linkedin", value: target.linkedin_url, reason: "previously_contacted", evidence: `deleted_target:${targetId}`, scope: "net_new" });
    }
  })();
}

export function preserveCompanySuppressionOnDelete(db: DB, companyId: string): void {
  initSuppressionSchema(db);
  const members = db.prepare("SELECT id FROM targets WHERE company_id = ?").all(companyId) as { id: string }[];
  db.transaction(() => {
    for (const { id } of members) {
      const companyBlocks = evaluateEligibility(db, id, { netNew: true }).blocks.filter((b) => b.kind === "company" || b.kind === "company_domain");
      for (const block of companyBlocks) {
        const target = db.prepare("SELECT email, linkedin_url FROM targets WHERE id = ?").get(id) as { email: string | null; linkedin_url: string | null };
        if (target.email) suppressIdentity(db, { ...block, kind: "email", value: target.email });
        if (target.linkedin_url) suppressIdentity(db, { ...block, kind: "linkedin", value: target.linkedin_url });
      }
    }
  })();
}

export function evaluateEligibility(
  db: DB,
  targetId: string,
  options: { channel?: "email" | "linkedin"; netNew?: boolean } = {},
): { allowed: boolean; blocks: SuppressionBlock[] } {
  initSuppressionSchema(db);
  const target = db.prepare(`SELECT t.id, t.email, t.linkedin_url, t.company_id, c.domain AS company_domain
    FROM targets t LEFT JOIN companies c ON c.id = t.company_id WHERE t.id = ?`)
    .get(targetId) as { id: string; email: string | null; linkedin_url: string | null; company_id: string | null; company_domain: string | null } | undefined;
  if (!target) return { allowed: false, blocks: [{ kind: "target", value: targetId, reason: "target_not_found", evidence: "", scope: "all", created_at: "" }] };
  const keys: Array<[SuppressionKind, string]> = [["target", target.id]];
  if (target.email) keys.push(["email", target.email]);
  if (target.linkedin_url) keys.push(["linkedin", target.linkedin_url]);
  if (target.company_id) keys.push(["company", target.company_id]);
  if (target.company_domain) keys.push(["company_domain", target.company_domain]);
  const blocks: SuppressionBlock[] = [];
  const query = db.prepare(`SELECT kind, value, reason, evidence, scope, created_at FROM suppression_rules
    WHERE kind = ? AND value = ? AND (scope = 'all' OR ? = 1)
    ORDER BY created_at, reason`);
  for (const [kind, raw] of keys) {
    const value = normalizeSuppressionValue(kind, raw);
    if (value) blocks.push(...query.all(kind, value, options.netNew ? 1 : 0) as SuppressionBlock[]);
  }
  const relevant = blocks.filter((block) => block.reason !== "hard_bounce" || options.channel !== "linkedin");
  return { allowed: relevant.length === 0, blocks: relevant };
}
