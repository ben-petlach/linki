# Digest pins the Node runtime. Rebuild and scan regularly for OS updates.
FROM node:22-bookworm-slim@sha256:c3de60bf2f9dd0ac6370e6117950ff62d6e339527e7472301c9c78a017978392

WORKDIR /app

# npm ci resolves the local fast-glob override, so its package must exist first.
COPY package*.json ./
COPY vendor/fast-glob ./vendor/fast-glob
RUN npm ci

# Playwright's bundled Chromium revision follows package-lock.json. A stale Debian
# snapshot would freeze security updates and is not a safe fingerprint strategy.
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
RUN npx playwright install --with-deps chromium \
    && chmod -R a+rX /ms-playwright \
    && rm -rf /var/lib/apt/lists/*

COPY . .

ARG LINKI_SOURCE_COMMIT=unknown
ARG APP_VERSION=dev
LABEL org.opencontainers.image.revision=$LINKI_SOURCE_COMMIT
ENV LINKI_SOURCE_COMMIT=$LINKI_SOURCE_COMMIT
ENV APP_VERSION=$APP_VERSION

RUN LINKI_DISABLE_BACKGROUND=1 npm run build

RUN mkdir -p /data && chown node:node /data
ENV LINKI_DB_PATH=/data/linki.db
USER node
EXPOSE 3000

# Validation happens before Next starts listening or background jobs initialize.
CMD ["node", "--import", "tsx", "scripts/start-server.mjs"]
