# Core reliability acceptance

Upstream baseline: `moaljumaa/linki@ef16caf484a7bbcc9a3ef480ad8711e571e9edf2`.
This phase delivers five reliability packages. It does not establish feature parity
with lemlist, Gojiberry, or Origami, or authorize production migration.

## Reproduce

Use Node 22 (`.nvmrc`), `npm ci`, and `npx playwright install chromium`.
Run `npm run typecheck`, `npm run lint`, `npm run test:reliability`,
`npm run test:integration`, `npm run test:dependencies`, `npm run audit:security`,
and `npm run build`.
The GitHub Actions workflow runs these gates and repeats crash/concurrency tests
three times. Tests use synthetic data, real SQLite, local browser pages, and local
SMTP/IMAP fixtures. The test bootstrap blocks non-local Node socket connections;
browser fixtures intercept requests. No production accounts or outreach are used.

## Acceptance mapping

| Package | Required behavior | Executable evidence |
| --- | --- | --- |
| Sender state | Sender A's relationship never authorizes sender B; global legacy fields remain audit-only; exact identities, complete paginated evidence, and repeatable migrations | `tests/reliability/state.test.ts`: two-sender isolation, incomplete scan, exact vanity, duplicate sync, two DB reopens |
| Sender state | Older overlapping scans cannot erase newer failure; ambiguous existing outreach cannot resume automatically | `state.test.ts`: freshness fencing and legacy-run quarantine; integration `getDb` migration/reopen checks |
| Durable dispatch | Only one worker owns action; stale claims recover before dispatch; sending/unknown actions never retry automatically; confirmed actions never resend | `tests/reliability/dispatch.test.ts`: fencing, leases, two SQLite connections; `tests/integration/core-reliability.test.ts`: real runner and restart recovery |
| Durable dispatch | Policy, sender, recipient, schedule, quota, reply and suppression gates run immediately before irreversible action | Integration production dispatch race cases and `tests/integration/dispatch-guards.test.ts` (separate runs, both channels, unrelated-target control, weekly cap, final modal recheck); LinkedIn final callback fixtures; email direct-route tests |
| LinkedIn | Exact profile and compose recipient required; click alone cannot confirm send; positive outbound event or pending invitation evidence required | `tests/reliability/linkedin-send.test.ts`, `linkedin-connect.test.ts`: exact identity, same-name wrong target, no acknowledgement, late policy block, immediate-send first-click gate |
| LinkedIn | Open-core inbox sync captures replies after invitation/message, deduplicates events, traverses pagination, rejects unknown/incomplete shapes | `tests/reliability/linkedin-inbox.test.ts`: cursor pages, normalized references, shallow envelope, legacy ambiguity, failed pagination |
| Email | Exact RFC threading plus sender attribution, durable Message-ID, duplicate handling, crash-window reply detection; replies and OOO stop automation across channels | `tests/reliability/email.test.ts`: threaded/unthreaded inbound, duplicate event, OOO, acceptance-before-local-confirmation; integration cross-channel pause |
| Email | Hard DSN suppresses exact address; temporary DSN does not; opt-out survives reimport; manual reply uses actual receiving account and proper thread headers | Email tests: hard/soft DSN, 17KB report, unsubscribe, two-sender inbox route, SMTP thread headers |
| Email | TLS certificate validation remains enabled; failed/stale mailbox sync blocks sending; direct paths enforce identity, idempotency, quota and late suppression | Email tests: rejected self-signed STARTTLS, trusted local TLS SMTP/IMAP, incomplete scan, verified sender, cap, changed payload, send-once, previous-day recovery, expired reservation and conservative legacy quota |
| Suppression | Person and company exclusions survive deletion/reimport; exact identifiers only; no name-only merge; sourced-only differs from contacted | `tests/reliability/suppression.test.ts`: alias conflicts, case-sensitive Sales Nav IDs, tombstones, company/domain exclusions, sourced-only and outreach history |
| Suppression | Enrollment and final dispatch enforce exclusions; simultaneous enrollment cannot duplicate outreach; own earlier send does not block legitimate follow-up | `tests/reliability/suppression-routes.test.ts`: actual routes and concurrent processes; suppression durable-history tests and integration late-exclusion races |

## Operational behavior and limits

- Unknown send outcomes are held for manual reconciliation. There is deliberately no
  automatic resend or bulk release. A provider acknowledgement means accepted,
  not delivered, read, or guaranteed inbox placement.
- Migration quarantines preexisting started/advanced runs with uncertain outreach.
  Legacy evidence is retained. New runs do not inherit unscoped relationships.
  Review the retained evidence before any manual removal of a legacy hold.
- Reply detection pauses automated outreach across channels. Incomplete inbox sync
  blocks dependent sends. Once a provider side effect has started, a later pause
  cannot retract it. Email freshness is five minutes; LinkedIn freshness thirty
  minutes. LinkedIn failures use a fifteen-minute retry cooldown.
- LinkedIn fixtures are based on a pinned open-source adapter, attributed in
  `THIRD_PARTY_NOTICES.md`. LinkedIn can change its UI/private API. Live behavior
  remains unverified; unknown response shapes stop sending. Premium InMail is
  blocked because this phase lacks a trustworthy acknowledgement adapter.
- Daily accounting is conservative and can reduce throughput when legacy logs and
  durable actions overlap. This phase prioritizes preventing oversend.
- No live accounts, provider credentials, real recipients, paid enrichment, CRM
  changes, deployment, or production migration were used. Controlled live pilot,
  deliverability checks, operational monitoring, and stack feature-parity assessment
  remain separate work.
- Upstream lint already had 42 diagnostics. `npm run lint` enforces no new
  diagnostics against the checked-in baseline; it is not a claim of zero lint debt.
  `npm run lint:all` shows the full inherited debt.
- Dependency remediation reduced the full audit from 34 findings (3 critical,
  24 high) to zero. See [changes and override rationale](dependency-remediation.md).
  CI blocks new high/critical findings. Passing dependency and reliability checks
  does not establish overall security readiness.

## Verification results

Local verification on Node 22.23.1, 2026-10-17:

- Package suite: 54/54 pass, zero skips.
- Integration suite: 13/13 pass, zero skips, including two-start legacy quarantine
  and three auth-upgrade regression tests.
- Dependency compatibility suite: 4/4 pass, zero skips.
- Full dependency audit: zero findings after clean `npm ci`; `npm ls --all` passes.
- Crash/concurrency subset: 18/18 pass in each of three consecutive runs.
  Command: `node --import ./tests/setup.mjs --import tsx --test tests/reliability/dispatch.test.ts tests/reliability/suppression-routes.test.ts tests/integration/*.test.ts`.
- `npm run typecheck` and `npm run build`: pass.
- `npm run lint`: zero new diagnostics; 43 inherited diagnostics remain; the upgraded lint rules exposed two additional
  findings reproduced on the original upstream source (documented in the dependency report).
- Independent read-only reviewers rechecked reported findings after fixes and
  found no unresolved critical/high issue in the changed state, LinkedIn, mail,
  or dispatch paths. This is a scoped code review, not a full security audit.
- Historical-sender scheduling in `tick` was code-reviewed; its full background
  loop has no dedicated network integration test. Individual mailbox adapters
  and dispatch gates have executable coverage. No live provider verification.

CI on [the draft PR](https://github.com/ben-petlach/linki/pull/1) repeats these gates
on Ubuntu from a clean install. Require its acceptance job to pass on the revision
being merged. No production-readiness claim follows from fixtures or a green build.
