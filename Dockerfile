# Digest pins the Node runtime. Rebuild and scan regularly for OS updates.
FROM node:22-trixie-slim@sha256:154ba2f4d6fec323d28e4f4bb86bba4677f1223391a1979cf521304e03a98dfa

WORKDIR /app

# Refresh packages already present in the digest before installing browser libs.
RUN apt-get update && apt-get upgrade -y --no-install-recommends \
    && rm -rf /var/lib/apt/lists/*

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

# Runtime starts with node directly. npm's bundled package manager graph is not
# needed after the build and carried separate high-severity findings.
RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/bin/npm /usr/local/bin/npx

RUN mkdir -p /data && chown node:node /data
ENV LINKI_DB_PATH=/data/linki.db
USER node
EXPOSE 3000

# Validation happens before Next starts listening or background jobs initialize.
CMD ["node", "--import", "tsx", "scripts/start-server.mjs"]
