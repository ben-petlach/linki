import { test } from "node:test";
import assert from "node:assert/strict";
import { chromium } from "playwright";
import { sendConnectionRequest, UnconfirmedConnectionError } from "../../lib/linkedin/connect";

const chrome = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ??
  (process.platform === "darwin" ? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" : undefined);
const target = "https://www.linkedin.com/in/alex-smith";

async function fixture(confirmPending: boolean, immediate = false) {
  const browser = await chromium.launch({ headless: true, executablePath: chrome });
  const page = await browser.newPage();
  let clicked = false;
  let initialClicked = false;
  await page.exposeFunction("recordInvite", () => { clicked = true; });
  await page.exposeFunction("recordStart", () => { initialClicked = true; });
  await page.route("https://www.linkedin.com/in/alex-smith", async (route) => {
    await route.fulfill({ contentType: "text/html", body: `<main><section><h1>Alex Smith</h1>
      ${clicked && confirmPending ? '<button aria-label="Pending invitation">Pending</button>' : immediate ? '<a aria-label="Invite Alex to connect" href="#" onclick="window.recordStart();window.recordInvite();return false">Connect</a>' : '<button aria-label="More" onclick="document.querySelector(\'#menu\').hidden=false">More</button>'}
      </section></main>
      <div id="menu" hidden><button role="menuitem" onclick="document.querySelector(\'#send\').hidden=false">Connect</button></div>
      <button id="send" hidden onclick="window.recordInvite()">Send now</button>` });
  });
  return { browser, page, wasSent: () => clicked, wasInitialClicked: () => initialClicked };
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

test("dispatch gate stops a potentially immediate invitation before first Connect click", async () => {
  const { browser, page, wasSent, wasInitialClicked } = await fixture(true, true);
  try {
    await assert.rejects(sendConnectionRequest(page, target, () => {
      throw new Error("suppressed");
    }), /suppressed/);
    assert.equal(wasInitialClicked(), false);
    assert.equal(wasSent(), false);
  } finally { await browser.close(); }
});

test("immediate Connect send returns only after pending state on exact profile", async () => {
  const { browser, page, wasInitialClicked } = await fixture(true, true);
  try {
    assert.deepEqual(await sendConnectionRequest(page, target, () => {}), { evidence: `pending:${target}` });
    assert.equal(wasInitialClicked(), true);
  } finally { await browser.close(); }
});

test("modal confirmation rechecks policy after first Connect click", async () => {
  const { browser, page, wasSent } = await fixture(true);
  try {
    await assert.rejects(sendConnectionRequest(page, target, () => {}, () => {
      throw new Error("reply arrived");
    }), /reply arrived/);
    assert.equal(wasSent(), false);
  } finally { await browser.close(); }
});
