/**
 * MPQR Combined OTP — REST API (Patta + A-Register in ONE service)
 * ────────────────────────────────────────────────────────────────
 * Runs BOTH engines side by side so a single app/URL can download either document:
 *   • Patta/Chitta  → OTP actionid AC01, result merged with the FMB sketch.
 *   • A-Register    → OTP actionid AC02, the government's own PDF.
 * Two independent OtpService instances (formKind 'patta' / 'aregister') share the
 * global browser cap + the live dropdown data. Stateless; OTP state lives in RAM.
 *
 *   POST /api/patta/{start,verify,resend}
 *   POST /api/aregister/{start,verify,resend}
 *   GET  /api/live/{districts,taluks,villages,subdivs}
 *   GET  /health · GET /metrics
 *
 * Usage: PORT=8080 MPQR_API_KEY=... node combined/server.js
 */

'use strict';

require('dotenv').config({ quiet: true });

const express = require('express');
const path = require('path');
const pinoHttp = require('pino-http');
const { OtpService } = require('../lib');
const tnsLive = require('../bridge/tns-live');
const { generateMergedPdf } = require('../lib/pdf-generator');
const { extractFmb } = require('../lib/fmb-extractor');
const { browserStats } = require('../lib/browser-launcher');
const logger = require('../lib/logger');
const metrics = require('../lib/metrics');
const { classify, E } = require('../lib/errors');
const { makeBreaker } = require('../lib/govt-breaker');
const { IdempotencyCache } = require('../lib/verify-idempotency');
const { startMemWatchdog } = require('../lib/mem-watchdog');

const PORT = process.env.PORT || 8080;                 // App Runner sets PORT (default 8080)
const API_KEY = process.env.MPQR_API_KEY || 'dev-key-change-me';
const MACHINE_ID = process.env.FLY_MACHINE_ID || 'local';

const pwTimeout = Number(process.env.PLAYWRIGHT_TIMEOUT_MS || 30000);
const pattaSvc = new OtpService({ formKind: 'patta', playwrightTimeoutMs: pwTimeout });
const aregSvc = new OtpService({ formKind: 'aregister', playwrightTimeoutMs: pwTimeout });

function makeRefId(pendingId) { return `${MACHINE_ID}.${pendingId}`; }
function parseRefId(referenceId) {
  const s = String(referenceId || '');
  const dot = s.indexOf('.');
  if (dot < 0) return { machineId: null, pendingId: s };
  return { machineId: s.slice(0, dot), pendingId: s.slice(dot + 1) };
}

// ── NAME → government-code resolution (shared; live dropdowns) ────────────────
const norm = (s) => String(s == null ? '' : s).trim().toLowerCase();
function pick(list, name) {
  if (!Array.isArray(list)) return null;
  const n = norm(name); if (!n) return null;
  return list.find((x) => norm(x.name) === n)
    || list.find((x) => norm(x.name).includes(n) || n.includes(norm(x.name))) || null;
}
async function resolveGovCodes(p) {
  if (p.districtCode && p.talukCode && p.villageCode) {
    return {
      districtCode: String(p.districtCode),
      talukCode: String(p.talukCode).split('/')[0],
      villageCode: String(p.villageCode),
      nflag: p.nflag || (String(p.talukCode).includes('/') ? String(p.talukCode).split('/')[1] : 'Y'),
    };
  }
  const districts = await tnsLive.getDistricts();
  const d = pick(districts, p.districtName);
  if (!d) throw E.INVALID_INPUT(`Unknown district: "${p.districtName}"`);
  const taluks = await tnsLive.getTaluks(d.code);
  const t = pick(taluks, p.talukName);
  if (!t) throw E.INVALID_INPUT(`Unknown taluk: "${p.talukName}" in ${p.districtName}`);
  const villages = await tnsLive.getVillages(d.code, t.code);
  const v = pick(villages, p.villageName);
  if (!v) throw E.INVALID_INPUT(`Unknown village: "${p.villageName}" in ${p.talukName}`);
  return { districtCode: d.code, talukCode: t.code, villageCode: v.code, nflag: t.nflag || 'Y' };
}

function toParcel(payload, codes, docType) {
  const rawSurvey = String(payload.surveyNumber || payload.surveyNo || '').trim();
  const survey = rawSurvey.split('/')[0].trim();
  const subdiv = String(payload.subDivisionNumber || payload.subDivNo || rawSurvey.split('/')[1] || '1').trim();
  return {
    districtCode: codes.districtCode, talukCode: codes.talukCode, villageCode: codes.villageCode, nflag: codes.nflag,
    surveyNo: survey, subdivNo: subdiv,
    landType: (payload.landType || 'R').toUpperCase() === 'N' ? 'N' : 'R',
    districtName: payload.districtName, talukName: payload.talukName, villageName: payload.villageName,
    typeOfDocument: docType === 'aregister' ? 'A-Register' : 'Patta', memberId: payload.memberId,
  };
}

const TERMINAL_CODES = new Set(['WRONG_OTP', 'CHITTA_UNAVAILABLE', 'RATE_LIMITED', 'INVALID_INPUT', 'SESSION_EXPIRED', 'VERIFY_EXPIRED']);

let shedding = false;
let shuttingDown = false;
let doDrain = () => process.exit(0);

function sendError(req, res, err, endpoint, meta = {}) {
  const e = classify(err);
  metrics.errorsTotal.inc({ code: e.code, endpoint });
  if (endpoint === 'verify' && (e.wasted || err.wasted || e.code === 'CHITTA_UNAVAILABLE' || meta.wasted)) {
    metrics.otpWasted.inc({ reason: e.code });
  }
  (req.log || logger).warn({ code: e.code, endpoint, refId: meta.referenceId }, e.message);
  return res.status(e.httpStatus).json({
    status: false, code: e.code, message: e.message, retryable: e.retryable,
    ...(meta.t0 ? { ms: Date.now() - meta.t0 } : {}),
  });
}

// Build /start /verify /resend for one document engine.
function buildDocRoutes(app, { basePath, svc, docType }) {
  // Breaker tuned to only trip on a SUSTAINED real outage (not a few throttled blips),
  // and recover fast (8s) so it never blocks everyone for long. The proxy pool is the
  // real fix for throttling; this just stops a transient blip cascading to "everyone down".
  const BRK = { volumeThreshold: 12, errorThresholdPercentage: 70, resetTimeout: 8000 };
  const govtStart = makeBreaker(`${docType}-start`, async (mobile, payload) => {
    const codes = await metrics.timeStage('resolve', () => resolveGovCodes(payload));
    const parcel = toParcel(payload, codes, docType);
    const out = await metrics.timeStage('send', () => svc.beginVerification(mobile, parcel));
    return { out, parcel };
  }, { timeout: 120000, ...BRK });
  const govtVerify = makeBreaker(`${docType}-verify`, async (pendingId, otp) => (
    svc.completeVerification(pendingId, otp)
  ), { timeout: 180000, ...BRK });
  const idempotency = new IdempotencyCache({ ttlMs: 300000, max: 32, keepRejection: (err) => TERMINAL_CODES.has(classify(err).code) });

  app.post(`${basePath}/start`, async (req, res) => {
    const t0 = Date.now(); const p = req.body || {};
    if (shuttingDown || shedding) return res.status(503).set('Retry-After', '5').json({ status: false, code: 'SHEDDING', message: 'Server busy, please retry shortly', retryable: true });
    try {
      const mobile = String(p.mobileNo || p.mobile || '').trim();
      if (!/^[6-9]\d{9}$/.test(mobile)) return res.status(400).json({ status: false, code: 'INVALID_INPUT', message: 'Valid 10-digit mobileNo required', retryable: false });
      const { out, parcel } = await govtStart.fire(mobile, p);
      const referenceId = makeRefId(out.pendingId);
      (req.log || logger).info({ doc: docType, refId: referenceId, ms: Date.now() - t0 }, 'OTP sent');
      return res.json({ status: true, message: 'OTP sent', referenceId, ttlSeconds: out.ttlSeconds, memberId: p.memberId || '' });
    } catch (e) { return sendError(req, res, e, 'start', { t0 }); }
  });

  app.post(`${basePath}/verify`, async (req, res) => {
    const t0 = Date.now(); const b = req.body || {};
    const referenceId = b.referenceId || b.pendingId || b.session_id;
    try {
      const otp = String(b.otp || '').trim();
      if (!referenceId || !/^\d{4,8}$/.test(otp)) return res.status(400).json({ status: false, code: 'INVALID_INPUT', message: 'referenceId and a 4-8 digit otp are required', retryable: false });
      const { machineId, pendingId } = parseRefId(referenceId);
      if (machineId && machineId !== MACHINE_ID && machineId !== 'local') {
        res.set('fly-replay', `instance=${machineId}`);
        return res.status(202).json({ status: false, code: 'REPLAY', message: 'routing to the session owner' });
      }
      const verify = await idempotency.run(pendingId, otp, () => metrics.timeStage('verify', () => govtVerify.fire(pendingId, otp)));
      const parcel = verify.opts || {};

      let pdfBuffer;
      if (docType === 'patta') {
        // Patta: merge the chitta + FMB sketch into one branded-free PDF.
        const fmb = verify.html ? extractFmb(verify.html) : null;
        try {
          pdfBuffer = await metrics.timeStage('pdf', () => generateMergedPdf({
            chittaHtml: verify.html, chittaPdf: verify.pdf,
            fmbSketchUrl: (fmb && fmb.fmbUrl) || null,
            district: parcel.districtName || parcel.districtCode, taluk: parcel.talukName || parcel.talukCode,
            village: parcel.villageName || parcel.villageCode, surveyNo: parcel.surveyNo, subdivNo: parcel.subdivNo,
          }));
        } catch (mergeErr) {
          if (verify.pdf) {
            metrics.verifySuccess.inc();
            return res.json({ status: true, degraded: true, message: 'File generated (government PDF only)', data: Buffer.from(verify.pdf).toString('base64'), referenceId, memberId: parcel.memberId || '', ms: Date.now() - t0 });
          }
          return sendError(req, res, mergeErr, 'verify', { t0, referenceId, wasted: true });
        }
      } else {
        // A-Register: deliver the government's own rendered PDF as-is.
        pdfBuffer = verify.pdf ? Buffer.from(verify.pdf) : null;
        if (!pdfBuffer && verify.html) {
          try { pdfBuffer = await metrics.timeStage('pdf', () => generateMergedPdf({ chittaHtml: verify.html })); }
          catch (mergeErr) { return sendError(req, res, mergeErr, 'verify', { t0, referenceId, wasted: true }); }
        }
        if (!pdfBuffer) return sendError(req, res, Object.assign(E.CHITTA_UNAVAILABLE('A-Register unavailable after OTP'), { wasted: true }), 'verify', { t0, referenceId });
      }

      (req.log || logger).info({ doc: docType, refId: referenceId, bytes: pdfBuffer.length, ms: Date.now() - t0 }, 'PDF delivered');
      return res.json({ status: true, message: 'File generated successfully', data: pdfBuffer.toString('base64'), referenceId, memberId: parcel.memberId || '', ms: Date.now() - t0 });
    } catch (e) { return sendError(req, res, e, 'verify', { t0, referenceId }); }
  });

  app.post(`${basePath}/resend`, async (req, res) => {
    const t0 = Date.now(); const referenceId = (req.body || {}).referenceId || (req.body || {}).pendingId;
    try {
      const { machineId, pendingId } = parseRefId(referenceId);
      if (machineId && machineId !== MACHINE_ID && machineId !== 'local') {
        res.set('fly-replay', `instance=${machineId}`);
        return res.status(202).json({ status: false, code: 'REPLAY', message: 'routing to the session owner' });
      }
      const out = await svc.resendOtp(pendingId);
      return res.json({ status: true, message: 'OTP resent', referenceId: makeRefId(out.pendingId), ttlSeconds: out.ttlSeconds });
    } catch (e) { return sendError(req, res, e, 'resend', { t0, referenceId }); }
  });
}

async function main() {
  console.log('[combined] Initializing MPQR Patta + A-Register OTP REST API...');
  metrics.bindGauges(() => {
    const p = pattaSvc.stats(); const a = aregSvc.stats();
    return { browsers: browserStats(), warmPool: { depth: (p.warmPool ? p.warmPool.depth : 0) + (a.warmPool ? a.warmPool.depth : 0) }, pending: (p.pending || 0) + (a.pending || 0) };
  });

  const app = express();
  app.set('etag', false);
  app.use(pinoHttp({ logger, autoLogging: { ignore: (req) => req.url === '/health' || req.url === '/metrics' }, customLogLevel: (req, res, err) => (res.statusCode >= 500 || err ? 'error' : (res.statusCode >= 400 ? 'warn' : 'info')) }));
  app.use((req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-API-Key');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    if (req.method === 'OPTIONS') return res.sendStatus(204);
    next();
  });
  app.use(express.json({ limit: '2mb' }));

  // Static app (home → Patta / A-Register). Served open; API calls still need the key.
  // The '/' route comes FIRST + static index is disabled, so '/' serves app.html
  // (not any stray public/index.html).
  app.get('/', (req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'app.html')));
  app.use(express.static(path.join(__dirname, '..', 'public'), { index: false }));

  app.get('/health', (req, res) => {
    const p = pattaSvc.stats(); const a = aregSvc.stats(); const now = Date.now();
    const wp = (p.warmPool ? p.warmPool.depth : 0) + (a.warmPool ? a.warmPool.depth : 0);
    const lastOk = Math.max(p.lastGovtSuccessAt || 0, a.lastGovtSuccessAt || 0);
    res.json({ ok: true, service: 'mpqr-combined', machine: MACHINE_ID, degraded: wp === 0 || (lastOk && now - lastOk > 10 * 60 * 1000), shedding, shuttingDown, browsers: browserStats(), warmPool: { depth: wp }, pending: (p.pending || 0) + (a.pending || 0) });
  });

  // API-key gate (/, /health, static are open; everything under /api + /metrics needs the key).
  app.use((req, res, next) => {
    if (req.path === '/health' || !req.path.startsWith('/api') && req.path !== '/metrics') return next();
    const key = req.headers['x-api-key'] || req.query.api_key;
    if (key !== API_KEY) return res.status(401).json({ status: false, code: 'UNAUTHORIZED', message: 'unauthorized', retryable: false });
    next();
  });
  app.use((req, res, next) => { if (req.method === 'GET' && (req.path.startsWith('/api/') || req.path === '/metrics')) res.set('Cache-Control', 'no-store'); next(); });

  app.get('/metrics', async (req, res) => {
    try { res.set('Content-Type', metrics.register.contentType); res.end(await metrics.register.metrics()); }
    catch (e) { res.status(500).end(String(e && e.message)); }
  });

  buildDocRoutes(app, { basePath: '/api/patta', svc: pattaSvc, docType: 'patta' });
  buildDocRoutes(app, { basePath: '/api/aregister', svc: aregSvc, docType: 'aregister' });

  const live = (fn) => async (req, res) => { try { res.json({ status: true, ...(await fn(req)) }); } catch (e) { return sendError(req, res, e, 'live', {}); } };
  app.get('/api/live/districts', live(async () => ({ districts: await tnsLive.getDistricts() })));
  app.get('/api/live/taluks', live(async (req) => ({ taluks: await tnsLive.getTaluks(req.query.district) })));
  app.get('/api/live/villages', live(async (req) => ({ villages: await tnsLive.getVillages(req.query.district, req.query.taluk) })));
  app.get('/api/live/subdivs', live(async (req) => ({ subdivs: await tnsLive.getSubdivs(req.query.district, req.query.taluk, req.query.village, req.query.survey, req.query.nflag, req.query.landtype) })));

  const server = app.listen(PORT, () => {
    console.log(`[combined] MPQR Patta + A-Register OTP REST API on http://localhost:${PORT}  (machine ${MACHINE_ID})`);
    console.log('       POST /api/patta/{start,verify,resend} · POST /api/aregister/{start,verify,resend}');
    console.log('       GET  /api/live/{districts,taluks,villages,subdivs} · GET /metrics · GET /health');
  });
  server.on('error', (e) => { console.error('[combined] listen failed:', e.message); process.exit(1); });

  const busy = () => pattaSvc.busyCount() + aregSvc.busyCount();
  const warming = () => pattaSvc.warmingCount() + aregSvc.warmingCount();
  const drainAndExit = (sig) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.warn({ sig }, 'draining — shedding new starts, finishing in-flight verifies');
    const hard = setTimeout(() => process.exit(0), 28000); hard.unref();
    const tryExit = () => {
      if (busy() > 0) return;
      clearInterval(poll); clearTimeout(hard);
      try { server.close(() => {}); } catch (_) {}
      Promise.allSettled([pattaSvc.shutdown(), aregSvc.shutdown()]).finally(() => process.exit(0));
    };
    const poll = setInterval(tryExit, 500); poll.unref(); tryExit();
  };
  doDrain = drainAndExit;
  process.on('SIGTERM', () => drainAndExit('SIGTERM'));
  process.on('SIGINT', () => drainAndExit('SIGINT'));

  startMemWatchdog({ getInflight: busy, getWarming: warming, onShed: (on) => { shedding = on; }, onDrain: () => drainAndExit('RSS'), logger });
}

process.on('unhandledRejection', (reason) => { logger.error({ err: reason }, 'unhandledRejection'); });
process.on('uncaughtException', (err) => { logger.error({ err }, 'uncaughtException'); doDrain('uncaughtException'); });

main().catch((e) => { console.error('[combined] Fatal:', e.message); process.exit(1); });
