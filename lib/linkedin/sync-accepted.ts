import type Database from "better-sqlite3";
import type { Page } from "playwright";
import { getDb } from "@/lib/db";
import { getSessionPage, saveSessionState, markNeedsReauth } from "@/lib/linkedin/session";
import { initRelationshipSchema, recordConnectedEvidence } from "@/lib/reliability/relationships";

const ACCEPTED_SYNC_INTERVAL_MS = 8 * 60 * 60 * 1000;
const PAGE_SIZE = 100;
const MAX_PAGES = 60;
const DECORATION = "com.linkedin.voyager.dash.deco.web.mynetwork.ConnectionListWithProfile-16";

export interface ApiConnection {
  profileId: string;
  vanity: string | null;
  createdAt: number;
}

export interface ConnectionProvider {
  getDeclaredTotal(): Promise<number | null>;
  getPage(start: number, count: number): Promise<ApiConnection[] | null>;
}

export function shouldSyncAccepted(accountId: string): boolean {
  const db = getDb();
  initRelationshipSchema(db);
  const failure = db.prepare(`SELECT last_failure_at FROM connection_sync_state
    WHERE account_id = ?`).get(accountId) as { last_failure_at: string | null } | undefined;
  if (failure?.last_failure_at) return true;
  const row = db.prepare("SELECT accepted_sync_at FROM accounts WHERE id = ?").get(accountId) as
    | { accepted_sync_at: string | null } | undefined;
  if (!row?.accepted_sync_at) return true;
  return Date.now() - new Date(row.accepted_sync_at).getTime() >= ACCEPTED_SYNC_INTERVAL_MS;
}

/** Complete positive evidence only. Partial passes never write a success marker. */
export async function syncAcceptedFromProvider(
  db: Database.Database, accountId: string, provider: ConnectionProvider, stillOwnsLease?: () => boolean
): Promise<number> {
  db.transaction(() => {
    if (stillOwnsLease && !stillOwnsLease()) throw new Error("Connections lease lost");
    initRelationshipSchema(db);
  }).immediate();
  const declaredTotal = await provider.getDeclaredTotal();
  if (declaredTotal === null || !Number.isSafeInteger(declaredTotal) || declaredTotal < 0) {
    throw new Error("Connections total unavailable");
  }

  const byProfile = new Map<string, ApiConnection>();
  let reachedEnd = false;
  for (let page = 0; page < MAX_PAGES; page++) {
    const connections = await provider.getPage(page * PAGE_SIZE, PAGE_SIZE);
    if (connections === null) throw new Error(`Connections API failed at start=${page * PAGE_SIZE}`);
    if (connections.length === 0) {
      reachedEnd = true;
      break;
    }
    for (const connection of connections) {
      if (!connection.profileId || !Number.isFinite(connection.createdAt)) {
        throw new Error("Connections API returned incomplete profile evidence");
      }
      byProfile.set(connection.profileId, connection);
    }
  }
  if (!reachedEnd || byProfile.size !== declaredTotal) {
    throw new Error(`Incomplete connections pass: pulled ${byProfile.size}, declared ${declaredTotal}`);
  }

  const targets = db.prepare("SELECT id, linkedin_url FROM targets WHERE linkedin_url IS NOT NULL").all() as
    Array<{ id: string; linkedin_url: string }>;
  const targetsByVanity = new Map<string, string[]>();
  for (const target of targets) {
    const vanity = vanityFromUrl(target.linkedin_url);
    if (!vanity) continue;
    const ids = targetsByVanity.get(vanity) ?? [];
    ids.push(target.id);
    targetsByVanity.set(vanity, ids);
  }
  let recorded = 0;
  db.transaction(() => {
    if (stillOwnsLease && !stillOwnsLease()) throw new Error("Connections lease lost");
    for (const connection of byProfile.values()) {
      if (!connection.vanity) continue;
      const ids = targetsByVanity.get(connection.vanity.toLowerCase()) ?? [];
      for (const targetId of ids) {
        recordConnectedEvidence(db, {
          accountId, targetId, connectedAt: new Date(connection.createdAt).toISOString(),
          source: "voyager_connections", profileId: connection.profileId,
        });
        recorded++;
      }
    }
    db.prepare(`UPDATE accounts SET accepted_sync_at = datetime('now'),
      connections_synced_through_ms = ?, li_connections = ? WHERE id = ?`).run(
      Math.max(0, ...Array.from(byProfile.values(), (c) => c.createdAt)), declaredTotal, accountId);
    db.prepare(`INSERT INTO connection_sync_state (account_id, last_failure_at, last_error)
      VALUES (?, NULL, NULL) ON CONFLICT(account_id) DO UPDATE SET
      last_failure_at = NULL, last_error = NULL`).run(accountId);
  }).immediate();
  return recorded;
}

export async function syncAcceptedConnections(accountId: string, stillOwnsLease?: () => boolean): Promise<number> {
  const db = getDb();
  let page: Page | undefined;
  try {
    const sessionPage = await getSessionPage(accountId);
    page = sessionPage;
    await sessionPage.goto("https://www.linkedin.com/mynetwork/invite-connect/connections/", {
      waitUntil: "domcontentloaded", timeout: 35000,
    });
    await sessionPage.waitForTimeout(3500);
    if (/\/login|\/authwall|\/checkpoint|\/uas\//.test(sessionPage.url())) {
      if (!stillOwnsLease || stillOwnsLease()) await markNeedsReauth(accountId, stillOwnsLease);
      throw new Error("LinkedIn session requires authentication");
    }
    const provider: ConnectionProvider = {
      getDeclaredTotal: () => sessionPage.evaluate(() => {
        const match = document.body.innerText.match(/([\d.,]+)\s+connections?/i);
        return match ? Number(match[1].replace(/[.,]/g, "")) : null;
      }),
      getPage: (start, count) => fetchConnectionsPage(sessionPage, start, count),
    };
    const recorded = await syncAcceptedFromProvider(db, accountId, provider, stillOwnsLease);
    if (!stillOwnsLease || stillOwnsLease()) await saveSessionState(accountId, stillOwnsLease);
    return recorded;
  } catch (error) {
    db.transaction(() => {
      if (!stillOwnsLease || stillOwnsLease()) {
        initRelationshipSchema(db);
        db.prepare(`INSERT INTO connection_sync_state (account_id, last_failure_at, last_error)
      VALUES (?, datetime('now'), ?) ON CONFLICT(account_id) DO UPDATE SET
      last_failure_at = excluded.last_failure_at, last_error = excluded.last_error`).run(
          accountId, error instanceof Error ? error.message : String(error));
      }
    }).immediate();
    throw error;
  } finally {
    const url = page?.url() ?? "";
    await page?.close().catch(() => {});
    if (/\/login|\/authwall|\/checkpoint|\/uas\//.test(url) && (!stillOwnsLease || stillOwnsLease())) {
      await markNeedsReauth(accountId, stillOwnsLease).catch(() => {});
    }
  }
}

function vanityFromUrl(url: string): string | null {
  try {
    const parsed = new URL(url);
    if (parsed.hostname !== "linkedin.com" && parsed.hostname !== "www.linkedin.com") return null;
    const path = parsed.pathname.match(/^\/in\/([^/]+)\/?$/);
    return path ? decodeURIComponent(path[1]).toLowerCase() : null;
  } catch {
    return null;
  }
}

async function fetchConnectionsPage(page: Page, start: number, count: number): Promise<ApiConnection[] | null> {
  return page.evaluate(async ({ start, count, decoration }): Promise<ApiConnection[] | null> => {
    const cookies = document.cookie.split("; ").reduce((all: Record<string, string>, item) => {
      const index = item.indexOf("=");
      if (index > 0) all[item.slice(0, index)] = item.slice(index + 1);
      return all;
    }, {});
    const csrf = (cookies.JSESSIONID || "").replace(/"/g, "");
    const url = `https://www.linkedin.com/voyager/api/relationships/dash/connections` +
      `?decorationId=${decoration}&count=${count}&q=search&sortType=RECENTLY_ADDED&start=${start}`;
    let json: { included?: Array<{
      $type?: string; entityUrn?: string; createdAt?: number;
      connectedMember?: string; publicIdentifier?: string;
    }> };
    try {
      const response = await fetch(url, {
        headers: {
          "csrf-token": csrf, accept: "application/vnd.linkedin.normalized+json+2.1",
          "x-restli-protocol-version": "2.0.0", "x-li-lang": "en_US",
        },
        credentials: "include",
      });
      if (!response.ok) return null;
      json = await response.json();
    } catch {
      return null;
    }
    const included = json.included ?? [];
    const vanityByUrn: Record<string, string> = {};
    for (const item of included) {
      if ((item.$type ?? "").includes("identity.profile.Profile") &&
        item.entityUrn && item.publicIdentifier) {
        vanityByUrn[item.entityUrn] = item.publicIdentifier;
      }
    }
    return included.filter((item) =>
      (item.$type ?? "").includes("relationships.Connection") &&
      typeof item.createdAt === "number" && !!item.connectedMember
    ).map((item) => ({
      profileId: item.connectedMember!, createdAt: item.createdAt!,
      vanity: vanityByUrn[item.connectedMember!] ?? null,
    }));
  }, { start, count, decoration: DECORATION });
}
