import type { NextApiRequest, NextApiResponse } from "next";
import { getDb } from "@/lib/db";
import { decryptSecret } from "@/lib/crypto";
import { checkEmailDnsReadiness, getProviderDispatchBlockReason } from "@/lib/reliability/provider-health";
import { testImapConnection, testSmtpConnection } from "@/lib/email/sender";

export function safeConnectionError(error: string | null): string | null {
  if (!error) return null;
  if (/certificate|tls|ssl|starttls/i.test(error)) return "TLS verification failed";
  if (/auth|credential|login|password|535/i.test(error)) return "Authentication failed";
  if (/timeout|timed out|ETIMEDOUT/i.test(error)) return "Connection timed out";
  if (/429|rate.limit|too many/i.test(error)) return "Provider throttled connection";
  return "Connection failed";
}

/** Diagnostics only: SMTP verify, IMAP login, and DNS reads. Never sends mail. */
export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "GET") { res.setHeader("Allow", "GET"); return res.status(405).end(); }
  const db = getDb();
  const id = String(req.query.id ?? "");
  const account = db.prepare("SELECT * FROM email_accounts WHERE id = ?").get(id) as {
    from_email: string; from_name: string | null; smtp_host: string; smtp_port: number; smtp_secure: number;
    imap_host: string | null; imap_port: number | null; username: string; password: string;
    imap_username: string | null; imap_password: string | null;
  } | undefined;
  if (!account) return res.status(404).json({ error: "Email account not found" });
  const password = decryptSecret(account.password)!;
  const imapPassword = decryptSecret(account.imap_password);
  const dkimSelector = typeof req.query.dkimSelector === "string" ? req.query.dkimSelector : undefined;
  if (dkimSelector && !/^[a-z0-9-]{1,63}$/i.test(dkimSelector)) return res.status(400).json({ error: "Invalid DKIM selector" });
  const [dns, smtpError, imapError] = await Promise.all([
    checkEmailDnsReadiness(account.from_email, undefined, dkimSelector),
    testSmtpConnection({ ...account, password }),
    account.imap_host ? testImapConnection({
      imap_host: account.imap_host, imap_port: account.imap_port ?? 993,
      username: account.username, password, imap_username: account.imap_username, imap_password: imapPassword,
    }) : Promise.resolve("IMAP not configured"),
  ]);
  res.setHeader("Cache-Control", "no-store");
  return res.status(200).json({
    dns: { ...dns, interpretation: "TXT presence only; signing, alignment, reputation, and delivery unverified" },
    smtp: { ok: !smtpError, error: safeConnectionError(smtpError) },
    imap: { ok: !imapError, error: safeConnectionError(imapError) },
    senderHold: getProviderDispatchBlockReason(db, id, "email"),
    complaintEvents: "unsupported_without_authenticated_provider_adapter",
  });
}
