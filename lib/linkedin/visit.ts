import type { Page } from "playwright";

export class LinkedInLayoutError extends Error {}
export class LinkedInSessionError extends Error {}

/** Only a profile URL is an identity. Display names and search results are not. */
export function normalizedProfileUrl(value: string): string | null {
  try {
    const url = new URL(value, "https://www.linkedin.com");
    if (!/(^|\.)linkedin\.com$/i.test(url.hostname)) return null;
    const match = url.pathname.match(/^\/in\/([^/]+)\/?$/i);
    if (!match) return null;
    return `https://www.linkedin.com/in/${decodeURIComponent(match[1]).toLowerCase()}`;
  } catch {
    return null;
  }
}

export async function assertProfilePage(page: Page, linkedinUrl: string): Promise<void> {
  const expected = normalizedProfileUrl(linkedinUrl);
  const actual = normalizedProfileUrl(page.url());
  if (!expected) throw new LinkedInLayoutError("Target has no exact LinkedIn profile identity");
  if (!actual) throw new LinkedInSessionError(`LinkedIn profile unavailable or session checkpoint: ${page.url()}`);
  if (actual !== expected) throw new LinkedInLayoutError(`Profile identity mismatch: expected ${expected}, got ${actual}`);
  if (await page.locator('form[action*="checkpoint"], input[name="session_key"], input#username').count()) {
    throw new LinkedInSessionError("LinkedIn login or checkpoint shown instead of profile");
  }
}

/** Fetch positive connection evidence from the visited person's own top card. */
export async function visitProfile(page: Page, linkedinUrl: string): Promise<{ isFirstDegree: boolean; messagingUrn: string | null }> {
  await page.goto(linkedinUrl, { waitUntil: "domcontentloaded", timeout: 30000 });
  await assertProfilePage(page, linkedinUrl);

  const cards = page.locator("main section").filter({ has: page.locator("h1") });
  if (await cards.count() !== 1) throw new LinkedInLayoutError("Profile top card is missing or ambiguous");
  const links = cards.first().locator('a[href*="/messaging/compose"]');
  if (await links.count() !== 1) return { isFirstDegree: false, messagingUrn: null };

  const href = await links.first().getAttribute("href");
  const urn = href ? new URL(href, "https://www.linkedin.com").searchParams.get("profileUrn") : null;
  if (!urn || !/^urn:li:(?:fsd_profile|member):[A-Za-z0-9_-]+$/.test(urn)) {
    throw new LinkedInLayoutError("Profile message link has no valid recipient identity");
  }
  return { isFirstDegree: true, messagingUrn: urn };
}
