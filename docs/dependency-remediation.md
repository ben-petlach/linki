# Dependency remediation

Baseline: reliability PR revision `379ea5c`. Verified with Node 22.23.1 and npm's
registry advisory feed on 2026-10-17. Audits include development dependencies.

| Severity | Before | After |
| --- | ---: | ---: |
| Critical | 3 | 0 |
| High | 24 | 0 |
| Moderate | 6 | 0 |
| Low | 1 | 0 |
| Total | 34 | 0 |

## Changes

- Upgrade Next and its ESLint configuration from 16.1.6 to 16.4.2; NextAuth from
  4.24.13 to 4.24.15. Keep the existing Pages Router and credentials provider.
  See [Next release](https://github.com/vercel/next.js/releases/tag/v16.4.2) and
  [Auth release](https://github.com/nextauthjs/next-auth/releases/tag/next-auth%404.24.15).
- Upgrade Nodemailer to 10.1.2 and Mailparser to 3.9.40. Scope a Nodemailer override
  to NextAuth so its unused optional email-provider peer cannot reinstall the
  vulnerable 7.x line. Linki uses CredentialsProvider, not EmailProvider. If email
  login is added, validate that provider against Nodemailer 10 before enabling it.
- Declare the already-imported `imap` directly at 0.8.19 with its type package;
  remove unused `imap-simple` and its declaration/types. Scope semver 5.7.2 to
  `utf7`: its only semver operation is `gte(process.version, '6.0.0')`, whose API
  remains compatible. Preserve TLS certificate validation and existing inbox logic.
- Remove unused `@modelcontextprotocol/sdk`, eliminating its unused server/OAuth
  dependency subtree. There are no source imports or nested MCP package in this
  repository. Refresh compatible transitive packages in the lockfile.
- Replace only the Next ESLint plugin's `fast-glob` dependency with the local
  `@linki/next-directory-glob` adapter backed by tinyglobby 0.2.15. The original
  chain includes [braces, with no patched release](https://github.com/advisories/GHSA-vfj7-8cjw-p6xm).
  The adapter implements the plugin's sole used call,
  `globSync(pattern, { onlyDirectories: true })`, preserves root-selection behavior,
  and rejects unsupported call shapes. It does not claim to implement all of
  fast-glob. The override references a root file dependency so clean installs use
  a portable path. All Next lint rules remain enabled. Recheck this boundary when
  upgrading the plugin; fixture tests verify actual rule behavior and resolution.

No advisory suppressions, audit exclusions, forced downgrade, `--force`, or
`--legacy-peer-deps` were used to obtain the clean audit. The lockfile contains the
actual patched graph and local development adapter; it does not relabel an
unmodified vulnerable package as patched.

## Verification

`npm ci` must succeed without peer bypass flags. CI then runs:

- `npm run audit:security` (fails on any high/critical finding or audit failure).
- `npm run test:dependencies` (directory resolution and real Next link rule).
- `npm run typecheck`, `npm run lint`, `npm run test:reliability`,
  `npm run test:integration`, and `npm run build`.
- Three consecutive crash/concurrency acceptance runs.

Auth regression tests exercise actual NextAuth signed sessions, malformed cookies
and Bearer headers, exact internal-secret matching, and bcrypt credentials. Mail
fixtures exercise local TLS SMTP and IMAP, invalid certificate rejection, threading,
reply/DSN handling, quotas, and idempotency. Tests use synthetic credentials/data;
no live outreach or account connection occurs.

The upgraded lint rules reveal two additional preexisting findings on unchanged
source lines. Both were reproduced by running the upgraded ESLint against the
original upstream `ef16caf` source, then added to the recorded baseline. The gate
still rejects new code diagnostics; 43 existing diagnostics remain, versus 41
before this dependency update. No rules were disabled.

Local final results: clean `npm ci` and `npm ls --all` pass; full audit zero;
54 package tests, 13 integration tests, and 4 dependency tests pass; three
crash/concurrency reruns pass 18/18 each; typecheck, lint gate, and build pass.
Independent read-only review found no unresolved critical/high issue in these
changes. GitHub acceptance checks on the PR verify the same gates on Ubuntu.

A clean advisory audit is a point-in-time dependency check, not proof that the
whole application is secure. The controlled-pilot boundaries and remaining live
provider verification in `core-reliability-acceptance.md` remain in force.
