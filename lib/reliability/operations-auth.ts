import type { NextApiRequest, NextApiResponse } from "next";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/pages/api/auth/[...nextauth]";
import { getDb } from "@/lib/db";

export function isSameOriginMutation(req: NextApiRequest): boolean {
  const origin = req.headers.origin;
  const host = req.headers.host;
  if (typeof origin !== "string" || typeof host !== "string") return false;
  try {
    const parsed = new URL(origin);
    return parsed.host === host && (parsed.protocol === "https:" || parsed.protocol === "http:");
  } catch { return false; }
}

export async function authenticatedOperatorId(req: NextApiRequest, res: NextApiResponse): Promise<string | null> {
  const session = await getServerSession(req, res, authOptions);
  if (!session?.user?.email) return null;
  const user = getDb().prepare("SELECT id FROM users WHERE email = ?").get(session.user.email) as { id: string } | undefined;
  return user?.id ?? null;
}
