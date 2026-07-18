'use strict';

/**
 * Standalone REGISTER service (TNREGINET EC / Document Copy).
 * Runs as its OWN process/deploy, separate from the patta service. Serves the
 * /api/register/* API + the /ec tester UI. No API key (TNREGINET has no per-user
 * identity).
 */
require('dotenv').config({ quiet: true });

const path = require('path');
const express = require('express');
const register = require('./index');
const config = require('./config');

const PORT = process.env.PORT || 3040;

async function main() {
  const app = express();
  app.set('etag', false);
  app.use((req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
    if (req.method === 'OPTIONS') return res.sendStatus(204);
    next();
  });
  app.use(express.json({ limit: '2mb' }));
  app.use(express.static(path.join(__dirname, '..', 'public')));

  // Top-level health for the platform probe; root → the EC tester.
  app.get('/', (req, res) => res.redirect('/ec'));
  app.get('/health', (req, res) => res.json({
    ok: true, service: 'mpqr-register', testMode: config.testMode, captcha: config.captchaMode,
  }));

  register.mount(app); // /api/register/* + /ec

  const server = app.listen(PORT, () => {
    console.log(`[register] standalone service on http://localhost:${PORT}`);
    console.log('       GET  /ec                      (two-option tester UI)');
    console.log('       GET  /api/register/health');
    console.log('       POST /api/register/begin | /verify | /fetch  (see ARCHITECTURE)');
    console.log(`       testMode=${config.testMode}  captcha=${config.captchaMode}`);
  });
  server.on('error', (e) => { console.error('[register] listen failed:', e.message); process.exit(1); });

  let shuttingDown = false;
  const drain = (sig) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[register] ${sig} — draining…`);
    const hard = setTimeout(() => process.exit(0), 20000); hard.unref();
    server.close(() => { Promise.resolve(register.shutdown()).catch(() => {}).finally(() => process.exit(0)); });
  };
  process.on('SIGTERM', () => drain('SIGTERM'));
  process.on('SIGINT', () => drain('SIGINT'));
  process.on('unhandledRejection', (r) => console.error('[register] unhandledRejection', r));
  process.on('uncaughtException', (e) => { console.error('[register] uncaughtException', e); drain('uncaughtException'); });
}

main().catch((e) => { console.error('[register] fatal:', e.message); process.exit(1); });
