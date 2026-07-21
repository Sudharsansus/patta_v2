FROM mcr.microsoft.com/playwright:v1.48.0-jammy

WORKDIR /app

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
COPY combined ./combined

ENV NODE_ENV=production \
    PLAYWRIGHT_HEADLESS=true \
    PLAYWRIGHT_BROWSERS_PATH=/ms-playwright \
    PORT=8080

EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 \
  CMD curl -fsS http://localhost:${PORT:-8080}/health || exit 1

# Playwright/jammy base has no `node` OS user — boot as root, drop to pwuser for Chromium.
ENTRYPOINT ["/bin/sh", "-c", "exec runuser -u pwuser -- \"$@\"", "sh"]
CMD ["node", "combined/server.js"]
