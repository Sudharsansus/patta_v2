'use strict';

/**
 * Captcha auto-solver (TrueCaptcha — apitruecaptcha.org).
 *
 * When CAPTCHA_MODE=truecaptcha and TRUECAPTCHA_USERID/APIKEY are set, the backend
 * solves TNREGINET captchas itself — so Quick EC works even with an empty pool, and
 * no human ever has to type a captcha. In test mode it returns a fixed fake solve.
 */
const axios = require('axios');
const config = require('./config');

function enabled() {
  return config.captchaMode === 'truecaptcha' && !!config.truecaptcha.userid && !!config.truecaptcha.apikey;
}

/** Solve a base64 PNG (with or without the data: prefix) → the captcha text. Throws on failure. */
async function solve(base64Image) {
  if (config.testMode) return '6Nk7pQ'; // fake, matches the FakeSession
  const { url, userid, apikey } = config.truecaptcha;
  if (!userid || !apikey) throw new Error('TrueCaptcha credentials not configured (TRUECAPTCHA_USERID/APIKEY)');
  const data = String(base64Image || '').replace(/^data:image\/\w+;base64,/, '');
  const r = await axios.post(url, { userid, apikey, data }, {
    timeout: config.captchaSolveTimeoutMs + 10000,
    validateStatus: () => true,
    headers: { 'Content-Type': 'application/json' },
  });
  const body = r.data || {};
  const text = body.result != null ? String(body.result) : null;
  if (r.status >= 400 || !text) {
    throw new Error('TrueCaptcha: ' + (body.error_message || body.message || body.status || `HTTP ${r.status}`));
  }
  return text.trim();
}

module.exports = { solve, enabled };
