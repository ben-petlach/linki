import type { NextApiRequest, NextApiResponse } from "next";
import { getDb } from "@/lib/db";
import { consumeUnsubscribeToken } from "@/lib/reliability/provider-health";

/** RFC 8058 one-click endpoint. A GET never changes suppression. */
export default function handler(req: NextApiRequest, res: NextApiResponse) {
  res.setHeader("Cache-Control", "no-store");
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "POST required" });
  }
  const token = typeof req.query.token === "string" ? req.query.token :
    typeof req.body?.token === "string" ? req.body.token : "";
  const status = consumeUnsubscribeToken(getDb(), token);
  if (status === "invalid") return res.status(400).json({ error: "Invalid unsubscribe link" });
  return res.status(200).json({ ok: true, status });
}
