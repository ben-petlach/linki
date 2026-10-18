import Database from "better-sqlite3";
import { sendDirectEmail } from "../../../lib/email/direct";

async function main() {
  const [dbPath, portRaw, key, replyTo] = process.argv.slice(2);
  const db = new Database(dbPath);
  try {
    const result = await sendDirectEmail(db, {
      targetId: "a", recipient: "alice@example.com", subject: "Hello", body: "Synthetic test",
      idempotencyKey: key, ...(replyTo ? { inReplyTo: replyTo, references: [replyTo] } : {}), account: {
        id: "account", from_email: "sender@sender.test", from_name: null,
        smtp_host: "127.0.0.1", smtp_port: Number(portRaw), smtp_secure: 1,
        username: "sender", password: "pass",
      },
    });
    process.stdout.write(JSON.stringify(result));
  } finally { db.close(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
