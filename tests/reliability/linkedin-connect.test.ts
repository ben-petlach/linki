import { test } from "node:test";
import assert from "node:assert/strict";
import { chromium } from "playwright";
import { sendConnectionRequest, UnconfirmedConnectionError } from "../../lib/linkedin/connect";

const chrome = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const target = "https://www.linkedin.com/in/alex-smith";

async function fixture(confirmPending: boolean) {
  const browser = await chromium.launch({ headless: true, executablePath: chrome });
  const page = await browser.newPage();
  let clicked = false;
  await page.exposeFunction("recordInvite", () => { clicked = true; });
  await page.route("https://www.linkedin.com/in/alex-smith", async (route) => {
    await route.fulfill({ contentType: "text/html", body: `<main><section><h1>Alex Smith</h1>
      ${clicked && confirmPending ? '<button aria-label="Pending invitation">Pending</button>' : '<button aria-label="More" onclick="document.querySelector(\'#menu\').hidden=false">More</button>'}
      </section></main>
      <div id="menu" hidden><button role="menuitem" onclick="document.querySelector(\'#send\').hidden=false">Connect</button></div>
      <button id="send" hidden onclick="window.recordInvite()">Send now</button>` });
  });
  return { browser, page };
}

test("invitation requires exact profile pending evidence after click", async () => {
  const { browser, page } = await fixture(true);
  try {
    assert.deepEqual(await sendConnectionRequest(page, target), { evidence: `pending:${target}` });
  } finally { await browser.close(); }
});

test("click without pending evidence remains unconfirmed", async () => {
  const { browser, page } = await fixture(false);
  try {
    await assert.rejects(sendConnectionRequest(page, target), UnconfirmedConnectionError);
  } finally { await browser.close(); }
});
