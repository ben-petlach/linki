import assert from "node:assert/strict";
import test from "node:test";
import Database from "better-sqlite3";
import type { Page } from "playwright";
import { getDb } from "../../lib/db";
import { syncLinkedInInbox } from "../../lib/linkedin/inbox";
import { recordInboxSyncSuccess } from "../../lib/reliability/inbox-state";
import { claimPoll, completePoll, stillOwnsPoll } from "../../lib/reliability/scheduler";
import { evaluateEligibility } from "../../lib/reliability/suppression";

test("old LinkedIn inbox scan cannot commit reply after another worker takes lease", async () => {
  const old = getDb();
  old.prepare("INSERT INTO accounts (id, name, email, is_authenticated) VALUES ('fenced-li', 'Fenced', 'fenced-li@example.test', 1)").run();
  old.prepare(`INSERT INTO targets (id, linkedin_url) VALUES
    ('fenced-li-target', 'https://www.linkedin.com/in/fenced-person')`).run();
  old.prepare("INSERT INTO workflows (id, name) VALUES ('fenced-li-flow', 'Fixture')").run();
  old.prepare("INSERT INTO runs (id, workflow_id, account_id, status) VALUES ('fenced-li-run', 'fenced-li-flow', 'fenced-li', 'completed')").run();
  old.prepare("INSERT INTO run_profiles (id, run_id, target_id) VALUES ('fenced-li-profile', 'fenced-li-run', 'fenced-li-target')").run();
  old.prepare("INSERT INTO run_profile_tracks (id, run_profile_id, track, state) VALUES ('fenced-li-track', 'fenced-li-profile', 'linkedin', 'completed')").run();
  old.prepare(`INSERT INTO dispatch_actions
    (action_key, state, token, dispatched_at, sender_id, target_id, channel, payload, evidence)
    VALUES ('fenced-li-action', 'confirmed', 'fixture', '2026-10-18T11:00:00Z', 'fenced-li',
      'fenced-li-target', 'message', 'Hello', 'provider-accepted')`).run();
  const start = new Date("2026-10-18T12:00:00.000Z");
  const newStart = new Date(start.getTime() + 600_001);
  const oldToken = claimPoll(old, "linkedin", "fenced-li", start);
  assert.ok(oldToken);
  const winner = new Database(process.env.LINKI_DB_PATH!);
  winner.pragma("foreign_keys = ON");
  let releaseGoto!: () => void;
  const waiting = new Promise<void>(resolve => { releaseGoto = resolve; });
  const self = "urn:li:fsd_profile:ACoAAASELF";
  const other = "urn:li:fsd_profile:ACoAAOTHER";
  const conversation = `urn:li:msg_conversation:(${self},2-thread)`;
  const selfParticipant = { hostIdentityUrn: self, participantType: { member: { profileUrl: "https://www.linkedin.com/in/sender" } } };
  const otherParticipant = { hostIdentityUrn: other, participantType: { member: { profileUrl: "https://www.linkedin.com/in/fenced-person" } } };
  const fakePage = {
    goto: async () => { await waiting; },
    url: () => "https://www.linkedin.com/messaging/",
    evaluate: async (_script: unknown, path: string) => {
      if (path === "/me") return { data: { "*miniProfile": "urn:li:fs_miniProfile:ACoAAASELF" },
        included: [{ entityUrn: "urn:li:fs_miniProfile:ACoAAASELF", dashEntityUrn: self }] };
      if (path.includes("messengerConversations")) return { data: { data: {
        messengerConversationsByCategoryQuery: { elements: [{ entityUrn: conversation,
          conversationParticipants: [selfParticipant, otherParticipant] }], metadata: {} },
      } }, included: [] };
      if (path.includes("messengerMessages")) return { data: { data: {
        messengerMessagesByConversation: { elements: [{ entityUrn: `urn:li:msg_message:(${self},2-in)`,
          deliveredAt: Date.parse("2026-10-18T11:30:00Z"), sender: otherParticipant }] },
      } }, included: [] };
      throw new Error(`Unexpected local fixture request: ${path}`);
    },
  } as unknown as Page;
  let observedTime = start;
  try {
    const oldScan = syncLinkedInInbox(old, "fenced-li", fakePage,
      () => stillOwnsPoll(old, "linkedin", "fenced-li", oldToken, observedTime));
    const newToken = claimPoll(winner, "linkedin", "fenced-li", newStart);
    assert.ok(newToken);
    recordInboxSyncSuccess(winner, { accountId: "fenced-li", channel: "linkedin", completedAt: newStart.toISOString() });
    assert.equal(completePoll(winner, "linkedin", "fenced-li", newToken, {}, newStart), true);
    observedTime = newStart;
    releaseGoto();
    await assert.rejects(oldScan, /Inbox lease lost/);
    assert.equal((winner.prepare("SELECT COUNT(*) AS count FROM linkedin_inbox_events WHERE account_id = 'fenced-li'")
      .get() as { count: number }).count, 0);
    assert.equal((winner.prepare("SELECT last_replied_at FROM targets WHERE id = 'fenced-li-target'")
      .get() as { last_replied_at: string | null }).last_replied_at, null);
    assert.equal(evaluateEligibility(winner, "fenced-li-target", { channel: "linkedin" }).allowed, true);
    assert.equal((winner.prepare("SELECT last_success_at FROM scheduler_poll_state WHERE channel = 'linkedin' AND account_id = 'fenced-li'")
      .get() as { last_success_at: string }).last_success_at, newStart.toISOString());
  } finally {
    releaseGoto();
    winner.close();
  }
});
