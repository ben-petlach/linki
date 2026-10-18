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
  const [{ getDb }, { default: createRun }, { default: enroll }, { suppressIdentity }, { insertContacts }, { insertProfiles }, { importCsv }, { evaluateEligibility }, { default: targetApi }, { default: targetsApi }] = await Promise.all([
    import("../../lib/db"), import("../../pages/api/runs/index"),
    import("../../pages/api/runs/[id]/enroll"), import("../../lib/reliability/suppression"),
    import("../../lib/apollo-import"), import("../../lib/import-jobs"),
    import("../../lib/csv-import"), import("../../lib/reliability/suppression"),
    import("../../pages/api/targets/[id]"), import("../../pages/api/targets/index"),
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

  db.prepare("INSERT INTO lists (id, name) VALUES ('l2', 'Second List')").run();
  const contact = (linkedinUrl: string, email: string) => ({
    personId: null, linkedinUrl, firstName: "One", lastName: "Person", fullName: "One Person",
    title: null, headline: null, email, emailStatus: null, phone: null, city: null,
    country: null, timeZone: null, location: null, organizationName: null, organization: null,
  });
  const apollo = insertContacts(db, "l2", [
    contact("https://linkedin.com/in/ONE/?trk=import", "one@prospect.com"),
    contact("https://www.linkedin.com/in/new-person", "new@prospect.com"),
    contact("https://www.linkedin.com/in/one", "two@prospect.com"),
  ]);
  assert.equal(apollo.imported, 2);
  assert.equal(apollo.skipped, 1);
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM targets WHERE full_name = 'One Person'").get() as {n:number}).n, 2);

  const salesProfile = (linkedinUrl: string | null) => ({
    linkedinUrl, salesNavUrl: "https://www.linkedin.com/sales/lead/ACw123,NAME_SEARCH,abc",
    firstName: "One", lastName: "Person", fullName: "One Person", title: null,
    company: null, location: null, degree: null, objectUrn: null, summary: null,
    openLink: false, companyIndustry: null, companyLocation: null, tenureMonths: null,
    spotlightBadges: null,
  });
  const salesNav = insertProfiles(db, "l2", [salesProfile("https://www.linkedin.com/in/one/"), salesProfile(null)]);
  assert.equal(salesNav.imported, 0); // both exact aliases already in l2
  assert.equal(salesNav.skipped, 2);
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM targets WHERE sales_nav_url LIKE '%ACw123%'").get() as {n:number}).n, 1);

  const csv = importCsv(db, "l2", "linkedin_url,email,first_name,last_name\nhttps://linkedin.com/in/one/,new-address@prospect.com,One,Person\n");
  assert.equal(csv.errors.length, 0);
  assert.equal(evaluateEligibility(db, "t1", { channel: "email" }).allowed, false); // unsubscribe carried across verified profile
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM targets WHERE email = 'new-address@prospect.com'").get() as {n:number}).n, 1);
  const patch = response();
  targetApi({ method: "PATCH", query: { id: "t1" }, body: { email: "third-address@prospect.com" } } as unknown as NextApiRequest, patch.res);
  assert.equal(patch.result().status, 200);
  assert.equal(evaluateEligibility(db, "t1").allowed, false);
  const duplicate = response();
  targetsApi({ method: "POST", body: { full_name: "Unrelated Name", linkedin_url: "https://linkedin.com/in/ONE/?ref=again" } } as NextApiRequest, duplicate.res);
  assert.equal(duplicate.result().status, 409);
  db.close();
  rmSync(dir, { recursive: true, force: true });
});
