FROM mcr.microsoft.com/playwright:v1.48.0-jammy

WORKDIR /app

# The Playwright base already contains browser OS libraries. Install the Node
# runtime used by this service and keep the image's package cache small.
RUN apt-get update && apt-get install -y --no-install-recommends curl ca-certificates && \
    curl -fsSL https://deb.nodesource.com/setup_22.x | bash - && \
    apt-get install -y --no-install-recommends nodejs && \
    rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund --loglevel=error && \
    PLAYWRIGHT_BROWSERS_PATH=/ms-playwright npx playwright install chromium

COPY lib ./lib
COPY bot ./bot
COPY bridge ./bridge
COPY data ./data
COPY public ./public
COPY register ./register

ENV NODE_ENV=production \
    PLAYWRIGHT_HEADLESS=true \
    PLAYWRIGHT_BROWSERS_PATH=/ms-playwright

# NOTE: the Playwright/jammy base image has NO `node` OS user — only `pwuser`
# (uid 1000). So we do NOT `USER node` (that made runc kill the machine on
# boot: `couldn't find user "node"`). Instead the entrypoint boots as root and
# drops to pwuser to run the app — which keeps headless Chromium's sandbox
# working. (There is no longer a /data volume to chown: the app is stateless,
# with durable state in Postgres + Tigris/S3.)

EXPOSE 3030
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 \
  CMD curl -fsS http://localhost:${PORT:-3030}/health || exit 1

ENTRYPOINT ["/bin/sh", "-c", "exec runuser -u pwuser -- \"$@\"", "sh"]
CMD ["node", "bot/server.js"]
