import type { NextApiRequest, NextApiResponse } from "next";
import { getServerSession } from "next-auth/next";
import { authOptions } from "../auth/[...nextauth]";
import { getDb } from "@/lib/db";
import {
  evaluateOperationAlerts, getGlobalDispatchControl, getOperationMetrics,
  listHeldActions, listOperationAlerts,
} from "@/lib/reliability/operations";

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "GET") {
    res.setHeader("Allow", ["GET"]);
    return res.status(405).end();
  }
  const session = await getServerSession(req, res, authOptions);
  if (!session?.user?.email) return res.status(401).json({ error: "Not authenticated" });
  const db = getDb();
  evaluateOperationAlerts(db);
  return res.json({
    dispatch: getGlobalDispatchControl(db),
    heldActions: listHeldActions(db),
    alerts: listOperationAlerts(db),
    metrics: getOperationMetrics(db),
  });
}
