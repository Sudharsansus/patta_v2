/**
 * MPQR A-Register (Adangal) OTP — REST API
 * ────────────────────────────────────────
 * SEPARATE service for the Tamil Nadu A-Register land record. Same government
 * portal + customer-OTP mechanics as patta — it REUSES the patta engine (lib/)
 * with formKind:'aregister', which drives the `areg_*.html` form and sends the
 * OTP with actionid AC02 (the form's own "Send OTP" button sets it). NONE of the
 * TNREGINET EC captcha/pool/TrueCaptcha lives here.
 *
 *   POST /api/aregister/start   { mobileNo, <parcel codes>, surveyNumber, ... } → { referenceId, ttlSeconds }
 *   POST /api/aregister/verify  { referenceId, otp }  → { data: <base64 A-Register PDF> }
 *   POST /api/aregister/resend  { referenceId }
 *   GET  /api/live/{districts,taluks,villages,subdivs}  → proxied from the patta service
 *   GET  /health
 *
 * Usage: PORT=3050 MPQR_API_KEY=... node aregister/server.js
 */

'use strict';

require('dotenv').config({ quiet: true });

const express = require('express');
const path = require('path');
const axios = require('axios');
const patBot = require('../lib');
const { generateMergedPdf } = require('../lib/pdf-generator');
const { browserStats } = require('../lib/browser-launcher');
const logger = require('../lib/logger');
const { classify, E } = require('../lib/errors');
const { makeBreaker } = require('../lib/govt-breaker');
const { IdempotencyCache } = require('../lib/verify-idempotency');
const { startMemWatchdog } = require('../lib/mem-watchdog');

const PORT = process.env.PORT || 3050;
const API_KEY = process.env.MPQR_API_KEY || 'dev-key-change-me';
const MACHINE_ID = process.env.FLY_MACHINE_ID || 'local';

// Location dropdowns come from the patta service's already-live, cached /api/live/*
// (so this service runs no data browser of its own for dropdowns).
const PATTA_URL = (process.env.PATTA_LIVE_URL || 'https://mpqr-pat-bot.fly.dev').replace(/\/$/, '');
const PATTA_KEY = process.env.PATTA_API_KEY || process.env.MPQR_API_KEY || '';

function makeRefId(pendingId) { return `${MACHINE_ID}.${pendingId}`; }
function parseRefId(referenceId) {
  const s = String(referenceId || '');
  const dot = s.indexOf('.');
  if (dot < 0) return { machineId: null, pendingId: s };
  return { machineId: s.slice(0, dot), pendingId: s.slice(dot + 1) };
}

async function pattaLive(reqPath) {
  const r = await axios.get(PATTA_URL + reqPath, {
    headers: { 'X-API-Key': PATTA_KEY }, timeout: 60000, validateStatus: () => true,
  });
  return r.data || {};
}

// The A-Register form is the SAME eservices form as patta (same field ids), so the
// parcel is built identically. The caller (tester UI) sends government codes, taken
// straight from the live dropdowns; name→code resolution is not needed here.
function toParcel(payload) {
  const p = payload || {};
  const rawSurvey = String(p.surveyNumber || p.surveyNo || '').trim();
  const survey = rawSurvey.split('/')[0].trim();
  const subdiv = String(p.subDivisionNumber || p.subDivNo || rawSurvey.split('/')[1] || '1').trim();
  const talukCode = String(p.talukCode || '').split('/')[0];
  const nflag = p.nflag || (String(p.talukCode || '').includes('/') ? String(p.talukCode).split('/')[1] : 'Y');
  return {
    districtCode: String(p.districtCode || ''),
    talukCode,
    villageCode: String(p.villageCode || ''),
    nflag,
    surveyNo: survey,
    subdivNo: subdiv,
    landType: (p.landType || 'R').toUpperCase() === 'N' ? 'N' : 'R',
    districtName: p.districtName,
    talukName: p.talukName,
    villageName: p.villageName,
    typeOfDocument: 'A-Register',
    memberId: p.memberId,
  };
}

const govtStart = makeBreaker('areg-start', async (mobile, payload) => {
  const parcel = toParcel(payload);
  if (!parcel.districtCode || !parcel.talukCode || !parcel.villageCode || !parcel.surveyNo) {
    throw E.INVALID_INPUT('districtCode, talukCode, villageCode and surveyNumber are required');
  }
  const out = await patBot.beginVerification(mobile, parcel);
  return { out, parcel };
}, { timeout: 120000 });
const govtVerify = makeBreaker('areg-verify', async (pendingId, otp) => (
  patBot.completeVerification(pendingId, otp)
), { timeout: 180000 });

const TERMINAL_CODES = new Set(['WRONG_OTP', 'CHITTA_UNAVAILABLE', 'RATE_LIMITED', 'INVALID_INPUT', 'SESSION_EXPIRED', 'VERIFY_EXPIRED']);
const idempotency = new IdempotencyCache({
  ttlMs: 300000, max: 32,
  keepRejection: (err) => TERMINAL_CODES.has(classify(err).code),
});

let shedding = false;
let shuttingDown = false;
let doDrain = () => process.exit(0);

function sendError(req, res, err, endpoint, meta = {}) {
  const e = classify(err);
  (req.log || logger).warn({ code: e.code, endpoint, refId: meta.referenceId }, e.message);
  return res.status(e.httpStatus).json({
    status: false, code: e.code, message: e.message, retryable: e.retryable,
    ...(meta.t0 ? { ms: Date.now() - meta.t0 } : {}),
  });
}

async function main() {
  console.log('[areg] Initializing MPQR A-Register OTP REST API...');
  await patBot.init({
    otpService: {
      formKind: 'aregister', // ← drive areg_*.html + OTP actionid AC02
      playwrightTimeoutMs: Number(process.env.PLAYWRIGHT_TIMEOUT_MS || 30000),
    },
  });

  const app = express();
  app.set('etag', false);
  app.use((req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-API-Key');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    if (req.method === 'OPTIONS') return res.sendStatus(204);
    next();
  });
  app.use(express.json({ limit: '2mb' }));

  app.get('/', (req, res) => res.redirect('/areg'));
  app.get('/areg', (req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'areg.html')));
  app.use(express.static(path.join(__dirname, '..', 'public')));

  app.get('/health', (req, res) => {
    const s = patBot.stats();
    const now = Date.now();
    const degraded = (s.warmPool && s.warmPool.depth === 0)
      || (s.lastGovtSuccessAt && now - s.lastGovtSuccessAt > 10 * 60 * 1000);
    res.json({
      ok: true, service: 'mpqr-aregister', machine: MACHINE_ID,
      degraded: !!degraded, shedding, shuttingDown,
      browsers: browserStats(), warmPool: s.warmPool, pending: s.pending,
    });
  });

  // API-key gate (/health + the tester page are open).
  app.use((req, res, next) => {
    if (req.path === '/health') return next();
    const key = req.headers['x-api-key'] || req.query.api_key;
    if (key !== API_KEY) return res.status(401).json({ status: false, message: 'unauthorized' });
    next();
  });

  // ── 1) START: send the OTP to the customer's mobile (actionid AC02) ───────
  app.post('/api/aregister/start', async (req, res) => {
    const t0 = Date.now();
    const p = req.body || {};
    if (shuttingDown || shedding) {
      return res.status(503).set('Retry-After', '5').json({ status: false, code: 'SHEDDING', message: 'Server busy, please retry shortly' });
    }
    try {
      const mobile = String(p.mobileNo || p.mobile || '').trim();
      if (!/^[6-9]\d{9}$/.test(mobile)) {
        return res.status(400).json({ status: false, code: 'INVALID_INPUT', message: 'Valid 10-digit mobileNo required' });
      }
      const { out, parcel } = await govtStart.fire(mobile, p);
      const referenceId = makeRefId(out.pendingId);
      (req.log || logger).info({ refId: referenceId, parcel: `${parcel.districtCode}/${parcel.talukCode}/${parcel.villageCode} ${parcel.surveyNo}/${parcel.subdivNo}`, ms: Date.now() - t0 }, 'A-Register OTP sent');
      return res.json({ status: true, message: 'OTP sent', referenceId, ttlSeconds: out.ttlSeconds, memberId: p.memberId || '' });
    } catch (e) {
      return sendError(req, res, e, 'start', { t0 });
    }
  });

  // ── 2) VERIFY: submit the OTP, return the A-Register as base64 PDF ────────
  app.post('/api/aregister/verify', async (req, res) => {
    const t0 = Date.now();
    const b = req.body || {};
    const referenceId = b.referenceId || b.pendingId || b.session_id;
    try {
      const otp = String(b.otp || '').trim();
      if (!referenceId || !/^\d{4,8}$/.test(otp)) {
        return res.status(400).json({ status: false, code: 'INVALID_INPUT', message: 'referenceId and a 4-8 digit otp are required' });
      }
      const { machineId, pendingId } = parseRefId(referenceId);
      if (machineId && machineId !== MACHINE_ID && machineId !== 'local') {
        res.set('fly-replay', `instance=${machineId}`);
        return res.status(202).json({ status: false, code: 'REPLAY', message: 'routing to the session owner' });
      }

      const verify = await idempotency.run(pendingId, otp, () => govtVerify.fire(pendingId, otp));
      const parcel = verify.opts || {};

      // Deliver the government's OWN rendered A-Register PDF (no branding, no FMB —
      // people print it as-is). Fall back to rendering the result HTML if needed.
      let pdfBuffer = verify.pdf ? Buffer.from(verify.pdf) : null;
      if (!pdfBuffer && verify.html) {
        try { pdfBuffer = await generateMergedPdf({ chittaHtml: verify.html }); }
        catch (mergeErr) { return sendError(req, res, mergeErr, 'verify', { t0, referenceId, wasted: true }); }
      }
      if (!pdfBuffer) return sendError(req, res, Object.assign(E.CHITTA_UNAVAILABLE('A-Register unavailable after OTP'), { wasted: true }), 'verify', { t0, referenceId });

      (req.log || logger).info({ refId: referenceId, bytes: pdfBuffer.length, ms: Date.now() - t0 }, 'A-Register delivered');
      return res.json({
        status: true, message: 'File generated successfully',
        data: pdfBuffer.toString('base64'), referenceId, memberId: parcel.memberId || '', ms: Date.now() - t0,
      });
    } catch (e) {
      return sendError(req, res, e, 'verify', { t0, referenceId });
    }
  });

  // ── 3) RESEND OTP ─────────────────────────────────────────────────────────
  app.post('/api/aregister/resend', async (req, res) => {
    const t0 = Date.now();
    const referenceId = (req.body || {}).referenceId || (req.body || {}).pendingId;
    try {
      const { machineId, pendingId } = parseRefId(referenceId);
      if (machineId && machineId !== MACHINE_ID && machineId !== 'local') {
        res.set('fly-replay', `instance=${machineId}`);
        return res.status(202).json({ status: false, code: 'REPLAY', message: 'routing to the session owner' });
      }
      const out = await patBot.resendOtp(pendingId);
      return res.json({ status: true, message: 'OTP resent', referenceId: makeRefId(out.pendingId), ttlSeconds: out.ttlSeconds });
    } catch (e) {
      return sendError(req, res, e, 'resend', { t0, referenceId });
    }
  });

  // ── Government dropdowns — proxied from the patta service's live cache ─────
  const live = (path) => async (req, res) => {
    try {
      const qs = req.url.includes('?') ? req.url.slice(req.url.indexOf('?')) : '';
      const j = await pattaLive('/api/live/' + path + qs);
      res.json(j);
    } catch (e) { return sendError(req, res, e, 'live', {}); }
  };
  app.get('/api/live/districts', live('districts'));
  app.get('/api/live/taluks', live('taluks'));
  app.get('/api/live/villages', live('villages'));
  app.get('/api/live/subdivs', live('subdivs'));

  const server = app.listen(PORT, () => {
    console.log(`[areg] MPQR A-Register OTP REST API on http://localhost:${PORT}  (machine ${MACHINE_ID})`);
    console.log('       POST /api/aregister/start   { mobileNo, districtCode, talukCode, villageCode, surveyNumber, subDivisionNumber, landType }');
    console.log('       POST /api/aregister/verify  { referenceId, otp }  → { data: <base64 A-Register PDF> }');
  });
  server.on('error', (e) => { console.error('[areg] listen failed:', e.message); process.exit(1); });

  // Keep the patta dropdown data-browser warm so District→Taluk→Village loads stay
  // fast (~0.5s). Left idle it cold-starts (~25s) and the taluk dropdown looks stuck.
  const keepDropdownsWarm = () => {
    pattaLive('/api/live/districts').catch(() => {});
    pattaLive('/api/live/taluks?district=01').catch(() => {});
  };
  setTimeout(keepDropdownsWarm, 4000);
  const warmTimer = setInterval(keepDropdownsWarm, 8 * 60 * 1000);
  if (warmTimer.unref) warmTimer.unref();

  // ── Graceful, drain-correct shutdown (identical policy to patta) ──────────
  const drainAndExit = (sig) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.warn({ sig }, 'draining — shedding new starts, finishing in-flight verifies');
    const hard = setTimeout(() => process.exit(0), 28000); hard.unref();
    const tryExit = () => {
      if (patBot.busyCount() > 0) return;
      clearInterval(poll); clearTimeout(hard);
      try { server.close(() => {}); } catch (_) {}
      Promise.resolve(patBot.shutdown()).catch(() => {}).finally(() => process.exit(0));
    };
    const poll = setInterval(tryExit, 500); poll.unref();
    tryExit();
  };
  doDrain = drainAndExit;
  process.on('SIGTERM', () => drainAndExit('SIGTERM'));
  process.on('SIGINT', () => drainAndExit('SIGINT'));

  startMemWatchdog({
    getInflight: () => patBot.busyCount(),
    getWarming: () => patBot.warmingCount(),
    onShed: (on) => { shedding = on; },
    onDrain: () => drainAndExit('RSS'),
    logger,
  });
}

process.on('unhandledRejection', (reason) => { logger.error({ err: reason }, 'unhandledRejection'); });
process.on('uncaughtException', (err) => { logger.error({ err }, 'uncaughtException'); doDrain('uncaughtException'); });

main().catch((e) => { console.error('[areg] Fatal:', e.message); process.exit(1); });
