import { test } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { chromium } from "playwright";
import { syncLinkedInInbox, IncompleteLinkedInInboxError } from "../../lib/linkedin/inbox";
import { initInboxStateSchema, getInboxFreshness } from "../../lib/reliability/inbox-state";
import { initSuppressionSchema, evaluateEligibility } from "../../lib/reliability/suppression";
import { initActionSchema } from "../../lib/reliability/actions";

// Response shapes derive from OpenRecruiterTools/linkedin-toolkit
// extension/tests/fixtures/voyager/{conversations,conversationEvents}.json.
const chrome = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ??
  (process.platform === "darwin" ? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" : undefined);
const self = "urn:li:fsd_profile:ACoAAASELF";
const other = "urn:li:fsd_profile:ACoAAAOTHER";
const conversation = `urn:li:msg_conversation:(${self},2-thread)`;
const participant = (urn: string, profileUrl: string) => ({ hostIdentityUrn: urn,
  participantType: { member: { profileUrl } } });
const envelope = (name: string, elements: unknown[], metadata?: object) => ({
  data: { data: { [name]: { elements, ...(metadata ? { metadata } : {}) } } }, included: [],
});

function database() {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE accounts (id TEXT PRIMARY KEY);
    CREATE TABLE companies (id TEXT PRIMARY KEY, domain TEXT);
    CREATE TABLE targets (id TEXT PRIMARY KEY, linkedin_url TEXT, email TEXT, company_id TEXT, message_sent_at TEXT, last_replied_at TEXT);
    CREATE TABLE runs (id TEXT PRIMARY KEY, account_id TEXT);
    CREATE TABLE run_profiles (id TEXT PRIMARY KEY, run_id TEXT, target_id TEXT);
    INSERT INTO accounts VALUES ('ben');
    INSERT INTO targets VALUES ('alex', 'https://www.linkedin.com/in/alex-smith', 'alex@example.com', NULL, '2026-10-17T15:00:00.000Z', NULL);
    INSERT INTO runs VALUES ('run1', 'ben');
    INSERT INTO run_profiles VALUES ('rp1', 'run1', 'alex');
  `);
  initInboxStateSchema(db);
  initSuppressionSchema(db);
  initActionSchema(db);
  db.prepare(`INSERT INTO dispatch_actions
    (action_key, state, token, dispatched_at, sender_id, target_id, channel, payload, evidence)
    VALUES ('send-1', 'confirmed', 'tok', '2026-10-17 12:00:00', 'ben', 'alex', 'message', 'Hello', 'provider-msg-1')`).run();
  db.prepare(`INSERT INTO dispatch_actions
    (action_key, state, token, dispatched_at, sender_id, target_id, channel, payload, evidence)
    VALUES ('send-2', 'confirmed', 'tok', '2026-10-17 15:00:00', 'philipp', 'alex', 'message', 'Hello', 'provider-msg-2')`).run();
  return db;
}

async function browserFixture(incomplete = false) {
  const browser = await chromium.launch({ headless: true, executablePath: chrome });
  const page = await browser.newPage();
  await page.context().addCookies([{ name: "JSESSIONID", value: 'ajax:123', domain: ".linkedin.com", path: "/" }]);
  const requests: string[] = [];
  await page.route("https://www.linkedin.com/**", async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === "/messaging/") {
      await route.fulfill({ contentType: "text/html", body: "<main>Messaging</main>" });
      return;
    }
    requests.push(url.toString());
    if (url.pathname === "/voyager/api/me") {
      await route.fulfill({ json: { data: { "*miniProfile": "urn:li:fs_miniProfile:ACoAAASELF" }, included: [{ entityUrn: "urn:li:fs_miniProfile:ACoAAASELF", dashEntityUrn: self }] } });
    } else if (url.searchParams.get("queryId")?.startsWith("messengerConversations")) {
      const cursor = url.searchParams.get("variables")?.includes("nextCursor:page-2");
      const thread = { entityUrn: conversation,
        conversationParticipants: [participant(self, "https://www.linkedin.com/in/ben"), participant(other, "https://www.linkedin.com/in/alex-smith")],
      };
      const metadata = cursor ? {} : { nextCursor: "page-2" };
      await route.fulfill({ json: envelope("messengerConversationsByCategoryQuery", cursor ? [] : [thread], incomplete ? undefined : metadata) });
    } else if (url.searchParams.get("queryId")?.startsWith("messengerMessages")) {
      await route.fulfill({ json: envelope("messengerMessagesByConversation", [
        { entityUrn: `urn:li:msg_message:(${self},2-in)`, deliveredAt: Date.parse("2026-10-17T13:00:00Z"), sender: participant(other, "https://www.linkedin.com/in/alex-smith") },
        { entityUrn: `urn:li:msg_message:(${self},2-out)`, deliveredAt: Date.parse("2026-10-17T12:00:00Z"), sender: participant(self, "https://www.linkedin.com/in/ben") },
      ]) });
    } else await route.fulfill({ status: 404, body: "unexpected" });
  });
  return { browser, page, requests };
}

test("Voyager cursor sync records reply once and suppresses all channels", async () => {
  const db = database();
  const { browser, page, requests } = await browserFixture();
  try {
    assert.equal(await syncLinkedInInbox(db, "ben", page), 1);
    assert.equal(await syncLinkedInInbox(db, "ben", page), 0);
    assert.ok(requests.some((url) => decodeURIComponent(url).includes("nextCursor:page-2")));
    assert.equal((db.prepare("SELECT last_replied_at FROM targets WHERE id = 'alex'").get() as {last_replied_at:string}).last_replied_at, "2026-10-17T13:00:00.000Z");
    assert.equal(evaluateEligibility(db, "alex").allowed, false);
    assert.equal(getInboxFreshness(db, { accountId: "ben", channel: "linkedin", maxAgeMs: 60000 }).fresh, true);
  } finally { await browser.close(); db.close(); }
});

test("unknown pagination shape invalidates inbox freshness and records no reply", async () => {
  const db = database();
  const { browser, page } = await browserFixture(true);
  try {
    await assert.rejects(syncLinkedInInbox(db, "ben", page), IncompleteLinkedInInboxError);
    assert.equal((db.prepare("SELECT last_replied_at FROM targets WHERE id = 'alex'").get() as {last_replied_at:string|null}).last_replied_at, null);
    assert.equal(getInboxFreshness(db, { accountId: "ben", channel: "linkedin", maxAgeMs: 60000 }).fresh, false);
  } finally { await browser.close(); db.close(); }
});

test("reply after invitation alone blocks the first message", async () => {
  const db = database();
  db.prepare("DELETE FROM dispatch_actions WHERE action_key = 'send-1'").run();
  db.prepare(`INSERT INTO dispatch_actions
    (action_key, state, token, dispatched_at, sender_id, target_id, channel, payload, evidence)
    VALUES ('invite-1', 'confirmed', 'tok', '2026-10-17 12:00:00', 'ben', 'alex', 'connect', NULL, 'pending:alex')`).run();
  const { browser, page } = await browserFixture();
  try {
    assert.equal(await syncLinkedInInbox(db, "ben", page), 1);
    assert.equal(evaluateEligibility(db, "alex").allowed, false);
  } finally { await browser.close(); db.close(); }
});
