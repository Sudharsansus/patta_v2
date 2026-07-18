/**
 * MPQR Patta OTP — REST API (patta only)
 * ──────────────────────────────────────
 * A lean, stateless service MyPropertyQR calls. No session pool, no Postgres,
 * no S3/cache. The customer's OTP is auto-read on THEIR device and posted back.
 *
 *   POST /api/patta/start   { ...MyPropertyQR payload }   → { referenceId, ttlSeconds }
 *   POST /api/patta/verify  { referenceId, otp }          → { data: <base64 PDF> }
 *   POST /api/patta/resend  { referenceId }               → { referenceId }
 *   GET  /api/live/{districts,taluks,villages,subdivs}    → govt dropdowns (code+name)
 *   GET  /metrics                                         → Prometheus (needs X-API-Key)
 *   GET  /health
 *
 * Usage: PORT=3030 MPQR_API_KEY=... node bot/server.js
 */

'use strict';

require('dotenv').config({ quiet: true });

const express = require('express');
const path = require('path');
const pinoHttp = require('pino-http');
const patBot = require('../lib');
const tnsLive = require('../bridge/tns-live');
const { generateMergedPdf } = require('../lib/pdf-generator');
const { extractFmb } = require('../lib/fmb-extractor');
const { browserStats } = require('../lib/browser-launcher');
const register = require('../register');   // isolated /api/register/* subsystem (TNREGINET EC)
const logger = require('../lib/logger');
const metrics = require('../lib/metrics');
const { classify } = require('../lib/errors');
const { makeBreaker } = require('../lib/govt-breaker');
const { IdempotencyCache } = require('../lib/verify-idempotency');
const { startMemWatchdog } = require('../lib/mem-watchdog');

const PORT = process.env.PORT || 3030;
const API_KEY = process.env.MPQR_API_KEY || 'dev-key-change-me';
// Identifies the machine that minted a referenceId, so a /verify that lands on a
// SIBLING machine (2-machine deploy) can be fly-replay'd to the one holding the
// in-RAM pending session. With one machine the prefix always matches → no replay.
const MACHINE_ID = process.env.FLY_MACHINE_ID || 'local';

// referenceId = "<machineId>.<pendingId>". parseRefId is tolerant of the old
// bare-pendingId format (machineId → null → treated as local).
function makeRefId(pendingId) { return `${MACHINE_ID}.${pendingId}`; }
function parseRefId(referenceId) {
  const s = String(referenceId || '');
  const dot = s.indexOf('.');
  if (dot < 0) return { machineId: null, pendingId: s };
  return { machineId: s.slice(0, dot), pendingId: s.slice(dot + 1) };
}

// ── NAME → government-code resolution ────────────────────────────────────────
// MyPropertyQR sends NAMES (Salem / Edappady / Pulampatti) + its own UUIDs. The
// government needs its own 2/2/3-digit codes, resolved LIVE from the govt
// dropdowns (the static CSV is only a tiny sample and can't cover every parcel).
// If the caller already sends govt codes, we use them directly.
const norm = (s) => String(s == null ? '' : s).trim().toLowerCase();

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
  if (!d) throw new Error(`Unknown district: "${p.districtName}"`);
  const taluks = await tnsLive.getTaluks(d.code);
  const t = pick(taluks, p.talukName);
  if (!t) throw new Error(`Unknown taluk: "${p.talukName}" in ${p.districtName}`);
  const villages = await tnsLive.getVillages(d.code, t.code);
  const v = pick(villages, p.villageName);
  if (!v) throw new Error(`Unknown village: "${p.villageName}" in ${p.talukName}`);
  return { districtCode: d.code, talukCode: t.code, villageCode: v.code, nflag: t.nflag || 'Y' };
}

// Exact name match, then a forgiving contains match (handles minor transliteration
// variants like Edappady/Edappadi).
function pick(list, name) {
  if (!Array.isArray(list)) return null;
  const n = norm(name);
  if (!n) return null;
  return list.find((x) => norm(x.name) === n)
    || list.find((x) => norm(x.name).includes(n) || n.includes(norm(x.name)))
    || null;
}

// Build the OTP-flow parcel from the payload (survey "489/1B" → survey 489, sub 1B).
function toParcel(payload, codes) {
  const rawSurvey = String(payload.surveyNumber || payload.surveyNo || '').trim();
  const survey = rawSurvey.split('/')[0].trim();
  const subdiv = String(payload.subDivisionNumber || payload.subDivNo || rawSurvey.split('/')[1] || '1').trim();
  return {
    districtCode: codes.districtCode,
    talukCode: codes.talukCode,
    villageCode: codes.villageCode,
    nflag: codes.nflag,
    surveyNo: survey,
    subdivNo: subdiv,
    landType: (payload.landType || 'R').toUpperCase() === 'N' ? 'N' : 'R',
    // carried for the PDF front page + response echo
    districtName: payload.districtName,
    talukName: payload.talukName,
    villageName: payload.villageName,
    typeOfDocument: payload.typeOfDocument || 'Patta',
    memberId: payload.memberId,
  };
}

// ── Circuit breakers around the government-facing work ───────────────────────
// A portal outage trips these fast (GOVT_DOWN 503) instead of stacking 30s
// Playwright timeouts + piling browsers toward OOM. Business errors (wrong OTP,
// no record, rate-limit, session expired, bad input) pass through untouched.
// Breaker timeouts are GENEROUS on purpose. opossum cannot cancel the underlying
// govt work, so a too-tight timeout would abort a slow-but-succeeding call while
// the govt still consumes the OTP — a silent wasted OTP. These only fire when a
// call is genuinely stuck beyond every internal Playwright step timeout; the
// open-circuit fast-fail (the breaker's real value) is unaffected by the timeout.
const govtStart = makeBreaker('govt-start', async (mobile, payload) => {
  const codes = await metrics.timeStage('resolve', () => resolveGovCodes(payload));
  const parcel = toParcel(payload, codes);
  const out = await metrics.timeStage('send', () => patBot.beginVerification(mobile, parcel));
  return { out, parcel };
}, { timeout: 120000 });
const govtVerify = makeBreaker('govt-verify', async (pendingId, otp) => (
  patBot.completeVerification(pendingId, otp)
), { timeout: 180000 });

// Idempotent /verify: a retried POST of the same (referenceId, otp) joins/returns
// the same outcome instead of hitting "expired" and wasting the OTP. TTL >> breaker
// budget so a retry after a slow verify still joins the settled result; only TERMINAL
// outcomes are cached — a transient GOVT_DOWN/timeout is dropped so a retry re-attempts.
const TERMINAL_CODES = new Set(['WRONG_OTP', 'CHITTA_UNAVAILABLE', 'RATE_LIMITED', 'INVALID_INPUT', 'SESSION_EXPIRED', 'VERIFY_EXPIRED']);
const idempotency = new IdempotencyCache({
  ttlMs: 300000, max: 32,
  keepRejection: (err) => TERMINAL_CODES.has(classify(err).code),
});

// Shed flag (set by the memory watchdog) + shutting-down flag (set on drain).
let shedding = false;
let shuttingDown = false;
let doDrain = () => process.exit(0);

// Centralized error → HTTP response. Classifies to a stable code/status, records
// metrics (incl. the otp_wasted money event), and logs with the referenceId.
function sendError(req, res, err, endpoint, meta = {}) {
  const e = classify(err);
  metrics.errorsTotal.inc({ code: e.code, endpoint });
  // Money event: the govt accepted the OTP but no document was delivered. Any error
  // carrying `wasted` (an accepted-then-lost verify), plus CHITTA_UNAVAILABLE and the
  // no-fallback merge failure (meta.wasted), all count.
  if (endpoint === 'verify' && (e.wasted || err.wasted || e.code === 'CHITTA_UNAVAILABLE' || meta.wasted)) {
    metrics.otpWasted.inc({ reason: e.code });
  }
  (req.log || logger).warn({ code: e.code, endpoint, refId: meta.referenceId }, e.message);
  return res.status(e.httpStatus).json({
    status: false, code: e.code, message: e.message, retryable: e.retryable,
    ...(meta.t0 ? { ms: Date.now() - meta.t0 } : {}),
  });
}

async function main() {
  console.log('[bot] Initializing MPQR Patta OTP REST API...');
  await patBot.init({
    otpService: { playwrightTimeoutMs: Number(process.env.PLAYWRIGHT_TIMEOUT_MS || 30000) },
  });

  // Live-state gauges for /metrics.
  metrics.bindGauges(() => {
    const s = patBot.stats();
    return { browsers: browserStats(), warmPool: s.warmPool || { depth: 0 }, pending: s.pending || 0 };
  });

  const app = express();
  app.set('etag', false);
  app.use(pinoHttp({
    logger,
    autoLogging: { ignore: (req) => req.url === '/health' || req.url === '/metrics' },
    customLogLevel: (req, res, err) => (res.statusCode >= 500 || err ? 'error' : (res.statusCode >= 400 ? 'warn' : 'info')),
  }));
  app.use((req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-API-Key');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    if (req.method === 'OPTIONS') return res.sendStatus(204);
    next();
  });
  app.use(express.json({ limit: '2mb' }));

  // Test dashboard — served OPEN (before the API-key gate). It's a static page;
  // the API calls it makes still carry X-API-Key (entered by the tester).
  app.get('/', (req, res) => res.redirect('/dashboard'));
  app.get('/dashboard', (req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'dashboard.html')));
  app.use(express.static(path.join(__dirname, '..', 'public')));

  // ── Health — always 200 (liveness). `degraded` is a FIELD, not a status, so a
  // transient dip doesn't pull the single machine from rotation. ─────────────
  app.get('/health', (req, res) => {
    const s = patBot.stats();
    const now = Date.now();
    const degraded = (s.warmPool && s.warmPool.depth === 0)
      || (s.lastGovtSuccessAt && now - s.lastGovtSuccessAt > 10 * 60 * 1000);
    res.json({
      ok: true, service: 'mpqr-patta-otp', machine: MACHINE_ID,
      degraded: !!degraded, shedding, shuttingDown,
      browsers: browserStats(), warmPool: s.warmPool, pending: s.pending,
      inflightVerifies: s.inflightVerifies, lastGovtSuccessAt: s.lastGovtSuccessAt,
    });
  });

  // REGISTER module (TNREGINET EC) — mounted BEFORE the API-key gate: it is a
  // separate subsystem with no per-user identity, so /api/register/* needs no key.
  register.mount(app);

  // API-key gate. /health + the dashboard are open; everything else (incl. /metrics)
  // needs X-API-Key.
  app.use((req, res, next) => {
    if (req.path === '/health') return next();
    const key = req.headers['x-api-key'] || req.query.api_key;
    if (key !== API_KEY) return res.status(401).json({ status: false, message: 'unauthorized' });
    next();
  });
  app.use((req, res, next) => {
    if (req.method === 'GET' && (req.path.startsWith('/api/') || req.path === '/metrics')) res.set('Cache-Control', 'no-store');
    next();
  });

  // ── Prometheus metrics (behind the API key) ───────────────────────────────
  app.get('/metrics', async (req, res) => {
    try { res.set('Content-Type', metrics.register.contentType); res.end(await metrics.register.metrics()); }
    catch (e) { res.status(500).end(String(e && e.message)); }
  });

  // ── 1) START: send the OTP to the customer's mobile ──────────────────────
  app.post('/api/patta/start', async (req, res) => {
    const t0 = Date.now();
    const p = req.body || {};
    // Shed new work while draining or under memory pressure — BEFORE any browser
    // work, so an about-to-die machine can't burn an OTP moments before exit.
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
      (req.log || logger).info({ refId: referenceId, parcel: `${parcel.districtName}/${parcel.talukName}/${parcel.villageName} ${parcel.surveyNo}/${parcel.subdivNo}`, ms: Date.now() - t0 }, 'OTP sent');
      return res.json({
        status: true, message: 'OTP sent',
        referenceId, ttlSeconds: out.ttlSeconds, memberId: p.memberId || '',
      });
    } catch (e) {
      return sendError(req, res, e, 'start', { t0 });
    }
  });

  // ── 2) VERIFY: submit the OTP, return the chitta as base64 PDF ────────────
  app.post('/api/patta/verify', async (req, res) => {
    const t0 = Date.now();
    const b = req.body || {};
    const referenceId = b.referenceId || b.pendingId || b.session_id;
    try {
      const otp = String(b.otp || '').trim();
      if (!referenceId || !/^\d{4,8}$/.test(otp)) {
        return res.status(400).json({ status: false, code: 'INVALID_INPUT', message: 'referenceId and a 4-8 digit otp are required' });
      }
      const { machineId, pendingId } = parseRefId(referenceId);
      // The pending session lives on a SIBLING machine (2-machine deploy) — ask
      // Fly to replay this request there. Dormant on a single machine.
      if (machineId && machineId !== MACHINE_ID && machineId !== 'local') {
        res.set('fly-replay', `instance=${machineId}`);
        return res.status(202).json({ status: false, code: 'REPLAY', message: 'routing to the session owner' });
      }

      const verify = await idempotency.run(pendingId, otp, () => (
        metrics.timeStage('verify', () => govtVerify.fire(pendingId, otp))
      ));
      const parcel = verify.opts || {};
      const fmb = verify.html ? extractFmb(verify.html) : null;

      let pdfBuffer;
      try {
        pdfBuffer = await metrics.timeStage('pdf', () => generateMergedPdf({
          chittaHtml: verify.html,
          chittaPdf: verify.pdf,          // the government's OWN rendered PDF (preferred)
          fmbSketchUrl: (fmb && fmb.fmbUrl) || null,
          district: parcel.districtName || parcel.districtCode,
          taluk: parcel.talukName || parcel.talukCode,
          village: parcel.villageName || parcel.villageCode,
          surveyNo: parcel.surveyNo,
          subdivNo: parcel.subdivNo,
        }));
      } catch (mergeErr) {
        // The OTP was ALREADY accepted — never lose it to a cosmetic merge/FMB
        // failure. If we still hold the govt's own PDF, serve THAT (degraded:
        // no branded front page / FMB sketch) rather than a 502.
        if (verify.pdf) {
          (req.log || logger).warn({ refId: referenceId }, `merge failed, serving govt PDF directly: ${mergeErr.message}`);
          metrics.verifySuccess.inc();
          return res.json({
            status: true, degraded: true, message: 'File generated (degraded: government PDF only)',
            data: Buffer.from(verify.pdf).toString('base64'), referenceId, memberId: parcel.memberId || '', ms: Date.now() - t0,
          });
        }
        // No usable PDF at all AND the OTP was consumed → a true money event.
        return sendError(req, res, mergeErr, 'verify', { t0, referenceId, wasted: true });
      }

      (req.log || logger).info({ refId: referenceId, bytes: pdfBuffer.length, ms: Date.now() - t0 }, 'PDF delivered');
      return res.json({
        status: true, message: 'File generated successfully',
        data: pdfBuffer.toString('base64'), referenceId, memberId: parcel.memberId || '', ms: Date.now() - t0,
      });
    } catch (e) {
      return sendError(req, res, e, 'verify', { t0, referenceId });
    }
  });

  // ── 3) RESEND OTP on an existing reference ───────────────────────────────
  app.post('/api/patta/resend', async (req, res) => {
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

  // ── Government dropdowns (so callers can resolve/verify codes if they want) ─
  const live = (fn) => async (req, res) => {
    try { res.json({ status: true, ...(await fn(req)) }); }
    catch (e) { return sendError(req, res, e, 'live', {}); }
  };
  app.get('/api/live/districts', live(async () => ({ districts: await tnsLive.getDistricts() })));
  app.get('/api/live/taluks', live(async (req) => ({ taluks: await tnsLive.getTaluks(req.query.district) })));
  app.get('/api/live/villages', live(async (req) => ({ villages: await tnsLive.getVillages(req.query.district, req.query.taluk) })));
  app.get('/api/live/subdivs', live(async (req) => ({
    subdivs: await tnsLive.getSubdivs(req.query.district, req.query.taluk, req.query.village, req.query.survey, req.query.nflag, req.query.landtype),
  })));

  app.get('/api/patta/status', (req, res) => res.json({ status: true, ...patBot.getStatus(), browsers: browserStats() }));

  const server = app.listen(PORT, () => {
    console.log(`[bot] MPQR Patta OTP REST API on http://localhost:${PORT}  (machine ${MACHINE_ID})`);
    console.log('       POST /api/patta/start   { mobileNo, districtName, talukName, villageName, surveyNumber, subDivisionNumber, landType }');
    console.log('       POST /api/patta/verify  { referenceId, otp }  → { data: <base64 PDF> }');
    console.log('       POST /api/patta/resend  { referenceId }');
    console.log('       GET  /api/live/{districts,taluks,villages,subdivs} · GET /metrics · GET /health');
  });
  server.on('error', (e) => { console.error('[bot] listen failed:', e.message); process.exit(1); });

  // ── Graceful, drain-correct shutdown ──────────────────────────────────────
  // Shed NEW /start (503) but keep /verify + /resend live so in-flight customers
  // finish; exit as soon as nothing is busy, or hard-exit just under kill_timeout.
  const drainAndExit = (sig) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.warn({ sig }, 'draining — shedding new starts, finishing in-flight verifies');
    const hard = setTimeout(() => { logger.warn('hard exit at drain deadline'); process.exit(0); }, 28000);
    hard.unref();
    const tryExit = () => {
      if (patBot.busyCount() > 0) return;
      clearInterval(poll); clearTimeout(hard);
      try { server.close(() => {}); } catch (_) {}
      Promise.allSettled([patBot.shutdown(), register.shutdown()]).finally(() => process.exit(0));
    };
    const poll = setInterval(tryExit, 500); poll.unref();
    tryExit();
  };
  doDrain = drainAndExit;
  process.on('SIGTERM', () => drainAndExit('SIGTERM'));
  process.on('SIGINT', () => drainAndExit('SIGINT'));

  // Memory watchdog: shed at the RSS ceiling, and once idle, restart cleanly
  // BEFORE the kernel OOM-kills (which would SIGKILL every in-flight verify).
  startMemWatchdog({
    getInflight: () => patBot.busyCount(),
    getWarming: () => patBot.warmingCount(),
    onShed: (on) => { shedding = on; },
    onDrain: () => drainAndExit('RSS'),
    logger,
  });
}

// Process-level crash guards: one stray rejection must not silently kill the only
// machine; an uncaught exception drains cleanly (process state is undefined after).
process.on('unhandledRejection', (reason) => { logger.error({ err: reason }, 'unhandledRejection'); });
process.on('uncaughtException', (err) => { logger.error({ err }, 'uncaughtException'); doDrain('uncaughtException'); });

main().catch((e) => { console.error('[bot] Fatal:', e.message); process.exit(1); });
