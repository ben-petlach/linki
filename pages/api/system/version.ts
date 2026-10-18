import type { NextApiRequest, NextApiResponse } from "next";
import { runtimeIdentity } from "@/lib/runtime-config";

export default function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "GET") return res.status(405).json({ error: "Method not allowed" });
  res.setHeader("Cache-Control", "no-store");
  return res.status(200).json(runtimeIdentity());
}
