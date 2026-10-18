import assert from "node:assert/strict";
import { test } from "node:test";
import bcrypt from "bcryptjs";
import { encode } from "next-auth/jwt";
import { NextRequest } from "next/server";
import { isAuthenticated } from "../../lib/auth";
import { getDb } from "../../lib/db";
import { authOptions } from "../../pages/api/auth/[...nextauth]";
import { proxy } from "../../proxy";

function request(path: string, headers: Record<string, string> = {}) {
  return new NextRequest(`http://localhost:3000${path}`, { headers });
}

test("signed NextAuth session enters protected API; malformed cookies and Bearer tokens do not", async () => {
  const secret = process.env.NEXTAUTH_SECRET!;
  const token = await encode({ token: { sub: "synthetic-user" }, secret, maxAge: 60 });
  const cookie = `next-auth.session-token=${token}`;

  assert.equal(await isAuthenticated(request("/api/targets", { cookie })), true);
  assert.equal((await proxy(request("/api/targets", { cookie }))).status, 200);

  const invalidHeaders: Record<string, string>[] = [
    { authorization: "Bearer malformed" },
    { cookie: "next-auth.session-token=malformed" },
    { cookie: `next-auth.session-token=${token.slice(0, -3)}bad` },
  ];
  for (const headers of invalidHeaders) {
    assert.equal(await isAuthenticated(request("/api/targets", headers)), false);
    const response = await proxy(request("/api/targets", headers));
    assert.equal(response.status, 401);
    assert.deepEqual(await response.json(), { error: "Not authenticated" });
  }
});

test("internal secret grants protected API only on exact match", async () => {
  const previous = process.env.INTERNAL_API_SECRET;
  process.env.INTERNAL_API_SECRET = "synthetic-internal-secret";
  try {
    assert.equal(await isAuthenticated(request("/api/targets", {
      "x-internal-secret": "synthetic-internal-secret",
    })), true);
    assert.equal((await proxy(request("/api/targets", {
      "x-internal-secret": "synthetic-internal-secret",
    }))).status, 200);
    for (const candidate of ["synthetic-internal-secreu", "synthetic-internal-secret-extra", ""]) {
      assert.equal((await proxy(request("/api/targets", {
        "x-internal-secret": candidate,
      }))).status, 401);
    }
  } finally {
    if (previous === undefined) delete process.env.INTERNAL_API_SECRET;
    else process.env.INTERNAL_API_SECRET = previous;
  }
});

test("credentials provider checks stored bcrypt hash", async () => {
  const db = getDb();
  const password = "synthetic-correct-password";
  db.prepare("INSERT INTO users (id, email, password_hash) VALUES (?, ?, ?)")
    .run("auth-fixture", "auth-fixture@example.test", await bcrypt.hash(password, 4));

  const provider = authOptions.providers[0] as unknown as {
    options: {
      authorize(credentials: { email: string; password: string }, request: { headers: Record<string, string> }): Promise<unknown>;
    };
  };
  const req = { headers: { "x-real-ip": "127.0.0.99" } };
  assert.deepEqual(await provider.options.authorize({ email: "auth-fixture@example.test", password }, req), {
    id: "auth-fixture", email: "auth-fixture@example.test",
  });
  assert.equal(await provider.options.authorize({ email: "auth-fixture@example.test", password: "wrong" }, req), null);
  assert.equal(await provider.options.authorize({ email: "missing@example.test", password }, req), null);
});
