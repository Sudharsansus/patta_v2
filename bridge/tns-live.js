/**
 * TNSERVICES Live Data Bridge
 * ───────────────────────────
 * Pulls the REAL location tree and survey sub-divisions straight from the
 * TNSERVICES rural-chitta form — no CSV, no hardcoding.
 *
 * The access pattern (reverse-engineered from the live portal):
 *   1. GET  /home.html                              → JSESSIONID + an `rno` access
 *                                                     token minted into the page's
 *                                                     service links.
 *   2. GET  /land/chittaNewRuralTamil.html?lan=ta&rno=<rno>
 *                                                     → the form page. Without the
 *                                                     rno this returns "INVALID ACCESS".
 *   3. POST /land/ajax.html?page=ruralservice&ser=…  → JSON dropdown data:
 *        ser=dist                                    → [{dcode,dname,dtname}]
 *        ser=tlk&distcode=DC                         → [{tcode,tname,ttname,nflag}]
 *        ser=vill&distcode=DC&talukcode=TC           → [{villagecode,villagename,villagetname}]
 *   4. POST /land/ajax.html?page=getSubdivNo&districtCode=DC&talukCode=TC/<nflag>&…
 *                                                     → <root><subdiv><subdivcode>…  (XML)
 *
 * The final chitta *document* is gated behind a mobile OTP on the portal (verified
 * server-side — a wrong OTP returns statusCode "otp_false"; there is NO captcha), so
 * it cannot be pulled headlessly. This module resolves everything up to and including
 * sub-divisions, which confirms a record is reachable.
 *
 * One warmed session (jar + rno) is cached and reused across calls; it re-warms
 * automatically on expiry or an INVALID ACCESS response.
 */

'use strict';

const axios = require('axios');
const { wrapper } = require('axios-cookiejar-support');
const { CookieJar } = require('tough-cookie');
const { TNClient } = require('../lib/tns-client');

const BASE = 'https://eservices.tn.gov.in/eservicesnew';
const FORM_PATH = '/land/chittaNewRuralTamil.html';
const EXTRACT_PATH = '/land/chittaExtract_ta.html?lan=ta';
const SESSION_TTL_MS = 15 * 60 * 1000;

// BUG 4 FIX: CSV fallback for when TNSERVICES is blocked (US IP) or returns empty.
// Uses mpqr-resolver's getDistrictsTree which loads from data/tn-districts.csv
// (a 38-district / 270-taluk / ~16k-village snapshot of Tamil Nadu).
const { getDistrictsTree } = require('./mpqr-resolver');
function _csvDistricts() {
  try { return getDistrictsTree().map(d => ({ code: d.code, name: d.name })); }
  catch (e) { console.log('[tns-live] CSV fallback for districts failed:', e.message); return []; }
}
function _csvTaluks(districtCode) {
  try {
    const d = getDistrictsTree().find(x => String(x.code) === String(districtCode));
    return d ? d.taluks.map(t => ({ code: t.code, name: t.name, nflag: t.nflag || 'Y' })) : [];
  } catch (e) { return []; }
}
function _csvVillages(districtCode, talukCode) {
  try {
    const d = getDistrictsTree().find(x => String(x.code) === String(districtCode));
    if (!d) return [];
    const t = d.taluks.find(x => String(x.code) === String(talukCode));
    return t ? t.villages.map(v => ({ code: v.code, name: v.name })) : [];
  } catch (e) { return []; }
}

// ── Live dropdown data via a BROWSER session ─────────────────────────────────
// The govt firewall/session rejects EXTERNAL http — axios AND Playwright's
// context.request both get "INVALID ACCESS". The ONLY accepted path is the page's
// OWN fetch, so we keep ONE lazily-created, idle-closed browser parked at the form
// and run each dropdown ajax IN the page (PlaywrightSession.govtAjax). One browser,
// closed after 3 min idle; the CSV remains a last-resort fallback below.
let _dataPs = null;      // the live-data browser session, or null
let _dataAt = 0;         // last-used timestamp
let _dataWarming = null; // in-flight start() promise (dedupe concurrent callers)
const DATA_IDLE_MS = 3 * 60 * 1000;

async function _session() {
  if (_dataPs && _dataPs.page && !_dataPs.page.isClosed()) { _dataAt = Date.now(); return _dataPs; }
  if (_dataWarming) return _dataWarming;
  _dataWarming = (async () => {
    const { PlaywrightSession } = require('../lib/playwright-session');
    const ps = new PlaywrightSession({ headless: true });
    await ps.start(); // walk index → View Patta → form: valid rno + JSESSIONID
    _dataPs = ps; _dataAt = Date.now();
    return ps;
  })();
  try { return await _dataWarming; }
  finally { _dataWarming = null; }
}

// Free the data browser when idle (dropdowns are bursty, then quiet).
const _idleReaper = setInterval(() => {
  if (_dataPs && Date.now() - _dataAt > DATA_IDLE_MS) {
    const p = _dataPs; _dataPs = null; Promise.resolve(p.close()).catch(() => {});
  }
}, 60 * 1000);
if (_idleReaper.unref) _idleReaper.unref();

function _enc(v) { return encodeURIComponent(String(v == null ? '' : v)); }

// Back-compat: callers/monitors may still call warm()/ensure().
async function warm() { return _session(); }
async function ensure() { return _session(); }

// Run a dropdown ajax IN the page; if the session looks dead, re-navigate once.
async function _ajaxRetry(query) {
  let ps = await _session();
  let out = await ps.govtAjax(query).catch((e) => ({ body: '', err: e.message }));
  let body = (out && out.body) || '';
  if (!body || body === 'false' || /INVALID ACCESS/i.test(body)) {
    const p = _dataPs; _dataPs = null; if (p) Promise.resolve(p.close()).catch(() => {});
    ps = await _session();
    out = await ps.govtAjax(query).catch((e) => ({ body: '', err: e.message }));
    body = (out && out.body) || '';
  }
  return body;
}

function _parseArray(body) {
  try {
    const v = JSON.parse(body);
    return Array.isArray(v) ? v : [];
  } catch (e) { return []; }
}

const byName = (a, b) => a.name.localeCompare(b.name);

async function getDistricts() {
  try {
    const body = await _ajaxRetry('page=ruralservice&ser=dist&lang=ta&type=rur&call_type=ser');
    const arr = _parseArray(body)
      .map(d => ({ code: d.dcode, name: (d.dname || '').trim(), tamil: (d.dtname || '').trim() }))
      .filter(d => d.code)
      .sort(byName);
    if (arr.length > 0) return arr;
  } catch (e) { /* fall through to CSV */ }
  // BUG 4 FIX: CSV fallback
  const csv = _csvDistricts();
  if (csv.length) console.log('[tns-live] using CSV fallback for districts (' + csv.length + ')');
  return csv;
}

async function getTaluks(districtCode) {
  if (!districtCode) throw new Error('districtCode required');
  try {
    const body = await _ajaxRetry('page=ruralservice&ser=tlk&distcode=' + _enc(districtCode) + '&lang=ta&type=rur&call_type=ser');
    const arr = _parseArray(body)
      .map(t => ({ code: t.tcode, name: (t.tname || '').trim(), tamil: (t.ttname || '').trim(), nflag: (t.nflag || 'Y').trim() }))
      .filter(t => t.code)
      .sort(byName);
    if (arr.length > 0) return arr;
  } catch (e) { /* fall through to CSV */ }
  // BUG 4 FIX: CSV fallback
  return _csvTaluks(districtCode);
}

async function getVillages(districtCode, talukCode) {
  if (!districtCode || !talukCode) throw new Error('districtCode and talukCode required');
  try {
    const body = await _ajaxRetry('page=ruralservice&ser=vill&distcode=' + _enc(districtCode) + '&talukcode=' + _enc(talukCode) + '&lang=ta&type=rur&call_type=ser');
    const arr = _parseArray(body)
      .map(v => ({ code: v.villagecode, name: (v.villagename || '').trim(), tamil: (v.villagetname || '').trim() }))
      .filter(v => v.code)
      .sort(byName);
    if (arr.length > 0) return arr;
  } catch (e) { /* fall through to CSV */ }
  // BUG 4 FIX: CSV fallback
  return _csvVillages(districtCode, talukCode);
}

// Sub-divisions for a survey number. talukCode needs its "/nflag" suffix here.
async function getSubdivs(districtCode, talukCode, villageCode, surveyNo, nflag, landtype) {
  if (!districtCode || !villageCode || !surveyNo) {
    throw new Error('district, taluk, village and survey number are all required');
  }
  const tcode = talukCode + '/' + (nflag || 'Y');
  const body = await _ajaxRetry(
    'page=getSubdivNo&districtCode=' + _enc(districtCode) +
    '&talukCode=' + _enc(tcode) +
    '&villageCode=' + _enc(villageCode) +
    '&surveyno=' + _enc(surveyNo) +
    '&landtype=' + _enc(landtype === 'N' ? 'N' : 'R') + '&flag=F'
  );
  return [...body.matchAll(/<subdivcode>([^<]+)<\/subdivcode>/gi)].map(m => m[1].trim());
}

/**
 * Full "download readiness" probe for a survey. Resolves the whole chain against
 * the live portal and reports how far an automated download can get. The final
 * document is mobile-OTP gated (no captcha), so `documentAutomatable` is always
 * false — this confirms reachability, not a headless PDF pull.
 */
async function probeDownload({ districtCode, talukCode, villageCode, surveyNo, nflag }) {
  const t0 = Date.now();
  const subdivs = await getSubdivs(districtCode, talukCode, villageCode, surveyNo, nflag);
  const reachable = subdivs.length > 0;
  return {
    reachable,
    subdivCount: subdivs.length,
    subdivs,
    documentAutomatable: false,
    gate: reachable ? 'mobile OTP' : null,
    note: reachable
      ? 'Record found on live TNSERVICES with ' + subdivs.length + ' sub-division(s). The patta/chitta document itself is gated behind a mobile OTP on the portal (server-verified, no captcha) and cannot be pulled unattended.'
      : 'No sub-divisions returned — this survey number does not exist for the selected village (or the land is urban, which uses a different form).',
    ms: Date.now() - t0,
  };
}

/**
 * Attempt the chitta document with a mobile number but WITHOUT a verified OTP —
 * the "only the number is enough" hypothesis. Returns the portal's verdict.
 * (Proven to bounce: the document is OTP-gated. This exposes that live.)
 */
async function tryChittaNoOtp(survey) {
  const t0 = Date.now();
  const c = new TNClient();
  await c.warmup();                       // gets an UNVERIFIED ajax_rno
  const r = await c.fetchChitta(survey);  // submit with the unverified token + number
  const body = r.body || '';
  const bounced = /talukrur\(this\.value/.test(body) || /id="districtCode"/.test(body);
  const gotDocument = !bounced && /(உரிமையாளர்|நில உரிமையாளர்|Sub Division No|நிலப்பரப்பு|பரப்பளவு|எக்டேர்|Patta\s*No\b)/i.test(body);
  return {
    gotDocument,
    bounced,
    size: r.size,
    status: r.status,
    ms: Date.now() - t0,
    note: gotDocument
      ? 'The portal returned a document WITHOUT OTP — number-only works!'
      : 'The portal bounced back to the blank input form. A mobile number alone is NOT enough — a verified OTP is required to release the patta.',
    html: gotDocument ? body : null,
  };
}

function status() {
  return _dataPs && _dataPs.page && !_dataPs.page.isClosed()
    ? { warmed: true, ageMs: Date.now() - _dataAt, idleMs: DATA_IDLE_MS }
    : { warmed: false };
}

module.exports = { warm, ensure, getDistricts, getTaluks, getVillages, getSubdivs, probeDownload, tryChittaNoOtp, status };
