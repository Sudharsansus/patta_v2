'use strict';

/**
 * REGISTER module entry. Mounts the isolated /api/register/* subsystem onto the
 * existing Express app (same process as patta, but its own pool/store/routes).
 * Must be mounted BEFORE the patta API-key gate — register needs no API key.
 */
const path = require('path');
const { build } = require('./routes');
const config = require('./config');
const store = require('./store');

let _router = null;

function mount(app) {
  if (_router) return _router;
  _router = build();
  app.use('/api/register', _router);
  // The two-option EC tester page (mirrors /patta's /dashboard). Test harness only.
  app.get('/ec', (req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'ec.html')));
  console.log(`[register] mounted /api/register (captcha=${config.captchaMode}, store=${store.backend()}, test=${config.testMode})`);
  return _router;
}

async function shutdown() {
  if (_router && _router._pool) { try { await _router._pool.shutdown(); } catch (_) {} }
  _router = null;
}

module.exports = { mount, shutdown };
