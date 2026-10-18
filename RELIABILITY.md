# Core reliability implementation contract

Baseline: moaljumaa/linki ef16caf484a7bbcc9a3ef480ad8711e571e9edf2.

All verification uses synthetic records and local fixtures. Never connect production
accounts, send external outreach, access production data, or buy services.

## Ownership

- State agent: lib/reliability/relationships.ts, lib/reliability/inbox-state.ts,
  lib/linkedin/sync-accepted.ts, pages/api/accounts/[id]/sync-accepted.ts and its tests.
- Dispatch agent: lib/reliability/actions.ts, lib/linkedin/runner.ts and its tests.
- LinkedIn agent: lib/linkedin/message.ts, visit.ts, connect.ts, new inbox adapter,
  session.ts if required, and its tests. Coordinate sync helpers with state agent.
- Email agent: lib/email/**, direct email send API routes and its tests.
- Suppression agent: lib/reliability/suppression.ts, enrollment/import/target routes,
  lib/csv-import.ts and its tests.
- Orchestrator: package files, test harness, CI, lib/db.ts initialization, shared
  integration tests, integration branch, and conflict resolution.

Do not edit another owner's files; request integration changes with exact code.
Each module owns an idempotent initializer taking a better-sqlite3 Database.
No module initializer may connect to external services.

## Shared semantics

- All relationship evidence is scoped to (account_id, target_id). Legacy ambiguous
  state is preserved for audit, but is not trusted to send.
- Identity uses exact normalized profile/email identifiers; names never establish
  identity. No substring identity matches.
- Every dispatch needs a stable action key and durable state. Unknown outcome
  requires reconciliation or review. Never automatically resend unknown actions.
- A worker that loses ownership must not dispatch. In-flight dispatched actions
  cannot be stolen on lease expiry.
- Detected inbound replies pause all subsequent automated outreach to that person,
  including out-of-office replies. No automatic AI-based resumption in this phase.
- Required inbox freshness is checked before dispatch; stale/failed/incomplete sync
  blocks dependent sends. Sync success must represent complete evidence.
- Suppression is checked at enrollment and immediately before dispatch, including
  retries and direct-send paths. Person/company exclusions survive reimports.
- External acceptance is distinct from delivered/read. Provider acknowledgement or
  matching observed outbound evidence may confirm sending, never a button click alone.

## Test conventions

Use node:test with TypeScript through tsx (or .cjs fixtures where appropriate).
Place package tests in tests/reliability/<package>*.test.ts. Use real in-memory or
temporary SQLite databases and local browser/mail fixtures. Tests must exercise
production implementations, not copies of their logic. Record baseline failures
where possible. Integration tests live in tests/integration/.

Each package must report acceptance criteria covered, commands/results, and gaps.
No production-readiness claim follows from fixture tests alone.
