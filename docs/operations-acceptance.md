# Operations acceptance: packages 1–4

Scope: independent inbox scheduling; release, runtime, backup and restore; operator recovery and reporting; provider readiness. HubSpot remains the CRM. All fixtures use synthetic records and local services. No real provider connection, outreach, CRM write, or deployment is part of this phase.

This matrix defines the acceptance bar before implementation. An item counts as passing only when a test calls the production entry point and checks durable effects in a real SQLite database or built container. A mock-only implementation test does not satisfy it. The owning package must expose a narrow clock, network, or provider injection boundary where deterministic tests need one.

## Package 1: independent inbox and scheduler

| Criterion | Required executable proof |
| --- | --- |
| Email-only operation | Actual background tick polls a configured email account and processes a planted reply when no LinkedIn account is authenticated or assigned. Outbound remains subject to freshness and all existing gates. |
| Late replies | Tick polls sender accounts with completed or paused campaigns, including no remaining steps. Planted late reply is persisted once, attributed to exact sender and target, and blocks later dispatch across channels. |
| Account isolation | One failing account records a durable failure and backoff without preventing a healthy account from completing the same tick. Healthy account freshness advances; failed account freshness does not. |
| Competing workers and restart | Two SQLite connections/processes race for same due poll. Provider is invoked once; stale owner cannot commit success. Restart preserves due time, retry count, and backoff. Expired lease can be taken over safely. |
| Timing and gate | Fake-clock runs exercise polling interval, backoff boundary, working days, account timezone and DST. No send occurs when inbox freshness is stale or account is outside schedule. Tests call the actual background entry point. |

## Package 2: release, runtime security, and restore

| Criterion | Required executable proof |
| --- | --- |
| Hardened source and image identity | Default Compose builds the fork source at the checked-out commit; clean Docker build succeeds with local `vendor/fast-glob` present before `npm ci`; running image exposes matching commit and image digest. Browser fixture runs with browser installed in image. |
| Runtime secrets and credentials | Missing required secrets stop startup with a clear error. Synthetic credentials never appear in logs or exported backup. No route or startup path accepts a placeholder production secret. |
| Synthetic restore | Back up and restore into a clean instance. Compare contacts, companies, exclusions, durable actions including unknown holds, inbound/outbound history, and foreign keys. Restored instance starts globally paused and no tick sends. |
| Upgrade and rollback | Rehearse schema upgrade and offline rollback from synthetic snapshot. Completed actions stay completed, unknown outcomes stay held, and no action is replayed. |
| Container security | Scan installed OS and browser packages separately from `npm audit`; record any findings and block critical/high findings or document a concrete exception. |

## Package 3: operator recovery and reporting

| Criterion | Required executable proof |
| --- | --- |
| Review queue | Every held action shows exact sender, recipient, channel, reason, state, and durable evidence. Unknown outcome cannot be released for automatic retry without positive provider evidence; unresolved remains held after restart. |
| Audited reconciliation | Confirmed provider event may reconcile without a second send. Every resolution records operator, reason, evidence reference, timestamp and before/after state; stale or duplicate resolution fails safely. |
| Global pause | Production dispatch for every channel blocks while paused. Inbox polling continues and persists replies/opt-outs. Pause state survives restart. |
| Alerts | Stale inbox, failed worker, and growing hold queue produce alerts to local test sink. Repeated unchanged ticks do not duplicate an alert; changed state and recovery resolve or update it. |
| Metrics | Attempted, provider-accepted, replied, bounced, and unknown counts derive from durable event rows with no double counting. A fixture with one of each has exact expected totals after restart. |

## Package 4: provider compatibility and deliverability

| Criterion | Required executable proof |
| --- | --- |
| Provider failures | Local SMTP/IMAP and browser/session fixtures cover authentication expiry, disconnect, throttle, pagination, delayed reply, malformed response and provider rejection. Failure persists, applies backoff/hold, and cannot mark inbox fresh or send successful. |
| LinkedIn session recovery | Expired session or changed layout blocks sending before irreversible click, records actionable account status, and allows tested revalidation. No test uses a live LinkedIn account. |
| Sender readiness | DNS checks use injected resolver and report SPF, DKIM, and DMARC record presence or errors as diagnostics. Record presence does not prove alignment or inbox placement. Invalid TLS, credentials, or connection configuration fails connection verification. Diagnostic check never sends to a prospect. |
| One-click unsubscribe | Outbound mail carries valid `List-Unsubscribe` and `List-Unsubscribe-Post` headers with durable opaque token. Local request suppresses exact identity idempotently before any later dispatch; replay and forged token fail safely. |
| Bounce and complaint | Hard recipient bounce suppresses exact address. Provider complaint and sender-level threshold produce durable sender hold. Temporary bounce does not become permanent recipient suppression. Holds survive restart. |

## Cross-package gates

1. Rehearse synthetic run from scheduled tick through held action, operator review, reply, suppression, alert, backup/restore, and restart. Inject failures before and after provider acceptance. Require zero wrong-recipient sends, duplicate sends, suppression bypasses, or lost planted replies.
2. Existing core reliability, integration, and dependency suites remain green. Run typecheck, no-new-lint gate, audit, clean container build, and production build on the same commit. Repeat crash/concurrency acceptance subset three times.
3. Record each result with exact test name, command, commit, and any unsupported criterion below. Fixture success does not establish live provider compatibility, inbox placement, or readiness to retire vendors.

## Results

Independent suite, first pass on 2026-10-18 (Node 22.23.1):

- `node --import ./tests/setup.mjs --import tsx --test tests/operations/*.test.ts`: 25/25 pass. `tests/setup.mjs` rejects external Node sockets. Local SMTP uses a generated one-day certificate explicitly trusted by the child fixture; no TLS verification bypass. `npm run typecheck` passes.
- `tests/operations/scheduler-tick.test.ts`: production `tick` polls completed/paused email senders with no LinkedIn authentication, captures planted late reply, isolates failed account, limits hung poll, retries at durable boundary, continues inbound while globally paused, executes an email-only run, and checks Toronto spring/fall DST slots.
- `tests/operations/scheduler-lease.test.ts`, `inbound-fencing.test.ts`, and `linkedin-fencing.test.ts`: two SQLite connections prove one poll owner, durable backoff, stale token rejection, and no old-owner email or LinkedIn inbound mutation after a replacement poll succeeds. LinkedIn login redirect and Voyager HTTP 429 fail closed.
- `tests/operations/operator.test.ts`: held action shows immutable recipient, remains held without durable provider acceptance, reconciles accepted SMTP evidence without resend, audits actor/reason/evidence, deduplicates and resolves alerts, and counts durable event types separately.
- `tests/operations/backup-restore.test.ts`: production backup/restore APIs preserve synthetic reliability tables and email history, reject overwrite, keep encrypted password out of raw backup bytes, pause restored run and dispatch, and preserve confirmed/unknown action states.
- `tests/operations/runtime-cli.test.ts`: actual startup command rejects placeholder secrets before launching server without echoing values; backup/restore command line entry points preserve offline snapshot and publish paused instance.
- `tests/operations/dispatch-recovery.test.ts`: global pause blocks production direct send before SMTP; production dispatch removes only unaccepted pre-SMTP reservation, then retries same action with changed subject/payload and accepts one send; operator reconciliation during awaited adapter completion does not turn accepted send into unknown failure.
- `tests/operations/provider.test.ts`: signed one-click POST suppresses old and current identity across email edit, GET/forgery/replay are safe, DNS uses injected resolver, sender bounce/complaint holds persist, expired LinkedIn session blocks, and rendered local TLS SMTP mail contains the one-click headers and visible opt-out while a diagnostic message does not.

Provider failure mapping: authentication expiry and throttling use `tests/operations/linkedin-fencing.test.ts`; local IMAP disconnect, SMTP TLS certificate rejection, temporary and hard DSNs, and delayed SMTP acknowledgement use `tests/reliability/email.test.ts`; LinkedIn pagination, normalized response, and malformed continuation use `tests/reliability/linkedin-inbox.test.ts`; wrong-recipient and missing provider acknowledgement use `tests/reliability/linkedin-send.test.ts` and `linkedin-connect.test.ts`. The latest full suite must pass on the PR revision.

Still to verify before this package set is accepted: exact-commit clean container build and bundled browser smoke in CI (local Docker daemon unavailable); OS dependency scan; schema upgrade and offline rollback rehearsal; full same-commit acceptance rerun. DNS record presence is diagnostic only, not domain alignment or deliverability proof. Complaint ingestion is an authenticated adapter hook; no provider complaint integration is claimed.
