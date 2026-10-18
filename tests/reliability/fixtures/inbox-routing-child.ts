import { getDb } from "../../../lib/db";
import { initEmailReliabilitySchema } from "../../../lib/email/inbox";
import inboxHandler from "../../../pages/api/inbox/index";
import replyHandler from "../../../pages/api/inbox/reply";

type MockResponse = {
  code: number; body: unknown;
  status: (code: number) => MockResponse;
  json: (body: unknown) => MockResponse;
  setHeader: () => MockResponse;
  end: () => MockResponse;
};
function response(): MockResponse {
  return { code: 200, body: null,
    status(code) { this.code = code; return this; },
    json(body) { this.body = body; return this; },
    setHeader() { return this; }, end() { return this; } };
}
async function main() {
  globalThis.fetch = async () => ({ ok: false }) as Response; // prevent update-check network call
  const db = getDb();
  initEmailReliabilitySchema(db);
  db.prepare("INSERT INTO targets (id,email,full_name) VALUES ('person','person@example.com','Person')").run();
  for (const [id, from] of [["sender-a", "a@sender.test"], ["sender-b", "b@sender.test"]]) {
    db.prepare(`INSERT INTO email_accounts (id,name,from_email,smtp_host,username,password,is_verified)
      VALUES (?,?,?,?,?,?,1)`).run(id, id, from, "127.0.0.1", id, "test");
  }
  db.prepare("INSERT INTO workflows (id,name) VALUES ('workflow','Synthetic')").run();
  for (const [runId, accountId] of [["run-a", "sender-a"], ["run-b", "sender-b"]]) {
    db.prepare("INSERT INTO runs (id,workflow_id,status) VALUES (?,'workflow','running')").run(runId);
    db.prepare("INSERT INTO run_profiles (id,run_id,target_id,email_account_id) VALUES (?,?,?,?)")
      .run(`profile-${accountId}`, runId, "person", accountId);
  }
  db.prepare(`INSERT INTO email_replies
    (id,target_id,run_id,email_account_id,message_id,from_email,subject,body_text,received_at)
    VALUES ('reply-a','person','run-a','sender-a','<reply-a@example.com>','person@example.com','Re: Hello','Thanks','2026-02-02T00:00:00Z')`).run();
  db.prepare(`INSERT INTO email_replies
    (id,target_id,run_id,email_account_id,message_id,from_email,subject,body_text,received_at)
    VALUES ('reply-b-old','person','run-b','sender-b','<reply-b@example.com>','person@example.com','Re: Earlier','Earlier','2026-02-01T00:00:00Z')`).run();
  const list = response();
  inboxHandler({ method: "GET", query: {} } as never, list as never);
  const rows = (list.body as { replies: Array<{ email_account_id: string; reply_id: string }> }).replies;
  const wrong = response();
  await replyHandler({ method: "POST", query: {}, headers: {}, body: {
    emailAccountId: "sender-b", targetId: "person", replyId: "reply-a", to: "person@example.com",
    subject: "Re: Hello", body: "Manual reply", idempotencyKey: "request-12345678",
  } } as never, wrong as never);
  const right = response();
  await replyHandler({ method: "POST", query: {}, headers: {}, body: {
    emailAccountId: "sender-a", targetId: "person", replyId: "reply-a", to: "person@example.com",
    subject: "Re: Hello", body: "Manual reply", idempotencyKey: "request-12345678",
  } } as never, right as never);
  process.stdout.write(JSON.stringify({ account: rows[0]?.email_account_id, replyId: rows[0]?.reply_id,
    wrongStatus: wrong.code, wrongBody: wrong.body, rightStatus: right.code, rightBody: right.body }));
  process.exit(0);
}
main().catch(error => { console.error(error); process.exit(1); });
