import type { Page } from "playwright";
import { assertProfilePage, LinkedInLayoutError, normalizedProfileUrl } from "./visit";

export class WeeklyLimitError extends Error {}
export class AlreadyConnectedError extends Error {}
export class PendingInviteError extends Error {}
/** An invitation click may have reached LinkedIn. Hold for review. */
export class UnconfirmedConnectionError extends Error {}

export async function sendConnectionRequest(page: Page, linkedinUrl: string, beforeSend?: () => void): Promise<{ evidence: string }> {
  const identity = normalizedProfileUrl(linkedinUrl);
  if (!identity) throw new LinkedInLayoutError("Target has no exact LinkedIn profile URL");
  await page.goto(identity, { waitUntil: "domcontentloaded", timeout: 30000 });
  await assertProfilePage(page, identity);
  const topCard = page.locator("main section").filter({ has: page.locator("h1") });
  if (await topCard.count() !== 1) throw new LinkedInLayoutError("Profile top card missing or ambiguous");
  if (await topCard.locator('a[href*="/messaging/compose"]').count()) {
    throw new AlreadyConnectedError("Already connected");
  }
  if (await topCard.locator('button[aria-label*="Pending"], [aria-label*="Invitation pending"]').count()) {
    throw new PendingInviteError("Invitation already pending");
  }

  const direct = topCard.locator('a[aria-label*="Invite"][aria-label*="to connect"], a[href*="custom-invite"]');
  if (await direct.count() === 1) {
    await direct.click();
  } else {
    const more = topCard.locator('button[aria-label="More"]');
    if (await more.count() !== 1) throw new LinkedInLayoutError("Connect control missing or ambiguous");
    await more.click();
    const connect = page.locator('[role="menuitem"]:has-text("Connect"):visible');
    if (await connect.count() !== 1) throw new LinkedInLayoutError("Connect menu item missing or ambiguous");
    await connect.click();
  }

  const send = page.locator('button:has-text("Send now"), button[aria-label*="Send without"], button[aria-label*="Send invitation"]:not([aria-label*="note"])');
  if (await send.count() !== 1) throw new LinkedInLayoutError("Invitation confirmation control missing or ambiguous");
  beforeSend?.();
  await send.click();
  const limitPopup = page.locator('div[class*="ip-fuse-limit-alert__warning"]');
  if (await limitPopup.count()) throw new WeeklyLimitError("Weekly connection limit reached");
  const errorToast = page.locator('div[data-test-artdeco-toast-item-type="error"]:visible');
  if (await errorToast.count()) throw new UnconfirmedConnectionError((await errorToast.innerText()).trim());

  // A click is not an invitation receipt. Revisit this exact profile and require
  // a positive pending state in its own top card.
  await page.goto(identity, { waitUntil: "domcontentloaded", timeout: 30000 });
  await assertProfilePage(page, identity);
  const verifiedCard = page.locator("main section").filter({ has: page.locator("h1") });
  if (await verifiedCard.count() !== 1 ||
      await verifiedCard.locator('button[aria-label*="Pending"], [aria-label*="Invitation pending"]').count() !== 1) {
    throw new UnconfirmedConnectionError("Invitation click has no verified pending state on target profile");
  }
  return { evidence: `pending:${identity}` };
}
