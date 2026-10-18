import type { Page } from "playwright";
import { LinkedInLayoutError, normalizedProfileUrl, visitProfile } from "./visit";

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
  _cachedMessagingUrn?: string | null
): Promise<SendMessageResult> {
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
  const recipientLinks = page.locator('.msg-compose-recipient a[href*="/in/"], .msg-thread__link-to-profile[href*="/in/"]');
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
  const outbound = page.locator('.msg-s-message-list__event--outbound[data-event-id], [data-message-direction="outbound"][data-event-id]');
  const matchingCount = async () => (await outbound.allInnerTexts()).filter((body) => body.trim() === text.trim()).length;
  const before = await matchingCount();
  await msgInput.fill(text);
  if ((await msgInput.innerText()).trim() !== text.trim()) {
    throw new LinkedInLayoutError("Composed message differs from requested text");
  }
  await sendBtn.click();

  try {
    await page.waitForFunction(({ expected, previous }) => {
      const nodes = Array.from(document.querySelectorAll(
        '.msg-s-message-list__event--outbound[data-event-id], [data-message-direction="outbound"][data-event-id]'
      ));
      return nodes.filter((node) => node.textContent?.trim() === expected).length > previous;
    }, { expected: text.trim(), previous: before }, { timeout: 8000 });
  } catch {
    throw new UnconfirmedSendError("Send clicked but matching outbound message was not observed");
  }
  const matching = await outbound.evaluateAll((nodes, expected) => nodes
    .filter((node) => node.textContent?.trim() === expected)
    .map((node) => node.getAttribute("data-event-id") ?? ""), text.trim());
  const evidence = matching.at(-1);
  if (!evidence) throw new UnconfirmedSendError("Outbound message has no provider event identity");
  return { messagingUrn: live.messagingUrn, isFirstDegree: true, evidence };
}
