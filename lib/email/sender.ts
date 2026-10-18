import nodemailer from "linki-nodemailer";
import Imap from "imap";
import { randomUUID } from "crypto";

export interface EmailAccount {
  id: string;
  from_email: string;
  from_name: string | null;
  reply_to?: string | null;
  smtp_host: string;
  smtp_port: number;
  smtp_secure: number; // 0 = STARTTLS, 1 = SSL
  username: string;
  password: string;
}

export async function sendEmail(
  account: EmailAccount,
  to: string,
  subject: string,
  body: string,
  options?: { messageId?: string; inReplyTo?: string; references?: string[] }
): Promise<{ messageId: string; accepted: string[]; rejected: string[] }> {
  const transporter = nodemailer.createTransport({
    host: account.smtp_host,
    port: account.smtp_port,
    secure: account.smtp_secure === 1,
    auth: {
      user: account.username,
      pass: account.password,
    },
    requireTLS: account.smtp_secure !== 1,
    tls: { rejectUnauthorized: true },
  });

  const from = account.from_name
    ? `"${account.from_name}" <${account.from_email}>`
    : account.from_email;

  const messageId = options?.messageId ?? `<${randomUUID()}@${account.from_email.split("@")[1]}>`;
  const result = await transporter.sendMail({
    from, to, subject, text: body, messageId,
    ...(options?.inReplyTo ? { inReplyTo: options.inReplyTo } : {}),
    ...(options?.references ? { references: options.references } : {}),
    ...(account.reply_to ? { replyTo: account.reply_to } : {}),
  });
  return { messageId: result.messageId, accepted: result.accepted.map(String), rejected: result.rejected.map(String) };
}

/**
 * Verifies SMTP connectivity — used by the test-connection endpoint.
 * Returns null on success, error message string on failure.
 */
export async function testSmtpConnection(account: Omit<EmailAccount, "id">): Promise<string | null> {
  try {
    const transporter = nodemailer.createTransport({
      host: account.smtp_host,
      port: account.smtp_port,
      secure: account.smtp_secure === 1,
      auth: { user: account.username, pass: account.password },
      requireTLS: account.smtp_secure !== 1,
      tls: { rejectUnauthorized: true },
      connectionTimeout: 10_000,
      greetingTimeout: 10_000,
    });
    await transporter.verify();
    return null;
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}

export interface ImapTestAccount {
  imap_host: string;
  imap_port: number;
  username: string;
  password: string;
  imap_username: string | null;
  imap_password: string | null;
}

/**
 * Verifies IMAP connectivity — connects, authenticates, then disconnects.
 * Returns null on success, error message string on failure.
 */
export async function testImapConnection(account: ImapTestAccount): Promise<string | null> {
  return new Promise((resolve) => {
    const imap = new Imap({
      host: account.imap_host,
      port: account.imap_port,
      tls: true,
      tlsOptions: { rejectUnauthorized: true },
      user: account.imap_username ?? account.username,
      password: account.imap_password ?? account.password,
      authTimeout: 10_000,
      connTimeout: 12_000,
    });

    imap.once("ready", () => {
      try { imap.end(); } catch { /* ignore */ }
      resolve(null);
    });

    imap.once("error", (err: Error) => {
      resolve(err.message ?? String(err));
    });

    imap.connect();
  });
}
