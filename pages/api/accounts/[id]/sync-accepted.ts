import type { NextApiRequest, NextApiResponse } from "next";
import { getDb } from "@/lib/db";
import { syncAcceptedConnections } from "@/lib/linkedin/sync-accepted";

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "POST") return res.status(405).end();
  const accountId = req.query.id as string;
  const db = getDb();
  const account = db.prepare("SELECT id, is_authenticated FROM accounts WHERE id = ?").get(accountId) as
    | { id: string; is_authenticated: number } | undefined;
  if (!account) return res.status(404).json({ error: "Account not found" });
  if (!account.is_authenticated) return res.status(400).json({ error: "Account not authenticated" });
  try {
    const recorded = await syncAcceptedConnections(accountId);
    return res.json({ verified_connections_recorded: recorded });
  } catch (error) {
    console.error("[sync-accepted]", error);
    return res.status(502).json({ error: error instanceof Error ? error.message : "Sync failed" });
  }
}
