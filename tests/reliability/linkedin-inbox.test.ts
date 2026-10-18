import { test } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { chromium } from "playwright";
import { syncLinkedInInbox, IncompleteLinkedInInboxError } from "../../lib/linkedin/inbox";
import { initInboxStateSchema, getInboxFreshness } from "../../lib/reliability/inbox-state";
import { initSuppressionSchema, evaluateEligibility } from "../../lib/reliability/suppression";

const chrome = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

function database() {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE accounts (id TEXT PRIMARY KEY);
    CREATE TABLE companies (id TEXT PRIMARY KEY, domain TEXT);
    CREATE TABLE targets (id TEXT PRIMARY KEY, linkedin_url TEXT, email TEXT, company_id TEXT, message_sent_at TEXT, last_replied_at TEXT);
    CREATE TABLE runs (id TEXT PRIMARY KEY, account_id TEXT);
    CREATE TABLE run_profiles (id TEXT PRIMARY KEY, run_id TEXT, target_id TEXT);
    INSERT INTO accounts VALUES ('ben');
    INSERT INTO targets VALUES ('alex', 'https://www.linkedin.com/in/alex-smith', 'alex@example.com', NULL, '2026-10-17T12:00:00.000Z', NULL);
    INSERT INTO runs VALUES ('run1', 'ben');
    INSERT INTO run_profiles VALUES ('rp1', 'run1', 'alex');
  `);
  initInboxStateSchema(db);
  initSuppressionSchema(db);
  return db;
}

async function browserFixture(incomplete = false) {
  const browser = await chromium.launch({ headless: true, executablePath: chrome });
  const page = await browser.newPage();
  await page.route("https://www.linkedin.com/**", async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === "/messaging/" || url.pathname === "/messaging") {
      await route.fulfill({ contentType: "text/html", body: `
        <div class="msg-conversation-listitem">
          <a href="/messaging/thread/alex">Thread</a>
          <a href="/in/alex-smith">Alex Smith</a>
        </div>
        ${incomplete ? "" : '<button aria-label="Next page" disabled>Next</button>'}` });
    } else if (url.pathname === "/messaging/thread/alex") {
      await route.fulfill({ contentType: "text/html", body: `
        <a class="msg-thread__link-to-profile" href="/in/alex-smith">Alex Smith</a>
        <div class="msg-s-message-list__event msg-s-message-list__event--outbound" data-event-id="out-1"><time datetime="2026-10-17T12:00:00.000Z"></time>Hello</div>
        <div class="msg-s-message-list__event msg-s-message-list__event--inbound" data-event-id="in-1"><time datetime="2026-10-17T13:00:00.000Z"></time>No thanks</div>` });
    } else await route.fulfill({ status: 404, body: "unexpected" });
  });
  return { browser, page };
}

test("public inbox sync records verified reply once and suppresses cross-channel outreach", async () => {
  const db = database();
  const { browser, page } = await browserFixture();
  try {
    assert.equal(await syncLinkedInInbox(db, "ben", page), 1);
    assert.equal(await syncLinkedInInbox(db, "ben", page), 0);
    assert.equal((db.prepare("SELECT last_replied_at FROM targets WHERE id = 'alex'").get() as {last_replied_at:string}).last_replied_at, "2026-10-17T13:00:00.000Z");
    assert.equal(evaluateEligibility(db, "alex").allowed, false);
    assert.equal(getInboxFreshness(db, { accountId: "ben", channel: "linkedin", maxAgeMs: 60000 }).fresh, true);
  } finally { await browser.close(); db.close(); }
});

test("incomplete pagination invalidates freshness and leaves reply unrecorded", async () => {
  const db = database();
  const { browser, page } = await browserFixture(true);
  try {
    await assert.rejects(syncLinkedInInbox(db, "ben", page), IncompleteLinkedInInboxError);
    assert.equal((db.prepare("SELECT last_replied_at FROM targets WHERE id = 'alex'").get() as {last_replied_at:string|null}).last_replied_at, null);
    assert.equal(getInboxFreshness(db, { accountId: "ben", channel: "linkedin", maxAgeMs: 60000 }).fresh, false);
  } finally { await browser.close(); db.close(); }
});
