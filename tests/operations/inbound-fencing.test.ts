import assert from "node:assert/strict";
import test from "node:test";
import Database from "better-sqlite3";
import { getDb } from "../../lib/db";
import { processInboundEmail, registerOutboundEmail, markOutboundAccepted } from "../../lib/email/inbox";
import { recordInboxSyncSuccess } from "../../lib/reliability/inbox-state";
import { claimPoll, completePoll, initSchedulerSchema, stillOwnsPoll } from "../../lib/reliability/scheduler";
import { evaluateEligibility } from "../../lib/reliability/suppression";

test("expired inbox poll cannot persist parsed reply after another worker takes lease", async () => {
  const old = getDb();
  initSchedulerSchema(old);
  old.prepare("INSERT INTO targets (id, email) VALUES ('fenced-target', 'fenced@example.test')").run();
  old.prepare(`INSERT INTO email_accounts (id, name, from_email, smtp_host, imap_host, username, password)
    VALUES ('fenced-mail', 'Fenced', 'fenced-sender@example.test', 'localhost', 'localhost', 'fenced', 'fixture')`).run();
  registerOutboundEmail(old, { actionKey: "fenced-outbound", targetId: "fenced-target", emailAccountId: "fenced-mail",
    recipient: "fenced@example.test", messageId: "<fenced-outbound@example.test>", subject: "Fixture" });
  markOutboundAccepted(old, "fenced-outbound", "2026-10-18T11:00:00.000Z");
  const start = new Date("2026-10-18T12:00:00.000Z");
  const newStart = new Date(start.getTime() + 600_001);
  const oldToken = claimPoll(old, "email", "fenced-mail", start);
  assert.ok(oldToken);
  const winner = new Database(process.env.LINKI_DB_PATH!);
  winner.pragma("foreign_keys = ON");
  try {
    const rawReply = ["From: Contact <fenced@example.test>", "To: Sender <fenced-sender@example.test>",
      "Message-ID: <fenced-reply@example.test>", "In-Reply-To: <fenced-outbound@example.test>",
      "Date: Sun, 18 Oct 2026 12:01:00 +0000", "Subject: Re: Fixture",
      "Content-Type: text/plain; charset=utf-8", "", "Thanks"].join("\r\n");
    let observedTime = start;
    // Async MIME parse yields after initial ownership check. Take lease then.
    const oldParse = processInboundEmail(old, "fenced-mail", rawReply, true,
      () => stillOwnsPoll(old, "email", "fenced-mail", oldToken, observedTime));
    const replacement = claimPoll(winner, "email", "fenced-mail", newStart);
    assert.ok(replacement);
    recordInboxSyncSuccess(winner, { accountId: "fenced-mail", channel: "email", completedAt: newStart.toISOString() });
    assert.equal(completePoll(winner, "email", "fenced-mail", replacement, {}, newStart), true);
    observedTime = newStart;
    await assert.rejects(oldParse, /Inbox lease lost/);
    assert.equal((winner.prepare("SELECT COUNT(*) AS count FROM email_inbound WHERE message_id = '<fenced-reply@example.test>'")
      .get() as { count: number }).count, 0);
    assert.equal((winner.prepare("SELECT COUNT(*) AS count FROM email_replies WHERE target_id = 'fenced-target'")
      .get() as { count: number }).count, 0);
    assert.equal(evaluateEligibility(winner, "fenced-target", { channel: "email" }).allowed, true);
    assert.equal((winner.prepare("SELECT last_success_at FROM scheduler_poll_state WHERE channel = 'email' AND account_id = 'fenced-mail'")
      .get() as { last_success_at: string }).last_success_at, newStart.toISOString());
  } finally { winner.close(); }
});
