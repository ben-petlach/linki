import type Database from "better-sqlite3";
import type { Page } from "playwright";
import { recordInboxSyncFailure, recordInboxSyncSuccess } from "../reliability/inbox-state";
import { suppressTarget } from "../reliability/suppression";
import { normalizedProfileUrl } from "./visit";

export class IncompleteLinkedInInboxError extends Error {}

type Json = Record<string, unknown>;
type Inbound = { profileUrl: string; eventId: string; sentAt: string };
const CONVERSATIONS_QUERY = "messengerConversations.9501074288a12f3ae9e3c7ea243bccbf";
const MESSAGES_QUERY = "messengerMessages.d8ea76885a52fd5dc5c317078ab7c977";
const PAGE_SIZE = 100;

/**
 * Query IDs and response shapes are from OpenRecruiterTools/linkedin-toolkit,
 * extension/src/background/voyager.js and tests/fixtures/voyager, captured
 * 2026-09-08. LinkedIn may rotate IDs: any 400 or shape drift fails closed.
 */
function encodeValue(value: unknown): string {
  if (Array.isArray(value)) return `List(${value.map(encodeValue).join(",")})`;
  if (value && typeof value === "object") return encodeVariables(value as Json);
  return encodeURIComponent(String(value)).replace(/[!'()*]/g, (char) =>
    `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
}

function encodeVariables(values: Json): string {
  return `(${Object.entries(values).filter(([, value]) => value !== undefined && value !== null)
    .map(([key, value]) => `${key}:${encodeValue(value)}`).join(",")})`;
}

function object(value: unknown): Json | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Json : null;
}

function includedIndex(raw: Json): Map<string, Json> {
  const rows = raw.included;
  if (!Array.isArray(rows)) throw new IncompleteLinkedInInboxError("LinkedIn normalized included list missing");
  return new Map(rows.map(object).filter((row): row is Json => !!row && typeof row.entityUrn === "string")
    .map((row) => [row.entityUrn as string, row]));
}

function resolveRows(collection: Json, index: Map<string, Json>): Json[] {
  const inline = collection.elements;
  const refs = collection["*elements"];
  const rows = Array.isArray(inline) ? inline : Array.isArray(refs) ? refs : null;
  if (!rows) throw new IncompleteLinkedInInboxError("LinkedIn collection elements missing");
  return rows.map((row) => {
    const resolved = typeof row === "string" ? index.get(row) : object(row);
    if (!resolved) throw new IncompleteLinkedInInboxError("LinkedIn normalized reference unresolved");
    return resolved;
  });
}

function collection(raw: Json, name: string): { rows: Json[]; metadata: Json } {
  const node = object(object(raw.data)?.data)?.[name];
  const item = object(node);
  if (!item) throw new IncompleteLinkedInInboxError(`LinkedIn ${name} collection missing`);
  const metadata = object(item.metadata);
  if (name === "messengerConversationsByCategoryQuery" && !metadata) {
    throw new IncompleteLinkedInInboxError("LinkedIn inbox pagination metadata missing");
  }
  return { rows: resolveRows(item, includedIndex(raw)), metadata: metadata ?? {} };
}

function participantUrn(value: Json): string | null {
  return typeof value.hostIdentityUrn === "string" ? value.hostIdentityUrn : null;
}

function participantProfile(value: Json): string | null {
  return normalizedProfileUrl(String(object(object(value.participantType)?.member)?.profileUrl ?? ""));
}

function timestamp(value: string): number {
  // SQLite datetime('now') is UTC without a timezone suffix.
  return Date.parse(/(?:Z|[+-]\d\d:\d\d)$/i.test(value) ? value : `${value.replace(" ", "T")}Z`);
}

async function voyager(page: Page, path: string): Promise<Json> {
  const result = await page.evaluate(async (requestPath) => {
    const cookies = Object.fromEntries(document.cookie.split("; ").filter(Boolean).map((part) => {
      const at = part.indexOf("=");
      return [part.slice(0, at), part.slice(at + 1)];
    }));
    const csrf = (cookies.JSESSIONID ?? "").replace(/"/g, "");
    if (!csrf) return { error: "LinkedIn JSESSIONID/CSRF cookie missing" };
    const response = await fetch(`https://www.linkedin.com/voyager/api${requestPath}`, {
      credentials: "include",
      headers: {
        "csrf-token": csrf,
        "accept": "application/vnd.linkedin.normalized+json+2.1",
        "x-restli-protocol-version": "2.0.0",
      },
    });
    if (!response.ok) return { error: `LinkedIn Voyager HTTP ${response.status}` };
    return response.json();
  }, path) as Json;
  if (typeof result.error === "string") throw new IncompleteLinkedInInboxError(result.error);
  return result;
}

async function graphql(page: Page, queryId: string, variables: Json): Promise<Json> {
  return voyager(page, `/voyagerMessagingGraphQL/graphql?queryId=${queryId}&variables=${encodeVariables(variables)}`);
}

async function mailboxUrn(page: Page): Promise<string> {
  const raw = await voyager(page, "/me");
  const included = includedIndex(raw);
  const candidates = [...included.values()].map((row) => String(row.dashEntityUrn ?? row.entityUrn ?? ""));
  const urn = candidates.find((value) => /^urn:li:fsd_profile:[A-Za-z0-9_-]+$/.test(value)) ??
    candidates.find((value) => /^urn:li:fs_miniProfile:[A-Za-z0-9_-]+$/.test(value))?.replace("fs_miniProfile", "fsd_profile");
  if (!urn) throw new IncompleteLinkedInInboxError("Own LinkedIn mailbox identity missing");
  return urn;
}

async function scanInbox(page: Page): Promise<Inbound[]> {
  await page.goto("https://www.linkedin.com/messaging/", { waitUntil: "domcontentloaded", timeout: 30000 });
  if (!page.url().startsWith("https://www.linkedin.com/messaging/")) {
    throw new IncompleteLinkedInInboxError("LinkedIn inbox redirected to login or checkpoint");
  }
  const self = await mailboxUrn(page);
  const seenThreads = new Set<string>();
  const seenCursors = new Set<string>();
  const events: Inbound[] = [];
  let cursor: string | undefined;
  for (let pageNumber = 0; pageNumber < 100; pageNumber++) {
    const raw = await graphql(page, CONVERSATIONS_QUERY, {
      query: { predicateUnions: [{ conversationCategoryPredicate: { category: "PRIMARY_INBOX" } }] },
      count: PAGE_SIZE,
      mailboxUrn: self,
      ...(cursor ? { nextCursor: cursor } : {}),
    });
    const { rows, metadata } = collection(raw, "messengerConversationsByCategoryQuery");
    if (rows.length === 0 && metadata.nextCursor) throw new IncompleteLinkedInInboxError("Empty LinkedIn inbox page has continuation");
    for (const thread of rows) {
      const urn = String(thread.entityUrn ?? "");
      if (!/^urn:li:msg_conversation:\(.+\)$/.test(urn) || seenThreads.has(urn)) {
        throw new IncompleteLinkedInInboxError("LinkedIn conversation identity missing or repeated");
      }
      seenThreads.add(urn);
      const participants = Array.isArray(thread.conversationParticipants) ? thread.conversationParticipants.map(object) : null;
      if (!participants || participants.some((p) => !p)) {
        throw new IncompleteLinkedInInboxError("LinkedIn conversation participants missing");
      }
      if (participants.length > 2) continue; // Group conversations are outside one-to-one campaigns.
      if (participants.length !== 2) throw new IncompleteLinkedInInboxError("LinkedIn conversation participant count invalid");
      const other = participants.find((p) => participantUrn(p!) !== self)!;
      if (!other || participants.filter((p) => participantUrn(p!) === self).length !== 1) {
        throw new IncompleteLinkedInInboxError("LinkedIn conversation mailbox participant mismatch");
      }
      const profileUrl = participantProfile(other);
      if (!profileUrl) throw new IncompleteLinkedInInboxError("LinkedIn participant exact profile URL missing");
      events.push(...await scanMessages(page, urn, self, participantUrn(other)!, profileUrl));
    }
    const next = metadata.nextCursor;
    if (next === null || next === undefined || next === "") return events;
    if (typeof next !== "string" || seenCursors.has(next)) throw new IncompleteLinkedInInboxError("LinkedIn inbox cursor invalid or repeated");
    seenCursors.add(next);
    cursor = next;
  }
  throw new IncompleteLinkedInInboxError("LinkedIn inbox exceeded 100 pages");
}

async function scanMessages(page: Page, urn: string, self: string, other: string, profileUrl: string): Promise<Inbound[]> {
  const events: Inbound[] = [];
  const seen = new Set<string>();
  let before = Date.now();
  for (let pageNumber = 0; pageNumber < 100; pageNumber++) {
    const raw = await graphql(page, MESSAGES_QUERY, {
      deliveredAt: before,
      conversationUrn: urn,
      countBefore: PAGE_SIZE,
      countAfter: 0,
    });
    const { rows } = collection(raw, "messengerMessagesByConversation");
    if (!rows.length) return events;
    let oldest = Infinity;
    for (const message of rows) {
      const id = String(message.entityUrn ?? "");
      const deliveredAt = message.deliveredAt;
      const sender = participantUrn(object(message.sender) ?? {});
      if (!/^urn:li:msg_message:\(.+\)$/.test(id) || seen.has(id) ||
          typeof deliveredAt !== "number" || !Number.isFinite(deliveredAt) ||
          (sender !== self && sender !== other)) {
        throw new IncompleteLinkedInInboxError("LinkedIn message identity, time, or sender missing");
      }
      seen.add(id);
      oldest = Math.min(oldest, deliveredAt);
      if (sender === other) events.push({ profileUrl, eventId: id, sentAt: new Date(deliveredAt).toISOString() });
    }
    if (rows.length < PAGE_SIZE) return events;
    if (oldest >= before) throw new IncompleteLinkedInInboxError("LinkedIn message pagination did not advance");
    before = oldest;
  }
  throw new IncompleteLinkedInInboxError("LinkedIn thread exceeded 100 message pages");
}

/** Resolve provider message IDs for exact outbound text in this recipient's conversation. */
export async function outboundMessageIds(page: Page, profileUrl: string, text: string): Promise<Set<string>> {
  const self = await mailboxUrn(page);
  const seenCursors = new Set<string>();
  let cursor: string | undefined;
  let conversationUrn: string | null = null;
  for (let pageNumber = 0; pageNumber < 100; pageNumber++) {
    const raw = await graphql(page, CONVERSATIONS_QUERY, {
      query: { predicateUnions: [{ conversationCategoryPredicate: { category: "PRIMARY_INBOX" } }] },
      count: PAGE_SIZE,
      mailboxUrn: self,
      ...(cursor ? { nextCursor: cursor } : {}),
    });
    const { rows, metadata } = collection(raw, "messengerConversationsByCategoryQuery");
    for (const thread of rows) {
      const participants = Array.isArray(thread.conversationParticipants) ? thread.conversationParticipants.map(object) : null;
      if (!participants || participants.length !== 2 || participants.some((p) => !p)) continue;
      const other = participants.find((p) => participantUrn(p!) !== self);
      if (!other || participantProfile(other) !== profileUrl) continue;
      if (conversationUrn) throw new IncompleteLinkedInInboxError("Multiple conversations for recipient identity");
      const urn = String(thread.entityUrn ?? "");
      if (!/^urn:li:msg_conversation:\(.+\)$/.test(urn)) throw new IncompleteLinkedInInboxError("Conversation identity missing");
      conversationUrn = urn;
    }
    const next = metadata.nextCursor;
    if (next === null || next === undefined || next === "") break;
    if (typeof next !== "string" || seenCursors.has(next)) throw new IncompleteLinkedInInboxError("Inbox cursor invalid or repeated");
    seenCursors.add(next);
    cursor = next;
    if (pageNumber === 99) throw new IncompleteLinkedInInboxError("Inbox exceeded 100 pages");
  }
  if (!conversationUrn) return new Set();
  const raw = await graphql(page, MESSAGES_QUERY, {
    deliveredAt: Date.now(), conversationUrn, countBefore: 20, countAfter: 0,
  });
  const { rows } = collection(raw, "messengerMessagesByConversation");
  const result = new Set<string>();
  for (const message of rows) {
    const sender = participantUrn(object(message.sender) ?? {});
    if (sender !== self) continue;
    if (object(message.body)?.text !== text) continue;
    const id = String(message.entityUrn ?? "");
    if (!/^urn:li:msg_message:\(.+\)$/.test(id)) throw new IncompleteLinkedInInboxError("Outbound message has no provider ID");
    result.add(id);
  }
  return result;
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

/** Public-build reply sync; only a fully paged scan refreshes inbox state. */
export async function syncLinkedInInbox(db: Database.Database, accountId: string, page: Page): Promise<number> {
  initLinkedInInboxSchema(db);
  const startedAt = new Date().toISOString();
  try {
    const events = await scanInbox(page);
    const rows = db.prepare(`SELECT DISTINCT t.id, t.linkedin_url,
        (SELECT MIN(a.dispatched_at) FROM dispatch_actions a
         WHERE a.sender_id = ? AND a.target_id = t.id AND a.channel = 'message'
           AND a.state IN ('sending','confirmed','unknown')) AS first_sent_at
      FROM targets t JOIN run_profiles rp ON rp.target_id = t.id
      JOIN runs r ON r.id = rp.run_id
      WHERE r.account_id = ? AND t.linkedin_url IS NOT NULL`).all(accountId, accountId) as
      { id: string; linkedin_url: string; first_sent_at: string | null }[];
    let newReplies = 0;
    db.transaction(() => {
      for (const event of events) {
        const matches = rows.filter((row) => normalizedProfileUrl(row.linkedin_url) === event.profileUrl);
        if (matches.length > 1) throw new IncompleteLinkedInInboxError(`Ambiguous target identity: ${event.profileUrl}`);
        if (!matches.length) continue;
        const target = matches[0];
        if (!target.first_sent_at || !Number.isFinite(timestamp(target.first_sent_at)) ||
            timestamp(event.sentAt) <= timestamp(target.first_sent_at)) continue;
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
    })();
    return newReplies;
  } catch (error) {
    recordInboxSyncFailure(db, { accountId, channel: "linkedin", startedAt,
      error: error instanceof Error ? error.message : String(error) });
    throw error;
  }
}
