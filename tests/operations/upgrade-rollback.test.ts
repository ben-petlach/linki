import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import Database from "better-sqlite3";
import { getDb } from "../../lib/db";
import { backupDatabase, restoreDatabase } from "../../lib/reliability/backup";
import { beginDispatch, claimAction, confirmAction, holdUnknown } from "../../lib/reliability/actions";
import { suppressIdentity } from "../../lib/reliability/suppression";

function boot(path: string, script: string): string {
  const child = spawnSync(process.execPath, ["--import", "tsx", "--eval", script], {
    cwd: process.cwd(), encoding: "utf8", timeout: 20_000,
    env: { ...process.env, LINKI_DB_PATH: path, LINKI_DISABLE_BACKGROUND: "1" },
  });
  assert.equal(child.status, 0, child.stderr);
  return child.stdout.trim();
}

test("actual schema upgrade and offline rollback preserve action states and restore a no-send pause", async () => {
  const source = getDb();
  const directory = mkdtempSync(join(tmpdir(), "linki-upgrade-acceptance-"));
  const preUpgrade = join(directory, "pre-upgrade.sqlite");
  const snapshot = join(directory, "offline-snapshot.sqlite");
  const restored = join(directory, "rolled-back.sqlite");
  try {
    source.prepare("INSERT INTO accounts (id, name, email, is_authenticated) VALUES ('upgrade-li', 'Fixture', 'upgrade-li@example.test', 0)").run();
    source.prepare(`INSERT INTO email_accounts (id, name, from_email, smtp_host, username, password)
      VALUES ('upgrade-mail', 'Fixture', 'upgrade-mail@example.test', 'localhost', 'fixture', 'encrypted-fixture')`).run();
    source.prepare("INSERT INTO targets (id, email) VALUES ('upgrade-target', 'target@example.test')").run();
    source.prepare("INSERT INTO workflows (id, name) VALUES ('upgrade-flow', 'Fixture')").run();
    source.prepare(`INSERT INTO workflow_steps (id, workflow_id, step_order, step_type, track, email_subject, email_body)
      VALUES ('upgrade-step', 'upgrade-flow', 1, 'email', 'email', 'Fixture', 'Synthetic')`).run();
    source.prepare(`INSERT INTO runs (id, workflow_id, account_id, email_account_id, status)
      VALUES ('upgrade-run', 'upgrade-flow', 'upgrade-li', 'upgrade-mail', 'running')`).run();
    source.prepare(`INSERT INTO run_profiles (id, run_id, target_id, email_account_id)
      VALUES ('upgrade-profile', 'upgrade-run', 'upgrade-target', 'upgrade-mail')`).run();
    source.prepare(`INSERT INTO run_profile_tracks (id, run_profile_id, track, state, current_step)
      VALUES ('upgrade-track', 'upgrade-profile', 'email', 'in_progress', 0)`).run();
    suppressIdentity(source, { kind: "email", value: "target@example.test", reason: "fixture_opt_out" });
    for (const [key, state] of [["upgrade-confirmed", "confirmed"], ["upgrade-unknown", "unknown"]] as const) {
      const claim = claimAction(source, { key, senderId: "upgrade-mail", targetId: "upgrade-target", channel: "email" });
      assert.equal(claim.claimed, true);
      if (!claim.claimed) continue;
      assert.equal(beginDispatch(source, key, claim.token, () => null).started, true);
      assert.equal(state === "confirmed"
        ? confirmAction(source, key, claim.token, "synthetic provider acceptance")
        : holdUnknown(source, key, claim.token, "synthetic acknowledgement lost"), true);
    }
    await source.backup(preUpgrade);
    const old = new Database(preUpgrade);
    try {
      old.exec(`DROP TABLE scheduler_poll_state;
        DROP TABLE provider_sender_holds;
        DROP TABLE provider_sender_events;
        DROP TABLE operation_alerts;
        DROP TABLE operation_worker_health;
        DROP TABLE operation_audit;
        DROP TABLE global_dispatch_control;`);
      assert.deepEqual(old.pragma("foreign_key_check"), []);
      assert.equal(old.prepare("SELECT 1 FROM sqlite_master WHERE name = 'scheduler_poll_state'").get(), undefined);
    } finally { old.close(); }
    const saved = await backupDatabase(preUpgrade, snapshot);
    assert.equal(saved.rows.dispatch_actions, 2);

    // Boot the production initializer in a fresh process against the older snapshot.
    const upgraded = JSON.parse(boot(preUpgrade, `
      const { getDb } = require('./lib/db.ts');
      const db = getDb();
      const tables = ['scheduler_poll_state', 'provider_sender_holds', 'global_dispatch_control']
        .map(name => Boolean(db.prepare('SELECT 1 FROM sqlite_master WHERE name = ?').get(name)));
      const actions = db.prepare('SELECT action_key, state FROM dispatch_actions ORDER BY action_key').all();
      console.log(JSON.stringify({ tables, actions, run: db.prepare("SELECT status FROM runs WHERE id = 'upgrade-run'").get().status }));
    `));
    assert.deepEqual(upgraded.tables, [true, true, true]);
    assert.deepEqual(upgraded.actions, [
      { action_key: "upgrade-confirmed", state: "confirmed" },
      { action_key: "upgrade-unknown", state: "unknown" },
    ]);
    assert.equal(upgraded.run, "running");

    const changed = new Database(preUpgrade);
    try { changed.prepare("INSERT INTO targets (id, email) VALUES ('post-upgrade-only', 'later@example.test')").run(); }
    finally { changed.close(); }
    await restoreDatabase(snapshot, restored);
    const rolledBack = JSON.parse(boot(restored, `
      (async () => {
        const { getDb } = require('./lib/db.ts');
        const { tick } = require('./lib/linkedin/runner.ts');
        const db = getDb();
        let sends = 0;
        await tick(db, { now: () => new Date('2026-10-18T12:00:00Z'),
          executeStep: async () => { sends++; },
          syncEmailInbox: async () => { throw new Error('unexpected IMAP poll'); },
          syncLinkedInInbox: async () => { throw new Error('unexpected LinkedIn poll'); },
          syncAcceptedConnections: async () => { throw new Error('unexpected connection poll'); } });
        console.log(JSON.stringify({ sends,
          run: db.prepare("SELECT status FROM runs WHERE id = 'upgrade-run'").get().status,
          paused: db.prepare('SELECT paused FROM global_dispatch_control WHERE id = 1').get().paused,
          actions: db.prepare('SELECT action_key, state FROM dispatch_actions ORDER BY action_key').all(),
          suppression: db.prepare("SELECT COUNT(*) AS count FROM suppression_rules WHERE value = 'target@example.test'").get().count,
          later: Boolean(db.prepare("SELECT 1 FROM targets WHERE id = 'post-upgrade-only'").get()),
          schema: Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'scheduler_poll_state'").get()),
          foreignKeys: db.pragma('foreign_key_check') }));
      })().catch(error => { console.error(error); process.exitCode = 1; });
    `));
    assert.equal(rolledBack.sends, 0);
    assert.equal(rolledBack.run, "paused");
    assert.equal(rolledBack.paused, 1);
    assert.deepEqual(rolledBack.actions, upgraded.actions);
    assert.equal(rolledBack.suppression, 1);
    assert.equal(rolledBack.later, false);
    assert.equal(rolledBack.schema, true);
    assert.deepEqual(rolledBack.foreignKeys, []);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
