import type { NextApiRequest, NextApiResponse } from "next";
import { getDb } from "@/lib/db";
import { getGlobalDispatchControl, setGlobalDispatchPause } from "@/lib/reliability/operations";
import { authenticatedOperatorId, isSameOriginMutation } from "@/lib/reliability/operations-auth";

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "POST") {
    res.setHeader("Allow", ["POST"]);
    return res.status(405).end();
  }
  const actorId = await authenticatedOperatorId(req, res);
  if (!actorId) return res.status(401).json({ error: "Not authenticated" });
  if (!isSameOriginMutation(req)) return res.status(403).json({ error: "Origin mismatch" });
  const { paused, reason } = req.body ?? {};
  if (typeof paused !== "boolean" || typeof reason !== "string" || !reason.trim() || reason.length > 2000)
    return res.status(400).json({ error: "paused boolean and reason are required" });
  const db = getDb();
  setGlobalDispatchPause(db, { paused, actorId, reason });
  return res.json({ dispatch: getGlobalDispatchControl(db) });
}
