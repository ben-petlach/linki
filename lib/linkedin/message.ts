import type { Page } from "playwright";
import { LinkedInLayoutError, normalizedProfileUrl, visitProfile } from "./visit";
import { outboundMessageIds } from "./inbox";

export class NotConnectedError extends Error {}
/** A click may have reached LinkedIn. Callers must hold for review, never retry blindly. */
export class UnconfirmedSendError extends Error {}

export interface SendMessageResult {
  messagingUrn: string;
  isFirstDegree: true;
  evidence: string;
}

/** Require fresh exact profile evidence even when a cached messaging URN exists. */
export async function sendMessage(
  page: Page,
  fullName: string,
  text: string,
  linkedinUrl: string,
  _cachedMessagingUrn?: string | null,
  beforeSend?: () => void
): Promise<SendMessageResult> {
  void _cachedMessagingUrn; // Kept for caller compatibility; only fresh profile evidence is trusted.
  const identity = normalizedProfileUrl(linkedinUrl);
  if (!identity) throw new LinkedInLayoutError("Target has no exact LinkedIn profile URL");
  const live = await visitProfile(page, identity);
  if (!live.isFirstDegree) throw new NotConnectedError(`${fullName} has no verified first-degree message link`);
  if (!live.messagingUrn) throw new LinkedInLayoutError("Connected profile has no messaging URN");

  const composeUrl = new URL("https://www.linkedin.com/messaging/compose/");
  composeUrl.searchParams.set("profileUrn", live.messagingUrn);
  composeUrl.searchParams.set("recipient", live.messagingUrn.split(":").pop()!);
  await page.goto(composeUrl.toString(), { waitUntil: "domcontentloaded", timeout: 30000 });
  if (!page.url().startsWith("https://www.linkedin.com/messaging/")) {
    throw new LinkedInLayoutError("LinkedIn compose unavailable or session checkpoint");
  }

  // The compose UI must independently confirm the recipient's exact profile.
  const recipientLinks = page.locator('.profile-card-one-to-one__profile-link[href*="/in/"]');
  const recipients = await recipientLinks.evaluateAll((nodes) =>
    nodes.map((node) => (node as HTMLAnchorElement).href)
  );
  if (recipients.length !== 1 || normalizedProfileUrl(recipients[0]) !== identity) {
    throw new LinkedInLayoutError("Compose recipient identity is missing or differs from target");
  }

  const msgInput = page.locator("div.msg-form__contenteditable");
  const sendBtn = page.locator("button.msg-form__send-button:visible");
  if (await msgInput.count() !== 1 || await sendBtn.count() !== 1) {
    throw new LinkedInLayoutError("LinkedIn compose controls missing or ambiguous");
  }
  let before: Set<string>;
  try {
    before = await outboundMessageIds(page, identity, text);
  } catch (error) {
    throw new LinkedInLayoutError(`Cannot establish LinkedIn outbound baseline: ${error instanceof Error ? error.message : String(error)}`);
  }
  await msgInput.fill(text);
  if ((await msgInput.innerText()).trim() !== text.trim()) {
    throw new LinkedInLayoutError("Composed message differs from requested text");
  }
  beforeSend?.();
  await sendBtn.click();

  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const after = await outboundMessageIds(page, identity, text);
      const evidence = [...after].find((id) => !before.has(id));
      if (evidence) return { messagingUrn: live.messagingUrn, isFirstDegree: true, evidence };
    } catch {
      // The click may have reached LinkedIn; retain the unknown outcome.
    }
    if (attempt < 3) await page.waitForTimeout(1500);
  }
  throw new UnconfirmedSendError("Send clicked but no new matching LinkedIn outbound event was observed");
}
