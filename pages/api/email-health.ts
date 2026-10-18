import type { NextApiRequest, NextApiResponse } from "next";
import { getDb } from "@/lib/db";

export default function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "GET") return res.status(405).end();
  const db = getDb();

  const accounts = db.prepare(`
    SELECT id, name, from_email, daily_email_limit, ramp_up_enabled, ramp_start_date
    FROM email_accounts
    ORDER BY name
  `).all() as {
    id: string; name: string; from_email: string;
    daily_email_limit: number; ramp_up_enabled: number; ramp_start_date: string | null;
  }[];

  // Count only durable SMTP acceptance. Legacy free-text logs can be duplicated
  // or record attempts whose provider outcome was never established.
  const dailySends = db.prepare(`
    SELECT o.email_account_id,
           date(o.accepted_at) as day,
           COUNT(*) as sent
    FROM email_outbound o
    WHERE o.accepted_at IS NOT NULL
      AND o.accepted_at >= date('now', '-6 days')
    GROUP BY o.email_account_id, date(o.accepted_at)
  `).all() as { email_account_id: string; day: string; sent: number }[];

  // Last 50 durable provider acceptances across all accounts.
  const recentLogs = db.prepare(`
    SELECT o.accepted_at AS created_at,
           'SMTP accepted: ' || o.recipient_email AS message,
           o.email_account_id
    FROM email_outbound o
    WHERE o.accepted_at IS NOT NULL
    ORDER BY o.accepted_at DESC
    LIMIT 50
  `).all() as { created_at: string; message: string; email_account_id: string }[];

  // Guard trips today
  const guardTrips = db.prepare(`
    SELECT l.created_at, l.message, rp.email_account_id
    FROM logs l
    LEFT JOIN run_profiles rp ON rp.run_id = l.run_id AND rp.target_id = l.target_id
    WHERE (l.message LIKE '%Daily limit%' OR l.message LIKE '%limit guard%')
    AND date(l.created_at) = date('now')
    ORDER BY l.created_at DESC
    LIMIT 50
  `).all() as { created_at: string; message: string; email_account_id: string | null }[];

  function effectiveLimit(a: typeof accounts[0], date: Date) {
    if (!a.ramp_up_enabled || !a.ramp_start_date) return a.daily_email_limit;
    const start = new Date(a.ramp_start_date);
    const daysActive = Math.floor((date.getTime() - start.getTime()) / (1000 * 60 * 60 * 24)) + 1;
    return Math.min(a.daily_email_limit, daysActive * 2);
  }

  const now = new Date();
  // Build last 7 days list (UTC dates)
  const days: string[] = [];
  for (let i = 6; i >= 0; i--) {
    const d = new Date(now);
    d.setUTCDate(d.getUTCDate() - i);
    days.push(d.toISOString().slice(0, 10));
  }

  // Index sends: accountId -> day -> count
  const sendsIndex: Record<string, Record<string, number>> = {};
  for (const row of dailySends) {
    if (!sendsIndex[row.email_account_id]) sendsIndex[row.email_account_id] = {};
    sendsIndex[row.email_account_id][row.day] = row.sent;
  }

  const today = now.toISOString().slice(0, 10);

  const result = accounts.map(a => {
    const sentToday = sendsIndex[a.id]?.[today] ?? 0;
    const limit = effectiveLimit(a, now);
    return {
      id: a.id,
      name: a.name,
      from_email: a.from_email,
      daily_email_limit: a.daily_email_limit,
      ramp_up_enabled: a.ramp_up_enabled,
      ramp_start_date: a.ramp_start_date,
      effective_limit_today: limit,
      sent_today: sentToday,
      days: days.map(day => ({
        day,
        sent: sendsIndex[a.id]?.[day] ?? 0,
        limit: effectiveLimit(a, new Date(day + "T12:00:00Z")),
      })),
    };
  });

  res.json({ accounts: result, days, recentLogs, guardTrips });
}
