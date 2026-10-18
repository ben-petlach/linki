import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import Database from "better-sqlite3";
import { getDb } from "../../lib/db";

test("production start command rejects missing and placeholder secrets before server launch", () => {
  const badSecret = "synthetic-ci-secret-never-use-in-production";
  const badPassword = "test-password";
  const child = spawnSync(process.execPath, ["--import", "tsx", "scripts/start-server.mjs"], {
    cwd: process.cwd(), encoding: "utf8", timeout: 10_000,
    env: { ...process.env, NODE_ENV: "production", NEXTAUTH_SECRET: badSecret,
      AUTH_PASSWORD: badPassword, NEXTAUTH_URL: "http://example.test", LINKI_DISABLE_BACKGROUND: "1" },
  });
  assert.equal(child.status, 1, child.stderr);
  assert.match(child.stderr, /NEXTAUTH_SECRET/);
  assert.match(child.stderr, /AUTH_PASSWORD/);
  assert.match(child.stderr, /NEXTAUTH_URL/);
  assert.doesNotMatch(child.stderr, /test-password|synthetic-ci-secret-never-use-in-production/);
  assert.doesNotMatch(child.stderr, /Ready in|started server|listening/i);
});

test("offline backup and restore CLI preserve snapshot and leave restored dispatch paused", () => {
  const db = getDb();
  db.prepare("INSERT INTO targets (id, email) VALUES ('cli-original', 'original@example.test')").run();
  const directory = mkdtempSync(join(tmpdir(), "linki-cli-acceptance-"));
  const backupPath = join(directory, "backup.sqlite");
  const restoredPath = join(directory, "restored.sqlite");
  try {
    const backup = spawnSync(process.execPath,
      ["--import", "tsx", "scripts/backup-database.mjs", "--source", process.env.LINKI_DB_PATH!, "--output", backupPath],
      { cwd: process.cwd(), encoding: "utf8", timeout: 20_000 });
    assert.equal(backup.status, 0, backup.stderr);
    assert.equal(JSON.parse(backup.stdout).rows.targets, 1);
    db.prepare("INSERT INTO targets (id, email) VALUES ('cli-after-backup', 'after@example.test')").run();
    const restore = spawnSync(process.execPath,
      ["--import", "tsx", "scripts/restore-database.mjs", "--backup", backupPath, "--target", restoredPath],
      { cwd: process.cwd(), encoding: "utf8", timeout: 20_000 });
    assert.equal(restore.status, 0, restore.stderr);
    const restored = new Database(restoredPath);
    try {
      assert.equal(restored.prepare("SELECT 1 FROM targets WHERE id = 'cli-original'").get() !== undefined, true);
      assert.equal(restored.prepare("SELECT 1 FROM targets WHERE id = 'cli-after-backup'").get(), undefined);
      assert.equal((restored.prepare("SELECT paused FROM global_dispatch_control WHERE id = 1").get() as { paused: number }).paused, 1);
      assert.deepEqual(restored.pragma("foreign_key_check"), []);
    } finally { restored.close(); }
    const repeated = spawnSync(process.execPath,
      ["--import", "tsx", "scripts/restore-database.mjs", "--backup", backupPath, "--target", restoredPath],
      { cwd: process.cwd(), encoding: "utf8", timeout: 20_000 });
    assert.equal(repeated.status, 1);
    assert.match(repeated.stderr, /Target database already exists/);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
