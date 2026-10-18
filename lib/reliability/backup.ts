import Database from "better-sqlite3";
import { createHash, randomUUID } from "node:crypto";
import { chmodSync, closeSync, createReadStream, existsSync, linkSync, openSync, rmSync, unlinkSync } from "node:fs";
import path from "node:path";
import { initOperationsSchema, setGlobalDispatchPause } from "./operations";

export interface BackupManifest {
  path: string;
  sha256: string;
  tables: number;
  rows: Record<string, number>;
}

function inspect(db: Database.Database): Omit<BackupManifest, "path" | "sha256"> {
  const integrity = db.pragma("integrity_check") as Array<{ integrity_check: string }>;
  if (integrity.length !== 1 || integrity[0].integrity_check !== "ok") throw new Error("SQLite integrity check failed");
  const foreignKeyErrors = db.pragma("foreign_key_check") as unknown[];
  if (foreignKeyErrors.length) throw new Error("SQLite foreign key check failed");
  const names = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as Array<{ name: string }>).map((row) => row.name);
  for (const essential of ["runs", "targets", "dispatch_actions", "suppression_rules", "email_outbound"]) {
    if (!names.includes(essential)) throw new Error(`Backup lacks required table: ${essential}`);
  }
  const rows: Record<string, number> = {};
  for (const name of ["runs", "targets", "dispatch_actions", "suppression_rules", "email_outbound", "email_inbound"]) {
    if (names.includes(name)) rows[name] = (db.prepare(`SELECT COUNT(*) AS count FROM "${name}"`).get() as { count: number }).count;
  }
  return { tables: names.length, rows };
}

async function manifest(dbPath: string): Promise<BackupManifest> {
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    const hash = createHash("sha256");
    for await (const chunk of createReadStream(dbPath)) hash.update(chunk);
    return { path: dbPath, sha256: hash.digest("hex"), ...inspect(db) };
  } finally {
    db.close();
  }
}

function distinctPaths(sourcePath: string, targetPath: string): void {
  if (path.resolve(sourcePath) === path.resolve(targetPath)) throw new Error("Source and target database paths must differ");
  if (existsSync(targetPath)) throw new Error("Target database already exists");
  if (!existsSync(path.dirname(path.resolve(targetPath)))) throw new Error("Target directory does not exist");
}

async function copyConsistently(sourcePath: string, targetPath: string): Promise<void> {
  const source = new Database(sourcePath, { readonly: true, fileMustExist: true });
  try {
    // SQLite backup API includes committed WAL transactions in one consistent snapshot.
    await source.backup(targetPath);
  } finally {
    source.close();
  }
  chmodSync(targetPath, 0o600);
}

export async function backupDatabase(sourcePath: string, destinationPath: string): Promise<BackupManifest> {
  distinctPaths(sourcePath, destinationPath);
  const destination = path.resolve(destinationPath);
  const reservation = openSync(destination, "wx", 0o600);
  closeSync(reservation);
  try {
    await copyConsistently(sourcePath, destination);
    return await manifest(destination);
  } catch (error) {
    rmSync(destination, { force: true });
    throw error;
  }
}

export async function restoreDatabase(backupPath: string, targetPath: string): Promise<BackupManifest> {
  distinctPaths(backupPath, targetPath);
  const target = path.resolve(targetPath);
  const temporary = path.join(path.dirname(target), `.linki-restore-${randomUUID()}.db`);
  try {
    const reservation = openSync(temporary, "wx", 0o600);
    closeSync(reservation);
    await copyConsistently(backupPath, temporary);
    const db = new Database(temporary);
    try {
      db.pragma("foreign_keys = ON");
      inspect(db);
      initOperationsSchema(db);
      db.transaction(() => {
        // The restored file is never visible until both holds are durable.
        db.prepare("UPDATE runs SET status = 'paused' WHERE status = 'running'").run();
        setGlobalDispatchPause(db, {
          paused: true,
          actorId: "system:restore",
          reason: "Restored instance held pending operator review",
        });
      }).immediate();
      db.pragma("wal_checkpoint(TRUNCATE)");
      db.pragma("journal_mode = DELETE");
      inspect(db);
    } finally {
      db.close();
    }
    // Hard link publishes atomically and fails if another process created target.
    linkSync(temporary, target);
    unlinkSync(temporary);
    return manifest(target);
  } finally {
    rmSync(temporary, { force: true });
    rmSync(`${temporary}-wal`, { force: true });
    rmSync(`${temporary}-shm`, { force: true });
  }
}
