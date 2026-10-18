import type Database from "better-sqlite3";
import type { Page } from "playwright";
import { recordInboxSyncFailure, recordInboxSyncSuccess } from "../reliability/inbox-state";
import { suppressTarget } from "../reliability/suppression";
import { normalizedProfileUrl } from "./visit";

export class IncompleteLinkedInInboxError extends Error {}

type Inbound = { profileUrl: string; eventId: string; sentAt: string };

function timestamp(value: string): number {
  // SQLite datetime('now') is UTC without a timezone suffix.
  return Date.parse(/(?:Z|[+-]\d\d:\d\d)$/i.test(value) ? value : `${value.replace(" ", "T")}Z`);
}

export function initLinkedInInboxSchema(db: Database.Database): void {
  db.exec(`CREATE TABLE IF NOT EXISTS linkedin_inbox_events (
    account_id TEXT NOT NULL,
    event_id TEXT NOT NULL,
    target_id TEXT NOT NULL,
    received_at TEXT NOT NULL,
    PRIMARY KEY (account_id, event_id)
  )`);
}

/**
 * Public-edition inbox scan. Only a complete, unambiguous scan refreshes the
 * account's inbox state. Unknown LinkedIn layouts leave sends blocked.
 */
export async function syncLinkedInInbox(db: Database.Database, accountId: string, page: Page): Promise<number> {
  initLinkedInInboxSchema(db);
  const startedAt = new Date().toISOString();
  try {
    const events = await scanInbox(page);
    let newReplies = 0;
    const save = db.transaction(() => {
      for (const event of events) {
        const rows = db.prepare(`
          SELECT DISTINCT t.id, t.linkedin_url, t.message_sent_at
          FROM targets t
          JOIN run_profiles rp ON rp.target_id = t.id
          JOIN runs r ON r.id = rp.run_id
          WHERE r.account_id = ? AND t.linkedin_url IS NOT NULL
        `).all(accountId) as { id: string; linkedin_url: string; message_sent_at: string | null }[];
        const matches = rows.filter((row) => normalizedProfileUrl(row.linkedin_url) === event.profileUrl);
        if (matches.length > 1) throw new IncompleteLinkedInInboxError(`Ambiguous target identity: ${event.profileUrl}`);
        if (!matches.length) continue;
        const target = matches[0];
        // Historical unrelated messages are not campaign replies.
        if (!target.message_sent_at || !Number.isFinite(timestamp(target.message_sent_at)) ||
            timestamp(event.sentAt) <= timestamp(target.message_sent_at)) continue;
        const inserted = db.prepare(`INSERT OR IGNORE INTO linkedin_inbox_events
          (account_id, event_id, target_id, received_at) VALUES (?, ?, ?, ?)`)
          .run(accountId, event.eventId, target.id, event.sentAt).changes;
        if (!inserted) continue;
        suppressTarget(db, target.id, "inbound_reply", `linkedin:${accountId}:${event.eventId}`);
        db.prepare("UPDATE targets SET last_replied_at = COALESCE(last_replied_at, ?) WHERE id = ?")
          .run(event.sentAt, target.id);
        newReplies++;
      }
      recordInboxSyncSuccess(db, { accountId, channel: "linkedin", startedAt });
    });
    save();
    return newReplies;
  } catch (error) {
    recordInboxSyncFailure(db, {
      accountId,
      channel: "linkedin",
      startedAt,
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}

async function scanInbox(page: Page): Promise<Inbound[]> {
  await page.goto("https://www.linkedin.com/messaging/", { waitUntil: "domcontentloaded", timeout: 30000 });
  if (!page.url().startsWith("https://www.linkedin.com/messaging/")) {
    throw new IncompleteLinkedInInboxError("LinkedIn inbox redirected to login or checkpoint");
  }
  const seenThreads = new Set<string>();
  const seenEvents = new Set<string>();
  const events: Inbound[] = [];

  for (let pageNumber = 0; pageNumber < 100; pageNumber++) {
    const listing = page.locator(".msg-conversation-listitem");
    if (await listing.count() === 0) throw new IncompleteLinkedInInboxError("Inbox thread list missing");
    const threads = await listing.evaluateAll((nodes) => nodes.map((node) => ({
      url: (node.querySelector('a[href*="/messaging/thread/"]') as HTMLAnchorElement | null)?.href ?? "",
      profileUrl: (node.querySelector('a[href*="/in/"]') as HTMLAnchorElement | null)?.href ?? "",
    })));
    if (threads.some((thread) => !thread.url || !normalizedProfileUrl(thread.profileUrl))) {
      throw new IncompleteLinkedInInboxError("Inbox thread identity missing");
    }

    for (const thread of threads) {
      if (seenThreads.has(thread.url)) throw new IncompleteLinkedInInboxError("Inbox pagination repeated a thread");
      seenThreads.add(thread.url);
      const profileUrl = normalizedProfileUrl(thread.profileUrl)!;
      await page.goto(thread.url, { waitUntil: "domcontentloaded", timeout: 30000 });
      if (!page.url().startsWith("https://www.linkedin.com/messaging/thread/")) {
        throw new IncompleteLinkedInInboxError("LinkedIn thread redirected or unavailable");
      }
      const threadIdentity = await page.locator('.msg-thread__link-to-profile[href*="/in/"]').evaluateAll(
        (nodes) => nodes.map((node) => (node as HTMLAnchorElement).href)
      );
      if (threadIdentity.length !== 1 || normalizedProfileUrl(threadIdentity[0]) !== profileUrl) {
        throw new IncompleteLinkedInInboxError("Thread participant identity differs from inbox listing");
      }
      const messages = page.locator(".msg-s-message-list__event");
      if (await messages.count() === 0) throw new IncompleteLinkedInInboxError("Thread messages missing");
      const parsed = await messages.evaluateAll((nodes) => nodes.map((node) => ({
        id: node.getAttribute("data-event-id") ?? "",
        sentAt: node.querySelector("time[datetime]")?.getAttribute("datetime") ?? "",
        inbound: node.classList.contains("msg-s-message-list__event--inbound"),
        outbound: node.classList.contains("msg-s-message-list__event--outbound"),
      })));
      if (parsed.some((message) => !message.id || !Number.isFinite(Date.parse(message.sentAt)) || message.inbound === message.outbound)) {
        throw new IncompleteLinkedInInboxError("Thread event identity, time, or direction missing");
      }
      for (const message of parsed) {
        if (!message.inbound) continue;
        if (seenEvents.has(message.id)) throw new IncompleteLinkedInInboxError("Duplicate LinkedIn message identity");
        seenEvents.add(message.id);
        events.push({ profileUrl, eventId: message.id, sentAt: message.sentAt });
      }
      await page.goBack({ waitUntil: "domcontentloaded", timeout: 30000 });
    }

    const next = page.locator('button[aria-label="Next page"]');
    if (await next.count() !== 1) throw new IncompleteLinkedInInboxError("Inbox pagination completion unavailable");
    if (await next.isDisabled()) return events;
    await next.click();
  }
  throw new IncompleteLinkedInInboxError("Inbox pagination exceeded 100 pages");
}
