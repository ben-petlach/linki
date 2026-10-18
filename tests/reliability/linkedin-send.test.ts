import { test } from "node:test";
import assert from "node:assert/strict";
import { chromium, type Browser, type Page } from "playwright";
import { sendMessage, UnconfirmedSendError } from "../../lib/linkedin/message";
import { LinkedInLayoutError } from "../../lib/linkedin/visit";

const target = "https://www.linkedin.com/in/alex-smith";
const urn = "urn:li:fsd_profile:ACoAAtarget";
const chrome = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

async function fixture(composeRecipient: string, acknowledge: boolean) {
  const browser: Browser = await chromium.launch({ headless: true, executablePath: chrome });
  const page = await browser.newPage();
  await page.route("https://www.linkedin.com/**", async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname.startsWith("/in/")) {
      await route.fulfill({ contentType: "text/html", body: `<main><section><h1>Alex Smith</h1><a href="/messaging/compose/?profileUrn=${encodeURIComponent(urn)}">Message</a></section></main>` });
    } else if (url.pathname.startsWith("/messaging/compose/")) {
      await route.fulfill({ contentType: "text/html", body: `
        <div class="msg-compose-recipient"><a href="${composeRecipient}">Alex Smith</a></div>
        <div class="msg-form__contenteditable" contenteditable="true"></div>
        <button class="msg-form__send-button" onclick="${acknowledge ? "const e=document.createElement('div');e.setAttribute('data-message-direction','outbound');e.setAttribute('data-event-id','msg-123');e.textContent=document.querySelector('.msg-form__contenteditable').textContent;document.body.append(e)" : "void 0"}">Send</button>` });
    } else {
      await route.fulfill({ status: 404, body: "unknown fixture" });
    }
  });
  return { browser, page };
}

test("send requires exact compose recipient and observed outbound event", async () => {
  const { browser, page } = await fixture(target, true);
  try {
    const result = await sendMessage(page, "Alex Smith", "Hello Alex", target, "urn:li:fsd_profile:wrong");
    assert.equal(result.evidence, "msg-123");
    assert.equal(result.messagingUrn, urn);
  } finally { await browser.close(); }
});

test("same name with a different profile cannot receive message", async () => {
  const { browser, page } = await fixture("https://www.linkedin.com/in/alex-smith-2", true);
  try {
    await assert.rejects(sendMessage(page, "Alex Smith", "Hello", target), LinkedInLayoutError);
    assert.equal(await page.locator('[data-message-direction="outbound"]').count(), 0);
  } finally { await browser.close(); }
});

test("button click without outbound evidence is unknown", async () => {
  const { browser, page } = await fixture(target, false);
  try {
    await assert.rejects(sendMessage(page, "Alex Smith", "Hello", target), UnconfirmedSendError);
  } finally { await browser.close(); }
});
