FROM mcr.microsoft.com/playwright:v1.48.0-jammy

WORKDIR /app

# The Playwright base already contains browser OS libraries. Install the Node
# runtime and keep the image's package cache small.
RUN apt-get update && apt-get install -y --no-install-recommends curl ca-certificates && \
    curl -fsSL https://deb.nodesource.com/setup_22.x | bash - && \
    apt-get install -y --no-install-recommends nodejs && \
    rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund --loglevel=error && \
    PLAYWRIGHT_BROWSERS_PATH=/ms-playwright npx playwright install chromium

COPY lib ./lib
COPY bridge ./bridge
COPY data ./data
COPY public ./public
COPY server.js ./server.js

ENV NODE_ENV=production \
    PLAYWRIGHT_HEADLESS=true \
    PLAYWRIGHT_BROWSERS_PATH=/ms-playwright

# The Playwright/jammy base image has NO `node` OS user — only `pwuser` (uid 1000).
# Boot as root and drop to pwuser (keeps headless Chromium's sandbox working).
EXPOSE 3050
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 \
  CMD curl -fsS http://localhost:${PORT:-3050}/health || exit 1

ENTRYPOINT ["/bin/sh", "-c", "exec runuser -u pwuser -- \"$@\"", "sh"]
CMD ["node", "server.js"]
