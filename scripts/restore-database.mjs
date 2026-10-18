import { restoreDatabase } from "../lib/reliability/backup.ts";

const args = process.argv.slice(2);
if (args.length !== 4 || args[0] !== "--backup" || args[2] !== "--target") {
  console.error("Usage: node --import tsx scripts/restore-database.mjs --backup BACKUP_DB --target NEW_DB");
  process.exit(2);
}
try {
  console.log(JSON.stringify(await restoreDatabase(args[1], args[3])));
} catch (error) {
  console.error(error instanceof Error ? error.message : "Restore failed");
  process.exitCode = 1;
}
