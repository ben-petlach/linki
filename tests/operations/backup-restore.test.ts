import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import Database from "better-sqlite3";
import { encryptSecret } from "../../lib/crypto";
import { getDb } from "../../lib/db";
import { registerOutboundEmail } from "../../lib/email/inbox";
import { backupDatabase, restoreDatabase } from "../../lib/reliability/backup";
import { beginDispatch, claimAction, confirmAction, holdUnknown } from "../../lib/reliability/actions";
import { getDispatchBlockReason } from "../../lib/reliability/operations";
import { suppressIdentity } from "../../lib/reliability/suppression";

test("production backup and restore preserve reliability evidence, pause dispatch, and never overwrite", async () => {
  const db = getDb();
  const directory = mkdtempSync(join(tmpdir(), "linki-backup-acceptance-"));
  const backupPath = join(directory, "backup.sqlite");
  const restorePath = join(directory, "restored.sqlite");
  const password = "synthetic-mail-password-keep-out-of-export";
  try {
    db.prepare("INSERT INTO accounts (id, name, email) VALUES ('restore-linkedin', 'Restore', 'restore-linkedin@example.test')").run();
    db.prepare(`INSERT INTO email_accounts (id, name, from_email, smtp_host, username, password)
      VALUES ('restore-mail', 'Restore Mail', 'restore-mail@example.test', 'localhost', 'restore', ?)`).run(encryptSecret(password));
    db.prepare("INSERT INTO targets (id, email) VALUES ('restore-target', 'restore-target@example.test')").run();
    db.prepare("INSERT INTO workflows (id, name) VALUES ('restore-flow', 'Restore Flow')").run();
    db.prepare(`INSERT INTO runs (id, workflow_id, account_id, status)
      VALUES ('restore-running', 'restore-flow', 'restore-linkedin', 'running')`).run();
    db.prepare(`INSERT INTO run_profiles (id, run_id, target_id)
      VALUES ('restore-profile', 'restore-running', 'restore-target')`).run();
    suppressIdentity(db, { kind: "email", value: "restore-target@example.test", reason: "fixture_opt_out" });
    for (const [key, state] of [["restore-track:confirmed", "confirmed"], ["restore-track:unknown", "unknown"]] as const) {
      const claim = claimAction(db, { key, senderId: "restore-mail", targetId: "restore-target", channel: "email" });
      assert.equal(claim.claimed, true);
      if (!claim.claimed) continue;
      assert.equal(beginDispatch(db, key, claim.token, () => null).started, true);
      if (state === "confirmed") {
        registerOutboundEmail(db, { actionKey: key, targetId: "restore-target", emailAccountId: "restore-mail",
          recipient: "restore-target@example.test", messageId: "<restore-confirmed@example.test>", subject: "Fixture" });
        assert.equal(confirmAction(db, key, claim.token, "local SMTP accepted"), true);
      } else assert.equal(holdUnknown(db, key, claim.token, "acceptance uncertain"), true);
    }
    db.prepare(`INSERT INTO email_inbound (email_account_id, message_id, target_id, kind, received_at)
      VALUES ('restore-mail', '<restore-reply@example.test>', 'restore-target', 'reply', '2026-10-18T12:00:00Z')`).run();
    const source = process.env.LINKI_DB_PATH!;
    const backup = await backupDatabase(source, backupPath);
    assert.equal(backup.rows.runs, 1);
    assert.equal(backup.rows.dispatch_actions, 2);
    assert.equal(backup.rows.suppression_rules, 1);
    assert.equal(backup.rows.email_inbound, 1);
    assert.equal(readFileSync(backupPath).includes(Buffer.from(password)), false);
    await assert.rejects(() => backupDatabase(source, backupPath), /Target database already exists/);

    // A later live-source edit must not leak into saved snapshot.
    db.prepare("INSERT INTO targets (id, email) VALUES ('after-backup', 'later@example.test')").run();
    const restoredManifest = await restoreDatabase(backupPath, restorePath);
    assert.equal(restoredManifest.rows.targets, 1);
    assert.equal(readFileSync(restorePath).includes(Buffer.from(password)), false);
    await assert.rejects(() => restoreDatabase(backupPath, restorePath), /Target database already exists/);

    const restored = new Database(restorePath);
    restored.pragma("foreign_keys = ON");
    try {
      assert.deepEqual(restored.pragma("foreign_key_check"), []);
      assert.equal((restored.pragma("integrity_check") as Array<{ integrity_check: string }>)[0].integrity_check, "ok");
      assert.equal((restored.prepare("SELECT status FROM runs WHERE id = 'restore-running'").get() as { status: string }).status, "paused");
      assert.match(getDispatchBlockReason(restored) ?? "", /Restored instance held/);
      assert.equal(restored.prepare("SELECT 1 FROM targets WHERE id = 'after-backup'").get(), undefined);
      assert.deepEqual(restored.prepare("SELECT action_key, state FROM dispatch_actions ORDER BY action_key").all(), [
        { action_key: "restore-track:confirmed", state: "confirmed" },
        { action_key: "restore-track:unknown", state: "unknown" },
      ]);
      assert.equal((restored.prepare("SELECT COUNT(*) AS count FROM suppression_rules WHERE value = 'restore-target@example.test'")
        .get() as { count: number }).count, 1);
      assert.equal((restored.prepare("SELECT COUNT(*) AS count FROM email_inbound WHERE message_id = '<restore-reply@example.test>'")
        .get() as { count: number }).count, 1);
      const claim = claimAction(restored, { key: "restore-track:confirmed", senderId: "restore-mail",
        targetId: "restore-target", channel: "email" });
      assert.equal(claim.claimed, false);
      const unknown = claimAction(restored, { key: "restore-track:unknown", senderId: "restore-mail",
        targetId: "restore-target", channel: "email" });
      assert.equal(unknown.claimed, false);
    } finally { restored.close(); }
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
