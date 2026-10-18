import { test } from "node:test";
import assert from "node:assert/strict";
import { chromium, type Browser } from "playwright";
import { sendMessage, UnconfirmedSendError } from "../../lib/linkedin/message";
import { LinkedInLayoutError } from "../../lib/linkedin/visit";

const target = "https://www.linkedin.com/in/alex-smith";
const urn = "urn:li:fsd_profile:ACoAAtarget";
const self = "urn:li:fsd_profile:ACoAAASELF";
const chrome = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ??
  (process.platform === "darwin" ? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" : undefined);

async function fixture(composeRecipient: string, acknowledge: boolean) {
  const browser: Browser = await chromium.launch({ headless: true, executablePath: chrome });
  const page = await browser.newPage();
  let sent = false;
  await page.exposeFunction("recordSent", () => { sent = true; });
  await page.context().addCookies([{ name: "JSESSIONID", value: "ajax:123", domain: ".linkedin.com", path: "/" }]);
  await page.route("https://www.linkedin.com/**", async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === "/voyager/api/me") {
      await route.fulfill({ json: { data: { "*miniProfile": "urn:li:fs_miniProfile:ACoAAASELF" }, included: [{ entityUrn: "urn:li:fs_miniProfile:ACoAAASELF", dashEntityUrn: self }] } });
    } else if (url.searchParams.get("queryId")?.startsWith("messengerConversations")) {
      await route.fulfill({ json: { data: { data: { messengerConversationsByCategoryQuery: { metadata: {}, elements: sent ? [{
        entityUrn: `urn:li:msg_conversation:(${self},2-thread)`,
        conversationParticipants: [
          { hostIdentityUrn: self, participantType: { member: { profileUrl: "https://www.linkedin.com/in/ben" } } },
          { hostIdentityUrn: urn, participantType: { member: { profileUrl: target } } },
        ],
      }] : [] } } }, included: [] } });
    } else if (url.searchParams.get("queryId")?.startsWith("messengerMessages")) {
      await route.fulfill({ json: { data: { data: { messengerMessagesByConversation: { elements: sent ? [{
        entityUrn: `urn:li:msg_message:(${self},2-msg-123)`, deliveredAt: Date.now(),
        sender: { hostIdentityUrn: self }, body: { text: "Hello Alex" },
      }] : [] } } }, included: [] } });
    } else if (url.pathname.startsWith("/in/")) {
      await route.fulfill({ contentType: "text/html", body: `<main><section><h1>Alex Smith</h1><a href="/messaging/compose/?profileUrn=${encodeURIComponent(urn)}">Message</a></section></main>` });
    } else if (url.pathname.startsWith("/messaging/compose/")) {
      await route.fulfill({ contentType: "text/html", body: `
        <a class="profile-card-one-to-one__profile-link" href="${composeRecipient}">Alex Smith</a>
        <div class="msg-form__contenteditable" contenteditable="true"></div>
        <button class="msg-form__send-button" onclick="${acknowledge ? "window.recordSent()" : "void 0"}">Send</button>` });
    } else await route.fulfill({ status: 404, body: "unknown fixture" });
  });
  return { browser, page, wasSent: () => sent };
}

test("send requires exact compose recipient and new provider outbound event", async () => {
  const { browser, page } = await fixture(target, true);
  try {
    const result = await sendMessage(page, "Alex Smith", "Hello Alex", target, "urn:li:fsd_profile:wrong");
    assert.equal(result.evidence, `urn:li:msg_message:(${self},2-msg-123)`);
    assert.equal(result.messagingUrn, urn);
  } finally { await browser.close(); }
});

test("same name with a different profile cannot receive message", async () => {
  const { browser, page, wasSent } = await fixture("https://www.linkedin.com/in/alex-smith-2", true);
  try {
    await assert.rejects(sendMessage(page, "Alex Smith", "Hello", target), LinkedInLayoutError);
    assert.equal(wasSent(), false);
  } finally { await browser.close(); }
});

test("button click without provider outbound event is unknown", async () => {
  const { browser, page } = await fixture(target, false);
  try { await assert.rejects(sendMessage(page, "Alex Smith", "Hello", target), UnconfirmedSendError); }
  finally { await browser.close(); }
});

test("final policy gate can stop prepared message before Send", async () => {
  const { browser, page, wasSent } = await fixture(target, true);
  try {
    await assert.rejects(sendMessage(page, "Alex Smith", "Hello", target, null, () => {
      throw new Error("reply arrived");
    }), /reply arrived/);
    assert.equal(wasSent(), false);
  } finally { await browser.close(); }
});
