import Database from "better-sqlite3";
import { syncEmailInbox } from "../../../lib/email/inbox";

async function main() {
  const db = new Database(process.argv[2]);
  try {
    const result = await syncEmailInbox("account", db);
    process.stdout.write(JSON.stringify(result));
  } finally {
    db.close();
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
