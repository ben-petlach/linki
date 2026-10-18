import type { NextApiRequest, NextApiResponse } from "next";
import { getDb } from "@/lib/db";
import { sendDirectEmail } from "@/lib/email/direct";
import { decryptSecret } from "@/lib/crypto";

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "POST") {
    res.setHeader("Allow", ["POST"]);
    return res.status(405).end();
  }

  const { emailAccountId, to, subject, body, targetId, idempotencyKey } = req.body as {
    emailAccountId?: string;
    to?: string;
    subject?: string;
    body?: string;
    targetId?: string;
    idempotencyKey?: string;
  };

  if (!emailAccountId || !to || !subject || !body || !targetId) {
    return res.status(400).json({ error: "emailAccountId, to, subject, body, and targetId are required" });
  }

  const db = getDb();
  const account = db.prepare(
    "SELECT id, from_email, from_name, reply_to, smtp_host, smtp_port, smtp_secure, username, password FROM email_accounts WHERE id = ?"
  ).get(emailAccountId) as {
    id: string; from_email: string; from_name: string | null; reply_to: string | null;
    smtp_host: string; smtp_port: number; smtp_secure: number; username: string; password: string;
  } | undefined;

  if (!account) return res.status(404).json({ error: "Email account not found" });

  const result = await sendDirectEmail(db, {
    targetId, account: { ...account, password: decryptSecret(account.password)! },
    recipient: to, subject, body,
    idempotencyKey: idempotencyKey ?? req.headers["idempotency-key"]?.toString() ?? "",
  });
  if (!result.ok) return res.status(result.status).json({ error: result.error });
  return res.json({ ok: true, messageId: result.messageId });
}
