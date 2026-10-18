import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { randomBytes } from "node:crypto";
import { chromium } from "playwright";

const require = createRequire(import.meta.url);
assert.equal(typeof require("fast-glob").globSync, "function", "local fast-glob package missing from image");

// These are the runtime prerequisites for the bounded container CVE assessment.
assert.notEqual(process.getuid(), 0, "runtime must be non-root");
const processStatus = readFileSync("/proc/self/status", "utf8");
assert.match(processStatus, /^NoNewPrivs:\s+1$/m);
assert.match(processStatus, /^CapEff:\s+0+$/m);
assert.match(processStatus, /^CapBnd:\s+0+$/m);
assert.equal(readFileSync("/sys/fs/cgroup/memory.max", "utf8").trim(), "2147483648");
assert.equal(readFileSync("/sys/fs/cgroup/pids.max", "utf8").trim(), "256");
assert.ok(!process.env.DISPLAY && !process.env.WAYLAND_DISPLAY, "headless trial must not connect to display servers");
for (const file of ["/usr/bin/infocmp", "/usr/sbin/cupsd", "/usr/lib/cups/backend/ipp", "/lib/systemd/systemd-homed", "/usr/lib/systemd/systemd-homed"]) {
  assert.equal(existsSync(file), false, `unexpected vulnerable entry point: ${file}`);
}
const packages = execFileSync("dpkg-query", ["-W", "-f", "${binary:Package} ${db:Status-Status}\\n"], { encoding: "utf8" });
assert.doesNotMatch(packages, /^(libxml2-utils|python3-libxml2|llvm-19|llvm-19-tools|cups-daemon|cups-ipp-utils|systemd-homed|xserver-xorg-core|xvfb)(?::\S+)? installed$/m);
const perlModule = execFileSync("perl", ["-e", 'print eval { require Archive::Tar; 1 } ? "present" : "absent"'], { encoding: "utf8" });
assert.equal(perlModule, "absent", "Archive::Tar must not be shipped in the trial image");

const expectedCommit = process.env.LINKI_EXPECTED_COMMIT;
const expectedDigest = process.env.LINKI_EXPECTED_IMAGE_DIGEST;
assert.ok(expectedCommit && expectedDigest, "Expected commit and image digest are required for smoke test");

const temporary = mkdtempSync(path.join(tmpdir(), "linki-container-smoke-"));
const port = 31459;
const url = `http://127.0.0.1:${port}`;
const internalSecret = randomBytes(48).toString("base64url");
const env = {
  ...process.env,
  NODE_ENV: "production",
  NEXTAUTH_URL: url,
  NEXTAUTH_SECRET: randomBytes(48).toString("base64url"),
  AUTH_PASSWORD: randomBytes(32).toString("base64url"),
  INTERNAL_API_SECRET: internalSecret,
  LINKI_DB_PATH: path.join(temporary, "linki.db"),
  LINKI_DISABLE_BACKGROUND: "1",
  PORT: String(port),
  HOSTNAME: "127.0.0.1",
};
const server = spawn(process.execPath, ["--import", "tsx", "scripts/start-server.mjs"], {
  cwd: process.cwd(), env, stdio: ["ignore", "pipe", "pipe"],
});
let serverError = "";
server.stderr.setEncoding("utf8");
server.stderr.on("data", (chunk) => { serverError += chunk; });
let browser;
try {
  let ready = false;
  for (let attempt = 0; attempt < 100; attempt++) {
    if (server.exitCode !== null) throw new Error(`Server exited ${server.exitCode}: ${serverError.slice(-800)}`);
    try {
      const response = await fetch(`${url}/api/system/version`, { headers: { "x-internal-secret": internalSecret } });
      if (response.ok) { ready = true; break; }
    } catch { /* server starting */ }
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  assert.ok(ready, `Server did not start: ${serverError.slice(-800)}`);
  assert.equal((await fetch(`${url}/api/system/version`)).status, 401, "version endpoint must require authentication");
  browser = await chromium.launch({ headless: true, args: ["--no-sandbox"] });
  const page = await browser.newPage();
  await page.setExtraHTTPHeaders({ "x-internal-secret": internalSecret });
  await page.goto(`${url}/api/system/version`);
  const identity = JSON.parse(await page.locator("pre").innerText());
  assert.equal(identity.sourceCommit, expectedCommit);
  assert.equal(identity.imageDigest, expectedDigest);
  assert.equal(identity.version, process.env.APP_VERSION);
  await page.goto(`${url}/login`);
  assert.equal(await page.locator("h1").innerText(), "Linki");
  assert.equal(await page.locator('input[type="password"]').count(), 1);
  console.log(JSON.stringify({ ok: true, identity, browser: browser.version() }));
} finally {
  await browser?.close();
  server.kill("SIGTERM");
  rmSync(temporary, { recursive: true, force: true });
}
