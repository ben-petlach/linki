import { backupDatabase } from "../lib/reliability/backup.ts";

const args = process.argv.slice(2);
if (args.length !== 4 || args[0] !== "--source" || args[2] !== "--output") {
  console.error("Usage: node --import tsx scripts/backup-database.mjs --source SOURCE_DB --output NEW_BACKUP_DB");
  process.exit(2);
}
try {
  console.log(JSON.stringify(await backupDatabase(args[1], args[3])));
} catch (error) {
  console.error(error instanceof Error ? error.message : "Backup failed");
  process.exitCode = 1;
}
