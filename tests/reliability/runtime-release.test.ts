import assert from "node:assert/strict";
import { test } from "node:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import Database from "better-sqlite3";
import { getDb } from "../../lib/db";
import { backupDatabase, restoreDatabase } from "../../lib/reliability/backup";
import { validateProductionRuntime } from "../../lib/runtime-config";
import { decryptSecret, encryptSecret } from "../../lib/crypto";

test("startup rejects missing and placeholder credentials without echoing values", () => {
  const invalid = validateProductionRuntime({ NODE_ENV: "production", NEXTAUTH_SECRET: "changeme", AUTH_PASSWORD: "test-password", NEXTAUTH_URL: "http://example.com" });
  assert.match(invalid.join(" "), /NEXTAUTH_SECRET/);
  assert.match(invalid.join(" "), /AUTH_PASSWORD/);
  assert.match(invalid.join(" "), /NEXTAUTH_URL/);
  assert.doesNotMatch(invalid.join(" "), /changeme|test-password/);
  assert.deepEqual(validateProductionRuntime({
    NODE_ENV: "production",
    NEXTAUTH_SECRET: "a-long-random-looking-runtime-secret-12345",
    AUTH_PASSWORD: "a-long-private-password-12345",
    NEXTAUTH_URL: "http://localhost:3456",
    LINKI_DB_PATH: "/data/linki.db",
  }), []);
});

test("startup validation uses isolated cwd without inheriting repo env files", () => {
  const directory = mkdtempSync(path.join(tmpdir(), "linki-startup-test-"));
  try {
    const require = createRequire(import.meta.url);
    const tsxLoader = require.resolve("tsx");
    const env = { ...process.env };
    delete env.NEXTAUTH_SECRET;
    delete env.AUTH_PASSWORD;
    delete env.NEXTAUTH_URL;
    const result = spawnSync(process.execPath, ["--import", tsxLoader, path.resolve("scripts/start-server.mjs")], {
      cwd: directory, env, encoding: "utf8", timeout: 5000,
    });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Production configuration invalid: NEXTAUTH_SECRET/);
    assert.match(result.stderr, /AUTH_PASSWORD/);
    assert.match(result.stderr, /NEXTAUTH_URL/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("Next env loader reads local production credentials before validation", () => {
  const directory = mkdtempSync(path.join(tmpdir(), "linki-env-test-"));
  try {
    writeFileSync(path.join(directory, ".env.local"), [
      "NEXTAUTH_SECRET=synthetic-local-secret-123456789012345",
      "AUTH_PASSWORD=synthetic-local-password-123456",
      "NEXTAUTH_URL=http://localhost:3456",
    ].join("\n"));
    const require = createRequire(import.meta.url);
    const modulePath = require.resolve("@next/env");
    const env = { ...process.env };
    delete env.NEXTAUTH_SECRET;
    delete env.AUTH_PASSWORD;
    delete env.NEXTAUTH_URL;
    const script = "require(process.argv[1]).loadEnvConfig(process.cwd(), false); if (!process.env.NEXTAUTH_SECRET || !process.env.AUTH_PASSWORD || !process.env.NEXTAUTH_URL) process.exit(2)";
    const result = spawnSync(process.execPath, ["-e", script, modulePath], { cwd: directory, env, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("invalid SQLite backup is removed after failed validation", async () => {
  const directory = mkdtempSync(path.join(tmpdir(), "linki-invalid-backup-test-"));
  try {
    const source = path.join(directory, "invalid.db");
    const output = path.join(directory, "backup.db");
    const db = new Database(source);
    db.exec("CREATE TABLE unrelated (id TEXT PRIMARY KEY)");
    db.close();
    await assert.rejects(backupDatabase(source, output), /Backup lacks required table/);
    assert.equal(existsSync(output), false);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("backup captures WAL state; restore publishes new paused DB and refuses overwrite", async () => {
  const db = getDb();
  const encryptedCookie = encryptSecret("synthetic-cookie-stays-private");
  db.prepare("INSERT INTO accounts (id, name, email, cookies_json) VALUES ('sender', 'Sender', 'sender@example.com', ?)").run(encryptedCookie);
  db.exec(`
    INSERT INTO lists (id, name) VALUES ('list', 'List');
    INSERT INTO workflows (id, name) VALUES ('workflow', 'Workflow');
    INSERT INTO targets (id, email) VALUES ('target', 'person@example.com');
    INSERT INTO runs (id, workflow_id, list_id, account_id, status)
      VALUES ('run', 'workflow', 'list', 'sender', 'running');
  `);
  const temp = mkdtempSync(path.join(tmpdir(), "linki-release-test-"));
  try {
    const backupPath = path.join(temp, "backup.db");
    const restorePath = path.join(temp, "restored.db");
    const backup = await backupDatabase(process.env.LINKI_DB_PATH!, backupPath);
    assert.equal(backup.rows.runs, 1);
    assert.equal(backup.rows.targets, 1);
    assert.equal(backup.sha256.length, 64);
    const restored = await restoreDatabase(backupPath, restorePath);
    assert.equal(restored.rows.runs, 1);
    const copy = new Database(restorePath, { readonly: true });
    try {
      assert.equal((copy.prepare("SELECT status FROM runs WHERE id = 'run'").get() as { status: string }).status, "paused");
      assert.equal((copy.prepare("SELECT paused FROM global_dispatch_control WHERE id = 1").get() as { paused: number }).paused, 1);
      const restoredCookie = (copy.prepare("SELECT cookies_json FROM accounts WHERE id = 'sender'").get() as { cookies_json: string }).cookies_json;
      assert.equal(restoredCookie, encryptedCookie);
      assert.notEqual(restoredCookie, "synthetic-cookie-stays-private");
      assert.equal(decryptSecret(restoredCookie), "synthetic-cookie-stays-private");
      assert.deepEqual(copy.pragma("foreign_key_check"), []);
    } finally {
      copy.close();
    }
    const preserved = readFileSync(restorePath);
    await assert.rejects(restoreDatabase(backupPath, restorePath), /already exists/);
    await assert.rejects(backupDatabase(process.env.LINKI_DB_PATH!, backupPath), /already exists/);
    assert.deepEqual(readFileSync(restorePath), preserved);
    assert.equal(existsSync(restorePath), true);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});
