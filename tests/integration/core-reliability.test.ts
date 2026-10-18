import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import Database from "better-sqlite3";
import { getDb } from "../../lib/db";
import { claimAction, beginDispatch, confirmAction, getAction, holdUnknown, actionKey } from "../../lib/reliability/actions";
import { getInboxFreshness, recordInboxSyncSuccess } from "../../lib/reliability/inbox-state";
import { getRelationship, initRelationshipSchema, isConnectedForAccount, recordConnectedEvidence } from "../../lib/reliability/relationships";
import { evaluateEligibility, suppressIdentity, suppressTarget } from "../../lib/reliability/suppression";
import { markOutboundAccepted, processInboundEmail, registerOutboundEmail } from "../../lib/email/inbox";
import { dispatchStep } from "../../lib/linkedin/runner";

const db = getDb();
const dbPath = process.env.LINKI_DB_PATH!;
db.prepare("INSERT INTO accounts (id, name, email) VALUES (?, ?, ?)").run("ben", "Ben", "ben@example.test");
db.prepare("INSERT INTO accounts (id, name, email) VALUES (?, ?, ?)").run("philipp", "Philipp", "philipp@example.test");
db.prepare(`INSERT INTO targets (id, linkedin_url, email, degree, connected_at, connection_requested_at)
  VALUES (?, ?, ?, ?, ?, ?)`).run("alex", "https://www.linkedin.com/in/alex/", "alex@example.test", 1,
  "2025-12-01", "2025-11-01");
initRelationshipSchema(db);

function rowCount(connection: Database.Database, table: string): number {
  return (connection.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number }).count;
}

function eligibilityGate(connection: Database.Database, senderId: string, targetId: string, channel: "email" | "linkedin"): string | null {
  const exclusion = evaluateEligibility(connection, targetId, { channel });
  if (!exclusion.allowed) return exclusion.blocks[0].reason;
  const inbox = getInboxFreshness(connection, {
    accountId: senderId,
    channel,
    maxAgeMs: 3 * 60 * 60 * 1000,
  });
  return inbox.fresh ? null : inbox.reason;
}

test("getDb creates reliability schema and preserves sender-scoped evidence across two reopens", () => {
  assert.equal((db.pragma("foreign_keys", { simple: true }) as number), 1);
  for (const table of ["account_relationships", "legacy_relationship_audit", "inbox_sync_state", "dispatch_actions", "suppression_rules", "email_outbound"]) {
    assert.ok(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table), `${table} must exist on fresh getDb()`);
  }
  recordConnectedEvidence(db, { accountId: "ben", targetId: "alex", connectedAt: "2026-01-01", source: "verified-sync" });
  assert.equal(isConnectedForAccount(db, "philipp", "alex"), false);

  for (let reopen = 0; reopen < 2; reopen++) {
    const connection = new Database(dbPath);
    connection.pragma("foreign_keys = ON");
    assert.equal((connection.pragma("foreign_key_check") as unknown[]).length, 0);
    assert.equal(getRelationship(connection, "ben", "alex")?.source, "verified-sync");
    assert.equal(getRelationship(connection, "philipp", "alex"), null);
    assert.equal(rowCount(connection, "legacy_relationship_audit"), 1);
    assert.equal(rowCount(connection, "account_relationships"), 1);
    connection.close();
  }
});

test("reply after accepted email blocks both channels and senders, including after restart", async () => {
  db.prepare(`INSERT INTO email_accounts (id, name, from_email, smtp_host, username, password)
    VALUES (?, ?, ?, ?, ?, ?)`).run("ben-mail", "Ben mailbox", "ben@example.test", "localhost", "ben", "fixture");
  const now = new Date().toISOString();
  recordInboxSyncSuccess(db, { accountId: "ben-mail", channel: "email", completedAt: now });
  recordInboxSyncSuccess(db, { accountId: "ben", channel: "linkedin", completedAt: now });
  recordInboxSyncSuccess(db, { accountId: "philipp", channel: "linkedin", completedAt: now });

  const emailKey = actionKey("ben-email-track", "email-one");
  const emailClaim = claimAction(db, { key: emailKey, senderId: "ben-mail", targetId: "alex", channel: "email" });
  assert.equal(emailClaim.claimed, true);
  if (!emailClaim.claimed) return;
  assert.deepEqual(beginDispatch(db, emailKey, emailClaim.token,
    () => eligibilityGate(db, "ben-mail", "alex", "email")), { started: true });
  registerOutboundEmail(db, { actionKey: emailKey, targetId: "alex", emailAccountId: "ben-mail",
    recipient: "alex@example.test", messageId: "<outbound-1@example.test>", subject: "Hello" });
  markOutboundAccepted(db, emailKey, "2026-01-01T12:00:00.000Z");
  assert.equal(confirmAction(db, emailKey, emailClaim.token, "local SMTP fixture accepted outbound-1"), true);

  const nextKey = actionKey("philipp-linkedin-track", "message-two");
  const nextClaim = claimAction(db, { key: nextKey, senderId: "philipp", targetId: "alex", channel: "linkedin" });
  assert.equal(nextClaim.claimed, true);
  if (!nextClaim.claimed) return;
  assert.equal(isConnectedForAccount(db, "philipp", "alex"), false);
  const rawReply = [
    "From: Alex <alex@example.test>",
    "To: Ben <ben@example.test>",
    "Message-ID: <reply-1@example.test>",
    "In-Reply-To: <outbound-1@example.test>",
    "Date: Fri, 02 Jan 2026 12:00:00 +0000",
    "Subject: Re: Hello",
    "Content-Type: text/plain; charset=utf-8",
    "",
    "Please stop contacting me.",
  ].join("\r\n");
  assert.equal(await processInboundEmail(db, "ben-mail", rawReply), "reply");
  assert.equal(await processInboundEmail(db, "ben-mail", rawReply), "duplicate");
  assert.equal(rowCount(db, "email_replies"), 1);
  assert.equal(beginDispatch(db, nextKey, nextClaim.token,
    () => eligibilityGate(db, "philipp", "alex", "linkedin")).reason, "inbound_reply");
  assert.equal(getAction(db, nextKey)?.state, "claimed");

  const reopened = new Database(dbPath);
  reopened.pragma("foreign_keys = ON");
  assert.equal((reopened.pragma("foreign_key_check") as unknown[]).length, 0);
  assert.equal(getAction(reopened, emailKey)?.state, "confirmed");
  assert.equal(evaluateEligibility(reopened, "alex", { channel: "email" }).allowed, false);
  assert.equal(evaluateEligibility(reopened, "alex", { channel: "linkedin" }).allowed, false);
  assert.equal(isConnectedForAccount(reopened, "ben", "alex"), true);
  assert.equal(isConnectedForAccount(reopened, "philipp", "alex"), false);
  reopened.close();
});

test("competing workers, expired claims, unknown outcome, and late suppression stay durable", () => {
  db.prepare("INSERT INTO companies (id, name, domain) VALUES (?, ?, ?)").run("company-one", "Blocked", "blocked.test");
  db.prepare("INSERT INTO targets (id, linkedin_url, email, company_id) VALUES (?, ?, ?, ?)")
    .run("maya", "https://www.linkedin.com/in/maya/", "maya@blocked.test", "company-one");
  const second = new Database(dbPath);
  second.pragma("foreign_keys = ON");
  const key = actionKey("ben-linkedin-track", "message-three");
  const first = claimAction(db, { key, senderId: "ben", targetId: "maya", channel: "linkedin", now: 1000, leaseMs: 100 });
  assert.equal(first.claimed, true);
  if (!first.claimed) return;
  assert.equal(claimAction(second, { key, senderId: "ben", targetId: "maya", channel: "linkedin", now: 1050 }).claimed, false);
  const replacement = claimAction(second, { key, senderId: "ben", targetId: "maya", channel: "linkedin", now: 1101 });
  assert.equal(replacement.claimed, true);
  if (!replacement.claimed) return;
  assert.equal(beginDispatch(db, key, first.token, () => null, 1102).started, false);
  suppressIdentity(second, { kind: "company_domain", value: "blocked.test", reason: "company_excluded" });
  assert.equal(beginDispatch(second, key, replacement.token,
    () => evaluateEligibility(second, "maya", { channel: "linkedin" }).blocks[0]?.reason ?? null, 1102).started, false);
  assert.equal(getAction(second, key)?.state, "claimed");

  const unknownKey = actionKey("ben-linkedin-track", "message-four");
  const uncertain = claimAction(second, { key: unknownKey, senderId: "ben", targetId: "maya", channel: "linkedin", now: 2000 });
  assert.equal(uncertain.claimed, true);
  if (!uncertain.claimed) return;
  assert.equal(beginDispatch(second, unknownKey, uncertain.token, () => null, 2001).started, true);
  assert.equal(holdUnknown(second, unknownKey, uncertain.token, "provider acceptance unconfirmed"), true);
  second.close();
  const restarted = new Database(dbPath);
  assert.deepEqual(claimAction(restarted, { key: unknownKey, senderId: "ben", targetId: "maya", channel: "linkedin", now: 999999 }),
    { claimed: false, state: "unknown", reason: "provider acceptance unconfirmed" });
  assert.equal((restarted.pragma("foreign_key_check") as unknown[]).length, 0);
  restarted.close();
});

test("legacy global relationship snapshot migrates on two independent starts without changing history", async () => {
  const directory = mkdtempSync(join(tmpdir(), "linki-legacy-integration-"));
  const legacyPath = join(directory, "legacy.db");
  try {
    await db.backup(legacyPath);
    const legacy = new Database(legacyPath);
    legacy.pragma("foreign_keys = OFF");
    for (const table of ["account_relationships", "account_target_state", "legacy_relationship_audit",
      "connection_sync_state", "inbox_sync_state", "dispatch_actions", "suppression_rules", "email_outbound", "email_inbound"]) {
      legacy.exec(`DROP TABLE IF EXISTS ${table}`);
    }
    legacy.pragma("foreign_keys = ON");
    assert.equal((legacy.pragma("foreign_key_check") as unknown[]).length, 0);
    legacy.close();
    const program = `import { getDb } from './lib/db.ts';
      const db = getDb();
      const count = name => db.prepare('SELECT COUNT(*) AS count FROM ' + name).get().count;
      if (db.pragma('foreign_key_check').length) throw Error('foreign key failure');
      if (count('legacy_relationship_audit') < 1) throw Error('legacy history lost');
      if (count('account_relationships') !== 0) throw Error('ambiguous relationship gained sender');
      console.log(JSON.stringify({audit: count('legacy_relationship_audit'), relationships: count('account_relationships')}));`;
    for (let start = 0; start < 2; start++) {
      const child = spawnSync(process.execPath, ["--import", "tsx", "--eval", program], {
        cwd: process.cwd(),
        env: { ...process.env, LINKI_DB_PATH: legacyPath, LINKI_DISABLE_BACKGROUND: "1" },
        encoding: "utf8",
      });
      assert.equal(child.status, 0, child.stderr);
      assert.deepEqual(JSON.parse(child.stdout.trim()), { audit: 1, relationships: 0 });
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("production dispatch gate stops a reply race and holds uncertain provider outcome", async () => {
  db.prepare("UPDATE accounts SET is_authenticated = 1 WHERE id = 'ben'").run();
  db.prepare("INSERT INTO targets (id, linkedin_url, email) VALUES (?, ?, ?)")
    .run("jules", "https://www.linkedin.com/in/jules/", "jules@example.test");
  db.prepare("INSERT INTO targets (id, linkedin_url, email) VALUES (?, ?, ?)")
    .run("robin", "https://www.linkedin.com/in/robin/", "robin@example.test");
  db.prepare("INSERT INTO workflows (id, name) VALUES (?, ?)").run("integration-workflow", "Fixture");
  db.prepare("INSERT INTO workflow_steps (id, workflow_id, step_order, step_type) VALUES (?, ?, ?, ?)")
    .run("integration-step", "integration-workflow", 1, "connect");
  db.prepare("INSERT INTO runs (id, workflow_id, account_id, status) VALUES (?, ?, ?, ?)")
    .run("integration-run", "integration-workflow", "ben", "running");
  for (const targetId of ["jules", "robin"]) {
    db.prepare("INSERT INTO run_profiles (id, run_id, target_id) VALUES (?, ?, ?)")
      .run(`${targetId}-profile`, "integration-run", targetId);
    db.prepare(`INSERT INTO run_profile_tracks (id, run_profile_id, track, state, current_step)
      VALUES (?, ?, 'linkedin', 'in_progress', 0)`).run(`${targetId}-track`, `${targetId}-profile`);
  }
  recordInboxSyncSuccess(db, { accountId: "ben", channel: "linkedin", completedAt: new Date().toISOString() });
  const schedule = { active_hours_start: 0, active_hours_end: 24, timezone: "UTC", working_days: "1,2,3,4,5,6,7" };
  const step = { id: "integration-step" } as Parameters<typeof dispatchStep>[2];
  let providerCalls = 0;
  const julesTrack = { id: "jules-track", run_profile_id: "jules-profile", run_id: "integration-run", current_step: 0 } as Parameters<typeof dispatchStep>[1];
  const race = await dispatchStep(db, julesTrack, step, { id: "jules" } as Parameters<typeof dispatchStep>[3],
    "ben", "connect", 10, schedule, "fixture", "https://www.linkedin.com/in/jules/", async beforeSend => {
      suppressTarget(db, "jules", "inbound_reply", "fixture-reply");
      beforeSend();
      providerCalls++;
      return { acknowledgement: "fixture-accepted" };
    }, result => result.acknowledgement);
  assert.equal(race, "deferred");
  assert.equal(providerCalls, 0);
  assert.equal(getAction(db, actionKey("jules-track", "integration-step")), undefined);

  const robinTrack = { id: "robin-track", run_profile_id: "robin-profile", run_id: "integration-run", current_step: 0 } as Parameters<typeof dispatchStep>[1];
  const uncertain = await dispatchStep(db, robinTrack, step, { id: "robin" } as Parameters<typeof dispatchStep>[3],
    "ben", "connect", 10, schedule, "fixture", "https://www.linkedin.com/in/robin/", async beforeSend => {
      beforeSend();
      providerCalls++;
      throw new Error("provider response lost");
    }, () => "fixture-accepted");
  assert.equal(uncertain, "held", (db.prepare("SELECT error_message FROM run_profile_tracks WHERE id = 'robin-track'").get() as { error_message: string }).error_message);
  assert.equal(providerCalls, 1);
  assert.equal(getAction(db, actionKey("robin-track", "integration-step"))?.state, "unknown");
  const retry = await dispatchStep(db, robinTrack, step, { id: "robin" } as Parameters<typeof dispatchStep>[3],
    "ben", "connect", 10, schedule, "fixture", "https://www.linkedin.com/in/robin/", async () => {
      providerCalls++;
      return { acknowledgement: "duplicate" };
    }, result => result.acknowledgement);
  assert.equal(retry, "held");
  assert.equal(providerCalls, 1);

  for (const targetId of ["eli", "faye", "gail", "dana"]) {
    db.prepare("INSERT INTO targets (id, linkedin_url, email) VALUES (?, ?, ?)")
      .run(targetId, `https://www.linkedin.com/in/${targetId}/`, `${targetId}@example.test`);
    db.prepare("INSERT INTO run_profiles (id, run_id, target_id, email_account_id) VALUES (?, ?, ?, ?)")
      .run(`${targetId}-profile`, "integration-run", targetId, targetId === "dana" ? "ben-mail" : null);
    db.prepare(`INSERT INTO run_profile_tracks (id, run_profile_id, track, state, current_step)
      VALUES (?, ?, ?, 'in_progress', 0)`).run(`${targetId}-track`, `${targetId}-profile`, targetId === "dana" ? "email" : "linkedin");
  }
  const track = (id: string) => ({ id: `${id}-track`, run_profile_id: `${id}-profile`, run_id: "integration-run", current_step: 0 }) as Parameters<typeof dispatchStep>[1];
  const target = (id: string) => ({ id }) as Parameters<typeof dispatchStep>[3];

  const excluded = await dispatchStep(db, track("eli"), step, target("eli"), "ben", "connect", 10,
    schedule, "fixture", "https://www.linkedin.com/in/eli/", async beforeSend => {
      suppressIdentity(db, { kind: "linkedin", value: "https://www.linkedin.com/in/eli/",
        reason: "company_already_contacted", scope: "net_new" });
      beforeSend();
      providerCalls++;
      return { acknowledgement: "unexpected" };
    }, result => result.acknowledgement);
  assert.equal(excluded, "deferred");
  assert.equal(providerCalls, 1);
  assert.match((db.prepare("SELECT error_message FROM run_profile_tracks WHERE id = 'eli-track'").get() as { error_message: string }).error_message,
    /company_already_contacted/);

  db.prepare("UPDATE email_accounts SET is_verified = 1 WHERE id = 'ben-mail'").run();
  recordInboxSyncSuccess(db, { accountId: "ben-mail", channel: "email", completedAt: new Date().toISOString() });
  const changedRecipient = await dispatchStep(db, track("dana"), step, target("dana"), "ben-mail", "email", 10,
    schedule, "fixture", "dana@example.test", async beforeSend => {
      db.prepare("UPDATE targets SET email = 'dana-new@example.test' WHERE id = 'dana'").run();
      suppressIdentity(db, { kind: "email", value: "dana@example.test", reason: "old_address_excluded" });
      beforeSend();
      providerCalls++;
      return { acknowledgement: "unexpected" };
    }, result => result.acknowledgement);
  assert.equal(changedRecipient, "deferred");
  assert.equal(providerCalls, 1);
  assert.match((db.prepare("SELECT error_message FROM run_profile_tracks WHERE id = 'dana-track'").get() as { error_message: string }).error_message,
    /recipient identity changed/);

  const changedSender = await dispatchStep(db, track("faye"), step, target("faye"), "ben", "connect", 10,
    schedule, "fixture", "https://www.linkedin.com/in/faye/", async beforeSend => {
      db.prepare("UPDATE accounts SET email = 'changed@example.test' WHERE id = 'ben'").run();
      beforeSend();
      providerCalls++;
      return { acknowledgement: "unexpected" };
    }, result => result.acknowledgement);
  assert.equal(changedSender, "deferred");
  assert.equal(providerCalls, 1);
  assert.match((db.prepare("SELECT error_message FROM run_profile_tracks WHERE id = 'faye-track'").get() as { error_message: string }).error_message,
    /LinkedIn sender changed/);
  db.prepare("UPDATE accounts SET email = 'ben@example.test' WHERE id = 'ben'").run();

  const accepted = await dispatchStep(db, track("gail"), step, target("gail"), "ben", "connect", 10,
    schedule, "fixture", "https://www.linkedin.com/in/gail/", async beforeSend => {
      beforeSend();
      providerCalls++;
      return { acknowledgement: "fixture acceptance" };
    }, result => result.acknowledgement);
  assert.equal(accepted, "sent");
  assert.equal(providerCalls, 2);
  assert.equal(getAction(db, actionKey("gail-track", "integration-step"))?.state, "confirmed");
});
