# Release and restore operations

This package has no production deployment or live-provider validation. The container is built from this fork. `docker-compose.yml` no longer pulls `moaljumaa/linki:latest`. Its Node 22 Debian 13 base is pinned by digest and refreshed with available OS security updates; Playwright installs the Chromium revision in `package-lock.json`. Headless runtime removes Xvfb and its server packages after browser installation; the image also removes npm's build-only package manager. CI must rebuild, run browser smoke tests, and scan OS/browser packages on every release. A browser update can invalidate LinkedIn cookies; reauthenticate under the new browser before an approved pilot.

## Runtime contract

Start through `scripts/start-server.mjs` (the Docker command). It rejects missing, short, or known-placeholder `NEXTAUTH_SECRET` and `AUTH_PASSWORD`, a nonlocal HTTP `NEXTAUTH_URL`, and relative `LINKI_DB_PATH` **before** starting Next or any background job. Do not put these values into image build arguments. Keep the same `NEXTAUTH_SECRET` with a restored database: it derives the key for encrypted provider credentials. Secrets and `.env.local` are never part of a database backup.

Authenticated `GET /api/system/version` returns `version`, `sourceCommit`, and `imageDigest`. Build with explicit commit/version arguments. An image cannot embed its own final digest, so set `LINKI_IMAGE_DIGEST` from the built image ID or registry digest at launch. `unavailable` means digest identity has not been verified; it must not be reported as a matched image. CI compares this endpoint, OCI revision label, built image ID, and checked-out commit.

Example for a local disposable instance (not a live account):

```sh
LINKI_SOURCE_COMMIT="$(git rev-parse HEAD)" APP_VERSION="$(git rev-parse --short HEAD)" docker compose build
docker image inspect "linki-local:$(git rev-parse --short HEAD)" --format '{{.Id}}'
```

Provide `NEXTAUTH_URL`, `NEXTAUTH_SECRET`, and `AUTH_PASSWORD` in `.env.local` before starting. Compose uses a named `linki_data` volume. Existing bind-mounted `./data` files require a deliberate migration into that volume; Compose does not silently adopt them.

## Backup and restore

Backups use SQLite's online backup API, which includes committed WAL transactions in a consistent snapshot. A SHA-256 manifest and SQLite integrity/foreign-key checks run before success. Output files use mode `0600`. Both commands refuse existing destinations, including a second attempt with the same path.

```sh
node --import tsx scripts/backup-database.mjs --source /data/linki.db --output /data/backup-2026-10-18.db
node --import tsx scripts/restore-database.mjs --backup /data/backup-2026-10-18.db --target /data/linki-restored.db
```

Restore copies to a temporary SQLite file, validates tables and foreign keys, changes running campaigns to `paused`, records a global dispatch pause with actor `system:restore`, then atomically publishes a **new** target path. The old DB is untouched. No send is attempted by either command. Keep the backup encrypted outside the host because it contains contact history and encrypted provider credentials. The matching `NEXTAUTH_SECRET` must be retained separately.

## Upgrade and rollback rehearsal

1. Stop the disposable instance. Make a backup to a new path. Record its SHA-256 manifest, source commit, and image ID.
2. Restore the backup to a separate staged DB path. Set `LINKI_DB_PATH` to that path and `LINKI_DISABLE_BACKGROUND=1` for rehearsal. Build the candidate image and start it with a test-only configuration. Confirm `/api/system/version`, integrity, foreign keys, suppression counts, action states, and global pause. Keep outbound disabled.
3. To roll back, stop the candidate. Restore the original backup to another **new** path. Start the previous tagged image with that path and background disabled. Confirm action IDs and counts match the pre-upgrade manifest. A confirmed action must never return to a dispatchable state; unknown actions remain held.
4. Preserve the staged DB and logs for diagnosis. Do not overwrite either DB. If events arrive after the backup, reconcile them before a real rollback; this rehearsal intentionally prevents them with background disabled.

Before any real upgrade, check that schema changes are backward compatible or supply a reviewed migration/rollback plan. This rehearsal proves a paused rollback from an unchanged snapshot, not lossless rollback after live inbound events.

CI must perform a clean `docker build` from the commit, launch bundled Chromium as the `node` user in that image, run a local fixture, verify the version endpoint against commit and image ID, and scan the built image's OS packages with Trivy (separate from `npm audit`). No registry push or deployment belongs in that gate.
