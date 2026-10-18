import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import {
  initRelationshipSchema, getRelationship, isConnectedForAccount,
  recordConnectionRequested, getConnectionRequestedAt,
  recordMessagingIdentity, getMessagingIdentity,
} from "../../lib/reliability/relationships";
import { initInboxStateSchema, recordInboxSyncSuccess, recordInboxSyncFailure, getInboxFreshness } from "../../lib/reliability/inbox-state";
import { syncAcceptedFromProvider, type ApiConnection, type ConnectionProvider } from "../../lib/linkedin/sync-accepted";

function database() {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE accounts (id TEXT PRIMARY KEY, accepted_sync_at TEXT,
      connections_synced_through_ms INTEGER, li_connections INTEGER);
    CREATE TABLE targets (id TEXT PRIMARY KEY, linkedin_url TEXT,
      degree INTEGER, connected_at TEXT, connection_requested_at TEXT);
    INSERT INTO accounts (id) VALUES ('ben'), ('philipp');
    INSERT INTO targets (id, linkedin_url, degree, connected_at, connection_requested_at)
      VALUES ('one', 'https://www.linkedin.com/in/alex/', 1, '2026-01-01', '2025-12-01'),
        ('two', 'https://www.linkedin.com/in/alex-other/', NULL, NULL, '2025-12-01');
  `);
  return db;
}

function provider(connections: ApiConnection[], total = connections.length): ConnectionProvider {
  return {
    getDeclaredTotal: async () => total,
    getPage: async (start) => start === 0 ? connections : [],
  };
}

const alex = { profileId: "urn:li:member:1", vanity: "alex", createdAt: 1700000000000 };

test("legacy global state stays audit only; two senders remain independent", async () => {
  const db = database();
  initRelationshipSchema(db);
  initRelationshipSchema(db);
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM legacy_relationship_audit").get() as { n: number }).n, 2);
  assert.equal(isConnectedForAccount(db, "ben", "one"), false);
  await syncAcceptedFromProvider(db, "ben", provider([alex]));
  assert.equal(isConnectedForAccount(db, "ben", "one"), true);
  assert.equal(isConnectedForAccount(db, "philipp", "one"), false);
  assert.equal(isConnectedForAccount(db, "ben", "two"), false);
  await syncAcceptedFromProvider(db, "philipp", provider([]));
  assert.equal(isConnectedForAccount(db, "ben", "one"), true);
  assert.equal(isConnectedForAccount(db, "philipp", "one"), false);
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM account_relationships").get() as { n: number }).n, 1);
  db.close();
});

test("absent invitation and incomplete page cannot imply acceptance or advance success", async () => {
  const db = database();
  await assert.rejects(syncAcceptedFromProvider(db, "ben", provider([], 1)), /Incomplete connections pass/);
  assert.equal(getRelationship(db, "ben", "one"), null);
  assert.equal((db.prepare("SELECT accepted_sync_at FROM accounts WHERE id='ben'").get() as { accepted_sync_at: string | null }).accepted_sync_at, null);
  await syncAcceptedFromProvider(db, "ben", provider([alex]));
  const before = getRelationship(db, "ben", "one");
  await assert.rejects(syncAcceptedFromProvider(db, "ben", {
    getDeclaredTotal: async () => 2,
    getPage: async (start) => start === 0 ? [alex] : null,
  }), /Connections API failed/);
  assert.deepEqual(getRelationship(db, "ben", "one"), before);
  db.close();
});

test("repeat complete sync keeps one account relationship; exact vanity avoids substring match", async () => {
  const db = database();
  await syncAcceptedFromProvider(db, "ben", provider([alex]));
  await syncAcceptedFromProvider(db, "ben", provider([alex]));
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM account_relationships").get() as { n: number }).n, 1);
  assert.equal(isConnectedForAccount(db, "ben", "two"), false);
  db.close();
});

test("inbox failure blocks freshness until complete success", () => {
  const db = database();
  initInboxStateSchema(db);
  const now = new Date("2026-10-17T12:00:00Z");
  const query = () => getInboxFreshness(db, { accountId: "ben", channel: "linkedin", maxAgeMs: 3600000, now });
  assert.equal(query().reason, "never_synced");
  recordInboxSyncSuccess(db, { accountId: "ben", channel: "linkedin", completedAt: "2026-10-17T11:30:00Z" });
  assert.equal(query().fresh, true);
  recordInboxSyncFailure(db, { accountId: "ben", channel: "linkedin", error: "partial page", failedAt: "2026-10-17T11:45:00Z" });
  assert.equal(query().reason, "sync_failed");
  assert.equal(getInboxFreshness(db, { accountId: "philipp", channel: "linkedin", maxAgeMs: 3600000, now }).reason, "never_synced");
  recordInboxSyncSuccess(db, { accountId: "ben", channel: "linkedin", completedAt: "2026-10-17T11:50:00Z" });
  assert.equal(query().fresh, true);
  db.close();
});

test("invitation and messaging identities stay with their sender", () => {
  const db = database();
  initRelationshipSchema(db);
  recordConnectionRequested(db, { accountId: "ben", targetId: "one", requestedAt: "2026-10-17T10:00:00Z" });
  recordMessagingIdentity(db, { accountId: "ben", targetId: "one", messagingUrn: "urn:ben:alex" });
  assert.equal(getConnectionRequestedAt(db, "philipp", "one"), null);
  assert.equal(getMessagingIdentity(db, "philipp", "one"), null);
  assert.equal(getConnectionRequestedAt(db, "ben", "one"), "2026-10-17T10:00:00Z");
  assert.equal(getMessagingIdentity(db, "ben", "one"), "urn:ben:alex");
  db.close();
});

test("older inbox scan cannot clear newer failure; future timestamp blocks", () => {
  const db = database();
  initInboxStateSchema(db);
  const base = { accountId: "ben", channel: "email" as const };
  recordInboxSyncFailure(db, { ...base, startedAt: "2026-10-17T11:30:00Z", failedAt: "2026-10-17T11:40:00Z", error: "partial" });
  recordInboxSyncFailure(db, { ...base, startedAt: "2026-10-17T11:10:00Z", failedAt: "2026-10-17T11:45:00Z", error: "older scan" });
  recordInboxSyncSuccess(db, { ...base, startedAt: "2026-10-17T11:20:00Z", completedAt: "2026-10-17T11:48:00Z" });
  assert.equal(getInboxFreshness(db, { ...base, maxAgeMs: 3600000,
    now: new Date("2026-10-17T12:00:00Z") }).reason, "sync_failed");
  recordInboxSyncSuccess(db, { ...base, startedAt: "2026-10-17T11:00:00Z", completedAt: "2026-10-17T11:50:00Z" });
  const freshness = () => getInboxFreshness(db, { ...base, maxAgeMs: 3600000, now: new Date("2026-10-17T12:00:00Z") });
  assert.equal(freshness().reason, "sync_failed");
  recordInboxSyncSuccess(db, { ...base, startedAt: "2026-10-17T11:55:00Z", completedAt: "2026-10-17T12:00:00Z" });
  assert.equal(freshness().fresh, true);
  recordInboxSyncSuccess(db, { ...base, startedAt: "2026-10-17T12:05:00Z", completedAt: "2026-10-17T12:05:00Z" });
  assert.equal(freshness().reason, "future_sync_time");
  db.close();
});

test("migration survives two reopens without changing legacy audit or FK integrity", () => {
  const directory = mkdtempSync(join(tmpdir(), "linki-state-"));
  const path = join(directory, "state.db");
  try {
    const first = new Database(path);
    first.pragma("foreign_keys = ON");
    first.exec(`CREATE TABLE accounts (id TEXT PRIMARY KEY);
      CREATE TABLE targets (id TEXT PRIMARY KEY, degree INTEGER, connected_at TEXT, connection_requested_at TEXT);
      INSERT INTO accounts VALUES ('ben');
      INSERT INTO targets VALUES ('one', 1, '2026-01-01', '2025-12-01');`);
    initRelationshipSchema(first);
    first.close();
    for (let reopen = 0; reopen < 2; reopen++) {
      const db = new Database(path);
      db.pragma("foreign_keys = ON");
      initRelationshipSchema(db);
      assert.equal((db.prepare("SELECT COUNT(*) AS n FROM legacy_relationship_audit").get() as { n: number }).n, 1);
      assert.equal((db.prepare("SELECT COUNT(*) AS n FROM account_relationships").get() as { n: number }).n, 0);
      assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(), []);
      db.close();
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
