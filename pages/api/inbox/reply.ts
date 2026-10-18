import type { NextApiRequest, NextApiResponse } from "next";
import { getDb } from "@/lib/db";
import { sendDirectEmail } from "@/lib/email/direct";
import { decryptSecret } from "@/lib/crypto";

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "POST") {
    res.setHeader("Allow", ["POST"]);
    return res.status(405).end();
  }

  const { emailAccountId, to, subject, body, targetId, replyId, idempotencyKey } = req.body as {
    emailAccountId?: string;
    to?: string;
    subject?: string;
    body?: string;
    targetId?: string;
    replyId?: string;
    idempotencyKey?: string;
  };

  if (!emailAccountId || !to || !subject || !body || !targetId || !replyId) {
    return res.status(400).json({ error: "emailAccountId, to, subject, body, targetId, and replyId are required" });
  }

  const db = getDb();
  const reply = db.prepare("SELECT target_id, email_account_id, message_id, from_email FROM email_replies WHERE id = ?")
    .get(replyId) as { target_id: string; email_account_id: string | null; message_id: string | null; from_email: string } | undefined;
  if (!reply || reply.target_id !== targetId || reply.email_account_id !== emailAccountId ||
      reply.from_email.trim().toLowerCase() !== to.trim().toLowerCase() || !reply.message_id) {
    return res.status(409).json({ error: "Reply is not bound to this contact, sender, or message" });
  }
  const account = db.prepare(
    "SELECT id, from_email, from_name, reply_to, smtp_host, smtp_port, smtp_secure, username, password FROM email_accounts WHERE id = ?"
  ).get(emailAccountId) as {
    id: string; from_email: string; from_name: string | null; reply_to: string | null;
    smtp_host: string; smtp_port: number; smtp_secure: number; username: string; password: string;
  } | undefined;

  if (!account) return res.status(404).json({ error: "Email account not found" });

  const result = await sendDirectEmail(db, {
    targetId, account: { ...account, password: decryptSecret(account.password)! },
    recipient: to, subject, body, replyId, inReplyTo: reply.message_id, references: [reply.message_id],
    idempotencyKey: idempotencyKey ?? req.headers["idempotency-key"]?.toString() ?? "",
  });
  if (!result.ok) return res.status(result.status).json({ error: result.error });
  return res.json({ ok: true, messageId: result.messageId });
}
