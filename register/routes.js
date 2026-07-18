'use strict';

/**
 * REGISTER module routes — all 16 endpoints under /api/register/*.
 * Isolated subsystem: owns its pool, its TNREGINET client, its store. Does not
 * touch the patta module.
 */
const express = require('express');
const config = require('./config');
const store = require('./store');
const dropdowns = require('./dropdowns');
const { createSession, FakeSession } = require('./tnreginet');
const { RegisterPool } = require('./pool');

const VERSION = '1.0.0';

function makeRefId(p) {
  const ts = Math.floor(Date.now() / 1000);
  const office = p.sroId || p.talukId || 'rev';
  return `EC-${p.districtId}-${office}-${p.villageCode}-${p.surveyNo}-${ts}`;
}

function parcelFrom(b = {}) {
  return {
    zoneId: b.zoneId, districtId: b.districtId, sroId: b.sroId || '', talukId: b.talukId || '',
    villageCode: b.villageCode, surveyNo: b.surveyNo, flatNo: b.flatNo || '', plotNo: b.plotNo || '',
    ecPeriodStartDt: b.ecPeriodStartDt, ecPeriodEndDt: b.ecPeriodEndDt,
    isRevenueVillage: b.isRevenueVillage !== false,
  };
}

function validateParcel(p) {
  // sroId is optional — the revenue-village path uses district → taluk → village.
  if (!p.districtId || !p.villageCode) return 'districtId and villageCode are required';
  if (!/^[0-9A-Za-z/-]{1,12}$/.test(String(p.surveyNo || ''))) return 'Invalid survey number';
  return null;
}

function origin(req) {
  return `${req.headers['x-forwarded-proto'] || req.protocol}://${req.headers.host}`;
}

function build() {
  const router = express.Router();
  const pool = new RegisterPool();
  router._pool = pool; // exposed for shutdown

  const wrap = (fn) => (req, res) => Promise.resolve(fn(req, res)).catch((e) => {
    console.error('[register] route error:', e && e.message);
    if (!res.headersSent) res.status(500).json({ ok: false, error: e && e.message ? e.message : 'internal error' });
  });

  // ── 1) health ──────────────────────────────────────────────────────────────
  router.get('/health', (req, res) => res.json({
    ok: true, module: 'register', version: VERSION, pool: pool.health(), captchaSolver: config.captchaMode,
  }));

  // ── 2-6) dropdowns ─────────────────────────────────────────────────────────
  router.get('/districts', wrap(async (req, res) => res.json({ ok: true, zones: dropdowns.getZones(req.query.zone) })));
  router.get('/sros', wrap(async (req, res) => {
    if (!req.query.districtId) return res.status(400).json({ ok: false, error: 'districtId required' });
    res.json({ ok: true, sros: await dropdowns.getSros(req.query.districtId) });
  }));
  router.get('/villages', wrap(async (req, res) => {
    if (!req.query.sroId) return res.status(400).json({ ok: false, error: 'sroId required' });
    res.json({ ok: true, villages: await dropdowns.getVillages(req.query.sroId) });
  }));
  router.get('/rev-taluks', wrap(async (req, res) => {
    if (!req.query.districtId) return res.status(400).json({ ok: false, error: 'districtId required' });
    res.json({ ok: true, revTaluks: await dropdowns.getRevTaluks(req.query.districtId) });
  }));
  router.get('/rev-villages', wrap(async (req, res) => {
    if (!req.query.talukId) return res.status(400).json({ ok: false, error: 'talukId required' });
    res.json({ ok: true, revVillages: await dropdowns.getRevVillages(req.query.talukId) });
  }));

  // ── 7) begin (Solve Captcha step 1) ────────────────────────────────────────
  router.post('/begin', wrap(async (req, res) => {
    const parcel = parcelFrom(req.body);
    const bad = validateParcel(parcel);
    if (bad) return res.status(400).json({ ok: false, error: bad });
    let sess;
    try { sess = await createSession(); }
    catch (e) { return res.status(503).json({ ok: false, error: 'TNREGINET is unreachable. Try again later.' }); }
    try {
      const cap = await sess.fetchCaptcha();
      const sessionId = pool.addPending(sess, cap.csrfToken, parcel);
      return res.json({
        ok: true, sessionId, captchaImage: cap.captchaImage, captchaUrl: cap.captchaUrl,
        csrfToken: cap.csrfToken, expiresIn: Math.round(config.captchaSessionTtlMs / 1000),
        message: 'Type the 6 characters shown in the image',
      });
    } catch (e) {
      try { await sess.close(); } catch (_) {}
      return res.status(503).json({ ok: false, error: 'TNREGINET is unreachable. Try again later.' });
    }
  }));

  // ── 8) verify (Solve Captcha step 2) ───────────────────────────────────────
  router.post('/verify', wrap(async (req, res) => {
    const t0 = Date.now();
    const { sessionId, captcha } = req.body || {};
    const parcel = parcelFrom(req.body);
    const pending = pool.getPending(sessionId);
    if (!pending) return res.status(400).json({ ok: false, code: 'CAPTCHA_EXPIRED', error: 'Captcha expired. Please start over.', next: 'POST /api/register/begin' });
    if (!/^[0-9A-Za-z]{4,8}$/.test(String(captcha || ''))) return res.status(400).json({ ok: false, code: 'CAPTCHA_WRONG', error: 'Enter the characters shown.' });

    let records;
    try {
      records = await pending.sess.searchEc(parcel, captcha);
    } catch (e) {
      if (e.code === 'CAPTCHA_WRONG') {
        let fresh = {}; try { fresh = await pending.sess.refreshCaptcha(); } catch (_) {}
        return res.status(400).json({ ok: false, code: 'CAPTCHA_WRONG', error: 'Wrong captcha. Please try again.', newCaptchaImage: fresh.captchaImage });
      }
      if (e.code === 'CAPTCHA_EXPIRED') { pool.retire(sessionId, 'expired'); return res.status(400).json({ ok: false, code: 'CAPTCHA_EXPIRED', error: 'Captcha expired. Please start over.', next: 'POST /api/register/begin' }); }
      if (e.code === 'NO_RECORDS') { pool.promoteToPool(sessionId); return res.status(400).json({ ok: false, code: 'NO_RECORDS', error: 'No EC records found for the given survey number in the date range.' }); }
      throw e;
    }

    if (!store.available()) return res.status(503).json({ ok: false, needStorage: true, error: 'Storage not configured. Set S3_BUCKET/S3_ACCESS_KEY/S3_SECRET_KEY or LOCAL_PDF_DIR.' });
    const pdf = await pending.sess.captureEcPdf();
    const refId = makeRefId(parcel);
    const { url } = await store.putPdf(refId, pdf, origin(req));
    // The captcha-solved session joins the pool for others (Quick EC).
    pool.promoteToPool(sessionId);
    return res.json({
      ok: true, ms: Date.now() - t0, source: 'own_captcha', sessionId, refId, pdfUrl: url,
      ecRecords: records, message: 'EC fetched. Your session is in the pool for 30 minutes.',
    });
  }));

  // ── 9) fetch (Quick EC — silent pool borrow) ───────────────────────────────
  router.post('/fetch', wrap(async (req, res) => {
    const t0 = Date.now();
    const parcel = parcelFrom(req.body);
    const bad = validateParcel(parcel);
    if (bad) return res.status(400).json({ ok: false, error: bad });
    if (!store.available()) return res.status(503).json({ ok: false, needStorage: true, error: 'Storage not configured. Set S3_BUCKET/S3_ACCESS_KEY/S3_SECRET_KEY or LOCAL_PDF_DIR.' });

    const entry = pool.borrow();
    if (!entry) return res.status(503).json({ ok: false, needCaptcha: true, code: 'POOL_EMPTY', error: 'No verified sessions in pool. Please solve a captcha to fetch.' });

    try {
      // Borrowed session is already captcha-validated for the 30-min window.
      // LIVE-TUNE: confirm whether TNREGINET needs the captcha re-supplied per search.
      const records = await entry.sess.searchEc(parcel, null);
      const pdf = await entry.sess.captureEcPdf();
      const refId = makeRefId(parcel);
      const { url } = await store.putPdf(refId, pdf, origin(req));
      pool.releaseBorrow(entry, { success: true }); // one borrow → consumed + retired
      return res.json({
        ok: true, ms: Date.now() - t0, source: 'session_pool', borrowedFrom: 'session_' + entry.sessionId,
        refId, pdfUrl: url, ecRecords: records,
      });
    } catch (e) {
      if (e.code === 'NO_RECORDS') { pool.releaseBorrow(entry, { success: true }); return res.status(400).json({ ok: false, code: 'NO_RECORDS', error: 'No EC records found for the given survey number in the date range.' }); }
      // Transient TNREGINET error: keep the session (captcha still valid) — retry.
      pool.releaseBorrow(entry, { success: false });
      return res.status(503).json({ ok: false, code: 'TNREGINET_ERROR', error: 'TNREGINET error while fetching. Please retry.' });
    }
  }));

  // ── 10) captcha/refresh ────────────────────────────────────────────────────
  router.post('/captcha/refresh', wrap(async (req, res) => {
    const pending = pool.getPending((req.body || {}).sessionId);
    if (!pending) return res.status(404).json({ ok: false, error: 'Session expired. Please POST /api/register/begin again.' });
    const cap = await pending.sess.refreshCaptcha();
    return res.json({ ok: true, sessionId: pending.sessionId, captchaImage: cap.captchaImage, csrfToken: cap.csrfToken, expiresIn: Math.round(config.captchaSessionTtlMs / 1000) });
  }));

  // ── 11) sessions (pool status) ─────────────────────────────────────────────
  router.get('/sessions', (req, res) => res.json({ ok: true, sessions: pool.sessions(), stats: pool.stats() }));

  // ── 12) retire a session ───────────────────────────────────────────────────
  router.delete('/sessions/:id', (req, res) => (
    pool.retire(req.params.id, 'manual')
      ? res.json({ ok: true, message: 'Session retired' })
      : res.status(404).json({ ok: false, error: 'Session not found' })
  ));

  // ── 13) refresh/:id (auto-solve — not in v1) ───────────────────────────────
  router.post('/refresh/:id', (req, res) => res.status(501).json({
    ok: false, error: 'Auto-refresh not implemented in v1. Operator must add sessions via /begin + /verify.',
  }));

  // ── 14) preview EC records ─────────────────────────────────────────────────
  router.post('/preview', wrap(async (req, res) => {
    const { sessionId } = req.body || {};
    const entry = pool.getPending(sessionId) || pool.sessions().find((s) => s.sessionId === sessionId);
    if (!entry) return res.status(404).json({ ok: false, error: 'Session not found' });
    const sess = (pool.getPending(sessionId) || {}).sess;
    let records = [];
    try { if (sess && sess._parseEcRecords) records = await sess._parseEcRecords(); } catch (_) {}
    return res.json({ ok: true, records: records.map((r) => ({ ...r, pdfAvailable: true })) });
  }));

  // ── 15) download a cached PDF ──────────────────────────────────────────────
  router.get('/download/:refId', wrap(async (req, res) => {
    const buf = await store.getPdf(req.params.refId);
    if (!buf) return res.status(404).json({ ok: false, error: 'PDF not found in storage' });
    res.set('Content-Type', 'application/pdf');
    res.set('Content-Disposition', `inline; filename="${req.params.refId}.pdf"`);
    res.end(buf);
  }));

  // ── 16) test/simulate-pool (test mode only) ────────────────────────────────
  router.post('/test/simulate-pool', wrap(async (req, res) => {
    if (!config.testMode) return res.status(403).json({ ok: false, error: 'Test mode disabled (set MPQR_TEST_MODE=1)' });
    const entry = pool.addPoolEntry(new FakeSession(), (req.body || {}).sessionId);
    return res.json({ ok: true, sessionId: entry.sessionId, message: 'Fake session added to pool (test mode)' });
  }));

  return router;
}

module.exports = { build };
