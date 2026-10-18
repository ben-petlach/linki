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
    const domain = value.toLowerCase().replace(/^www\./, "").replace(/\.$/, "");
    return /^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?\.[a-z]{2,}$/.test(domain) ? domain : null;
  }
  try {
    const url = new URL(value);
    const host = url.hostname.toLowerCase();
    if (url.protocol !== "https:" || (host !== "linkedin.com" && host !== "www.linkedin.com")) return null;
    const profile = /^\/in\/([^/]+)\/?$/.exec(url.pathname);
    if (profile) return `https://www.linkedin.com/in/${decodeURIComponent(profile[1]).toLowerCase()}`;
    const lead = /^\/sales\/lead\/([^/]+)\/?$/.exec(url.pathname);
    return lead ? `https://www.linkedin.com/sales/lead/${decodeURIComponent(lead[1]).toLowerCase()}` : null;
  } catch { return null; }
}

export function loadTargetIdentityIndex(db: DB) {
  const profiles = new Map<string, string | null>();
  const emails = new Map<string, string | null>();
  function add(map: Map<string, string | null>, value: string | null, id: string) {
    if (!value) return;
    const previous = map.get(value);
    map.set(value, previous && previous !== id ? null : previous === null ? null : id);
  }
  function register(id: string, values: { linkedin_url?: string | null; sales_nav_url?: string | null; email?: string | null }) {
    add(profiles, values.linkedin_url ? normalizeSuppressionValue("linkedin", values.linkedin_url) : null, id);
    add(profiles, values.sales_nav_url ? normalizeSuppressionValue("linkedin", values.sales_nav_url) : null, id);
    add(emails, values.email ? normalizeSuppressionValue("email", values.email) : null, id);
  }
  for (const row of db.prepare("SELECT id, linkedin_url, sales_nav_url, email FROM targets").all() as Array<{id:string;linkedin_url:string|null;sales_nav_url:string|null;email:string|null}>) {
    register(row.id, row);
  }
  return {
    profile: (value: string | null | undefined) => value ? profiles.get(normalizeSuppressionValue("linkedin", value) ?? "") : undefined,
    email: (value: string | null | undefined) => value ? emails.get(normalizeSuppressionValue("email", value) ?? "") : undefined,
    register,
  };
}

export function suppressIdentity(db: DB, input: SuppressionInput): void {
  initSuppressionSchema(db);
  const value = normalizeSuppressionValue(input.kind, input.value);
  if (!value || !input.reason.trim()) throw new Error("valid suppression identifier and reason required");
  db.prepare(`INSERT OR IGNORE INTO suppression_rules (kind, value, reason, evidence, scope)
    VALUES (?, ?, ?, ?, ?)`).run(input.kind, value, input.reason.trim(), input.evidence ?? "", input.scope ?? "all");
  if (input.kind === "company") {
    const company = db.prepare("SELECT domain FROM companies WHERE id = ?").get(value) as { domain: string | null } | undefined;
    if (company?.domain) suppressIdentity(db, { ...input, kind: "company_domain", value: company.domain });
  }
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

export function preserveSuppressionBeforeEmailUpdate(db: DB, targetId: string, nextEmail: string | null | undefined): void {
  if (!nextEmail) return;
  const target = db.prepare("SELECT email FROM targets WHERE id = ?").get(targetId) as { email: string | null } | undefined;
  if (!target?.email || normalizeSuppressionValue("email", target.email) === normalizeSuppressionValue("email", nextEmail)) return;
  initSuppressionSchema(db);
  const oldEmail = normalizeSuppressionValue("email", target.email);
  const rules = db.prepare(`SELECT reason, evidence FROM suppression_rules WHERE kind = 'email' AND value = ?
    AND scope = 'all' AND reason != 'hard_bounce'`).all(oldEmail) as Array<{ reason: string; evidence: string }>;
  for (const rule of rules) suppressTarget(db, targetId, rule.reason, rule.evidence);
}

function tableExists(db: DB, table: string): boolean {
  return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table);
}

function outreachHistory(db: DB, targetId: string): { evidence: string; at: string } | null {
  const legacy = db.prepare(`SELECT COALESCE(message_sent_at, inmail_sent_at, connection_requested_at,
    last_replied_at, email_replied_at) AS at FROM targets WHERE id = ?
    AND (message_sent_at IS NOT NULL OR inmail_sent_at IS NOT NULL OR connection_requested_at IS NOT NULL
      OR last_replied_at IS NOT NULL OR email_replied_at IS NOT NULL)`).get(targetId) as { at: string } | undefined;
  if (legacy) return { evidence: `target:${targetId}:${legacy.at}`, at: legacy.at };

  if (tableExists(db, "dispatch_actions")) {
    const action = db.prepare(`SELECT action_key, state, COALESCE(dispatched_at, created_at) AS at
      FROM dispatch_actions WHERE target_id = ?
      AND channel IN ('connect', 'message', 'email', 'sales_inmail')
      AND state IN ('sending', 'confirmed', 'unknown')
      ORDER BY created_at LIMIT 1`).get(targetId) as { action_key: string; state: string; at: string } | undefined;
    if (action) return { evidence: `dispatch_action:${action.action_key}:${action.state}`, at: action.at };
  }

  if (tableExists(db, "email_outbound")) {
    const email = db.prepare(`SELECT action_key, accepted_at FROM email_outbound
      WHERE target_id = ? AND accepted_at IS NOT NULL ORDER BY accepted_at LIMIT 1`)
      .get(targetId) as { action_key: string; accepted_at: string } | undefined;
    if (email) return { evidence: `email_outbound:${email.action_key}:${email.accepted_at}`, at: email.accepted_at };
  }
  if (tableExists(db, "account_target_state")) {
    const invitation = db.prepare(`SELECT account_id, connection_requested_at FROM account_target_state
      WHERE target_id = ? AND connection_requested_at IS NOT NULL ORDER BY connection_requested_at LIMIT 1`)
      .get(targetId) as { account_id: string; connection_requested_at: string } | undefined;
    if (invitation) return { evidence: `invitation:${invitation.account_id}:${invitation.connection_requested_at}`, at: invitation.connection_requested_at };
  }
  return null;
}

// Keep historical outreach and explicit exclusions when a target row is removed.
// Sourced-only rows remain eligible after reimport.
export function preserveTargetSuppressionOnDelete(db: DB, targetId: string): void {
  initSuppressionSchema(db);
  const target = db.prepare(`SELECT id, email, linkedin_url, message_sent_at, inmail_sent_at,
    connection_requested_at, last_replied_at, email_replied_at, company_id FROM targets WHERE id = ?`)
    .get(targetId) as Record<string, string | null> | undefined;
  if (!target) return;
  db.transaction(() => {
    const existing = evaluateEligibility(db, targetId, { netNew: true }).blocks;
    for (const block of existing) {
      if (block.kind !== "target") continue;
      if (target.email) suppressIdentity(db, { ...block, kind: "email", value: target.email });
      if (target.linkedin_url) suppressIdentity(db, { ...block, kind: "linkedin", value: target.linkedin_url });
    }
    const historical = outreachHistory(db, targetId);
    if (historical) {
      const input = { reason: "previously_contacted", evidence: `deleted_target:${targetId}:${historical.evidence}`, scope: "net_new" as const };
      if (target.email) suppressIdentity(db, { ...input, kind: "email", value: target.email });
      if (target.linkedin_url) suppressIdentity(db, { ...input, kind: "linkedin", value: target.linkedin_url });
      if (target.company_id) suppressIdentity(db, { ...input, kind: "company", value: target.company_id });
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
  options: { channel?: "email" | "linkedin"; netNew?: boolean; checkNetNewRules?: boolean } = {},
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
  if (target.email) keys.push(["company_domain", target.email.split("@")[1]]);
  const blocks: SuppressionBlock[] = [];
  const query = db.prepare(`SELECT kind, value, reason, evidence, scope, created_at FROM suppression_rules
    WHERE kind = ? AND value = ? AND (scope = 'all' OR ? = 1)
    ORDER BY created_at, reason`);
  for (const [kind, raw] of keys) {
    const value = normalizeSuppressionValue(kind, raw);
    if (value) blocks.push(...query.all(kind, value, options.netNew || options.checkNetNewRules ? 1 : 0) as SuppressionBlock[]);
  }
  const relevant = blocks.filter((block) => block.reason !== "hard_bounce" || options.channel !== "linkedin");
  if (options.netNew) {
    const members = target.company_id
      ? db.prepare("SELECT id FROM targets WHERE id = ? OR company_id = ?").all(targetId, target.company_id) as { id: string }[]
      : [{ id: targetId }];
    for (const member of members) {
      const history = outreachHistory(db, member.id);
      if (!history) continue;
      relevant.push({
        kind: member.id === targetId ? "target" : "company",
        value: member.id === targetId ? targetId : target.company_id!,
        reason: "previously_contacted",
        evidence: history.evidence,
        scope: "net_new",
        created_at: history.at,
      });
      break;
    }
  }
  return { allowed: relevant.length === 0, blocks: relevant };
}
