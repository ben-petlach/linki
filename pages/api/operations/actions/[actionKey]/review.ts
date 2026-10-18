import type { NextApiRequest, NextApiResponse } from "next";
import { getDb } from "@/lib/db";
import { reviewHeldAction } from "@/lib/reliability/operations";
import { authenticatedOperatorId, isSameOriginMutation } from "@/lib/reliability/operations-auth";

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "POST") {
    res.setHeader("Allow", ["POST"]);
    return res.status(405).end();
  }
  const actorId = await authenticatedOperatorId(req, res);
  if (!actorId) return res.status(401).json({ error: "Not authenticated" });
  if (!isSameOriginMutation(req)) return res.status(403).json({ error: "Origin mismatch" });
  const actionKey = req.query.actionKey;
  const { decision, reason, evidence } = req.body ?? {};
  if (typeof actionKey !== "string" || !["note", "confirm_provider_accepted"].includes(decision) ||
      typeof reason !== "string" || typeof evidence !== "string" || !reason.trim() || !evidence.trim())
    return res.status(400).json({ error: "Action, decision, reason, and evidence are required" });
  const db = getDb();
  try {
    return res.json(reviewHeldAction(db, { actionKey, actorId, decision, reason, evidence }));
  } catch (error) {
    return res.status(409).json({ error: error instanceof Error ? error.message : "Review failed" });
  }
}
