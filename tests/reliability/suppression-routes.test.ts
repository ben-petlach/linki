import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import type { NextApiRequest, NextApiResponse } from "next";

const dir = mkdtempSync(join(tmpdir(), "linki-suppression-"));
process.env.LINKI_DB_PATH = join(dir, "linki.db");
(globalThis as typeof globalThis & { __updateCheckScheduled?: boolean }).__updateCheckScheduled = true;

function response() {
  let status = 200;
  let body: unknown;
  const res = {
    status(code: number) { status = code; return this; },
    json(value: unknown) { body = value; return this; },
    setHeader() { return this; },
    end() { return this; },
  } as unknown as NextApiResponse;
  return { res, result: () => ({ status, body: body as Record<string, unknown> }) };
}

test("actual enrollment routes reject suppression and duplicate enrollment", async () => {
  const [{ getDb }, { default: createRun }, { default: enroll }, { suppressIdentity }] = await Promise.all([
    import("../../lib/db"), import("../../pages/api/runs/index"),
    import("../../pages/api/runs/[id]/enroll"), import("../../lib/reliability/suppression"),
  ]);
  const db = getDb();
  db.exec(`
    INSERT INTO accounts (id, name, email) VALUES ('a1', 'Sender One', 'one@example.com');
    INSERT INTO lists (id, name) VALUES ('l1', 'List One');
    INSERT INTO workflows (id, name) VALUES ('w1', 'Workflow One');
    INSERT INTO targets (id, linkedin_url, full_name, email) VALUES
      ('t1', 'https://www.linkedin.com/in/one', 'One', 'one@prospect.com'),
      ('t2', 'https://www.linkedin.com/in/two', 'Two', 'two@prospect.com');
    INSERT INTO list_targets VALUES ('l1', 't1'), ('l1', 't2');
  `);
  suppressIdentity(db, { kind: "email", value: "one@prospect.com", reason: "unsubscribe", evidence: "evt-1" });
  const first = response();
  createRun({ method: "POST", body: { workflow_id: "w1", list_id: "l1", account_id: "a1", target_ids: ["t1", "t2"] } } as NextApiRequest, first.res);
  assert.equal(first.result().status, 201);
  assert.equal(first.result().body.enrolled, 1);
  assert.deepEqual((first.result().body.suppression_blocks as Array<{target_id:string}>).map((b) => b.target_id), ["t1"]);
  const runId = first.result().body.id as string;
  const second = response();
  enroll({ method: "POST", query: { id: runId }, body: { target_ids: ["t1", "t2", "t2"] } } as unknown as NextApiRequest, second.res);
  assert.equal(second.result().body.enrolled, 0);
  assert.equal(second.result().body.skipped_suppressed, 1);
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM run_profiles").get() as {n:number}).n, 1);

  db.prepare("INSERT INTO targets (id, linkedin_url, full_name) VALUES ('t4', 'https://www.linkedin.com/in/four', 'Four')").run();
  const runWorker = () => {
    const child = spawn(process.execPath, ["--import", "tsx", join(process.cwd(), "tests/reliability/enroll-worker.cjs")], {
      cwd: process.cwd(), env: { ...process.env, TEST_RUN_ID: runId }, stdio: ["pipe", "pipe", "pipe"],
    });
    let buffer = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    const ready = new Promise<void>((resolve, reject) => {
      child.stdout.on("data", (chunk: string) => { buffer += chunk; if (buffer.includes("READY\n")) resolve(); });
      child.once("error", reject);
      child.once("exit", (code) => { if (!buffer.includes("READY\n")) reject(new Error(`worker exited ${code}: ${stderr}`)); });
    });
    const done = new Promise<Record<string, unknown>>((resolve, reject) => {
      child.once("exit", (code) => {
        if (code !== 0) return reject(new Error(`worker exited ${code}: ${stderr}`));
        const lines = buffer.trim().split("\n");
        resolve(JSON.parse(lines.at(-1)!) as Record<string, unknown>);
      });
      child.once("error", reject);
    });
    return { child, ready, done };
  };
  const workers = [runWorker(), runWorker()];
  await Promise.all(workers.map((worker) => worker.ready));
  for (const worker of workers) worker.child.stdin.end("go\n");
  const outcomes = await Promise.all(workers.map((worker) => worker.done));
  assert.equal(outcomes.reduce((n, outcome) => n + ((outcome.body as { enrolled: number }).enrolled ?? 0), 0), 1);
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM run_profiles WHERE target_id = 't4'").get() as {n:number}).n, 1);
  db.close();
  rmSync(dir, { recursive: true, force: true });
});
