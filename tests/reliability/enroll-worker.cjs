global.__updateCheckScheduled = true;

(async () => {
  const { default: enroll } = await import("../../pages/api/runs/[id]/enroll.ts");
  const { getDb } = await import("../../lib/db.ts");
  getDb();
  process.stdout.write("READY\n");
  process.stdin.once("data", () => {
    let status = 200;
    const res = {
      status(code) { status = code; return this; },
      json(body) { process.stdout.write(JSON.stringify({ status, body }) + "\n"); return this; },
      setHeader() { return this; },
      end() { return this; },
    };
    enroll({ method: "POST", query: { id: process.env.TEST_RUN_ID }, body: { target_ids: ["t4"] } }, res);
  });
})().catch((error) => { process.stderr.write(String(error)); process.exit(1); });
