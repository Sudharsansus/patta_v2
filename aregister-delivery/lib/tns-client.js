/**
 * TNClient — stateful TNSERVICES HTTP client (OTP-aware)
 * ──────────────────────────────────────────────────────
 * One client == one browser-like session (own cookie jar + rotating token).
 *
 * Verified endpoints/bodies (from live probes — see README):
 *   warmup   GET  /home.html                          → rno access token in links
 *            GET  /land/chittaNewRuralTamil.html?lan=ta&rno=<rno>
 *                                                      → form; extract ajax_rno + chkrno
 *   sendOtp  POST /land/ajax.html?page=otpgeneratenew
 *              body: {mobileno, actionid:"AC01", lan, TOKEN}   → {new_tk,...}  (rotates token; sends SMS)
 *   verifyOtp POST /land/ajax.html?page=verify_otp_new
 *              body: {mobileno, otpno, TOKEN}                  → {statusCode, new_tk, kno}
 *              wrong OTP → statusCode "otp_false"; valid OTP → upgraded new_tk
 *   fetch    POST /land/chittaExtract_ta.html?lan=ta
 *              form-encoded, ajax_rno = verified new_tk        → chitta HTML
 *
 * No captcha exists (the page's captcha field is dead/commented code).
 */

'use strict';

const axios = require('axios');
const { wrapper } = require('axios-cookiejar-support');
const { CookieJar } = require('tough-cookie');
const qs = require('querystring');
const _ar = require('axios-retry');
const axiosRetry = _ar.default || _ar;
const isNetworkOrIdempotent = _ar.isNetworkOrIdempotentRequestError || axiosRetry.isNetworkOrIdempotentRequestError;
const exponentialDelay = _ar.exponentialDelay || axiosRetry.exponentialDelay;
const { agent } = require('./http-agent');

const BASE = 'https://eservices.tn.gov.in/eservicesnew';
const FORM_PATH = '/land/chittaNewRuralTamil.html';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
const VALID_MOBILE = /^[6-9]\d{9}$/;

class TNClient {
  constructor(opts = {}) {
    this.timeout = opts.timeout || 20000;
    this.lang = opts.lang || 'ta';
    this.userAgent = opts.userAgent || UA;
    this.jar = opts.jar || new CookieJar();
    this.rno = null;        // home access token (for Referer)
    this.token = null;      // rotating ajax_rno / new_tk
    this.chkrno = null;
    this.newTk = null;      // set once OTP verified
    this._pendingMobile = null;    // mobile an OTP was sent to
    this._verifiedMobile = null;   // mobile that passed OTP verification
    this._verifiedOtp = null;      // OTP code that was verified
    this._axios = wrapper(axios.create({
      baseURL: BASE, timeout: this.timeout, jar: this.jar, withCredentials: true,
      validateStatus: () => true,
      httpsAgent: agent,
      headers: { 'User-Agent': this.userAgent, 'Accept-Language': 'ta,en-US;q=0.9,en;q=0.8' },
    }));
    // Retry ONLY safe GETs. isNetworkError is method-AGNOSTIC, so relying on
    // isNetworkOrIdempotent alone would retry a POST that reset AFTER the govt
    // received it — double-firing an OTP send/verify and burning a second OTP.
    // Restrict explicitly to GET. (validateStatus:()=>true means 5xx resolve, not
    // reject, so those are handled per-method, never retried here.)
    axiosRetry(this._axios, {
      retries: 2,
      retryDelay: exponentialDelay,
      retryCondition: (error) => String((error.config && error.config.method) || '').toLowerCase() === 'get'
        && isNetworkOrIdempotent(error),
    });
  }

  _formRef() { return BASE + FORM_PATH + '?lan=' + this.lang + '&rno=' + this.rno; }
  _ajaxHeaders(json) {
    return {
      'Content-Type': json ? 'application/json; charset=utf-8' : 'application/x-www-form-urlencoded',
      Referer: this._formRef(),
      Origin: 'https://eservices.tn.gov.in',
      'X-Requested-With': 'XMLHttpRequest',
    };
  }
  _field(html, name) {
    // Bug 9 fix: try both name-then-value AND value-then-name orders.
    const re1 = new RegExp('name\\s*=\\s*["\']' + name + '["\'][^>]*value\\s*=\\s*["\']([^"\']*)', 'i');
    const re2 = new RegExp('value\\s*=\\s*["\']([^"\']*)["\'][^>]*name\\s*=\\s*["\']' + name + '["\']', 'i');
    const m1 = html.match(re1), m2 = html.match(re2);
    return (m1 && m1[1]) || (m2 && m2[1]) || null;
  }

  hasSession() { return !!this.token; }
  getCookieHeader() {
    try { return this.jar.getCookiesSync(BASE).map(c => c.key + '=' + c.value).join('; '); }
    catch (e) { return ''; }
  }

  /** Warm the session: home → rno, form → ajax_rno + chkrno. */
  async warmup() {
    const home = await this._axios.get('/home.html', { responseType: 'text' });
    if (home.status !== 200) throw new Error('home.html status ' + home.status);
    const m = String(home.data).match(/chittaNewRuralTamil\.html\?lan=ta&rno=([A-Za-z0-9]+)/);
    if (!m) throw new Error('could not extract rno access token from home.html');
    this.rno = m[1];
    const form = await this._axios.get(FORM_PATH + '?lan=' + this.lang + '&rno=' + this.rno, {
      responseType: 'text', headers: { Referer: BASE + '/home.html' },
    });
    const body = String(form.data);
    if (form.status !== 200 || /INVALID ACCESS/i.test(body)) throw new Error('form page: INVALID ACCESS');
    this.token = this._field(body, 'ajax_rno');
    this.chkrno = this._field(body, 'chkrno');
    if (!this.token) throw new Error('form page: no ajax_rno token');
    return { status: form.status, body, token: this.token, chkrno: this.chkrno };
  }

  async getFormTokens() {
    const result = await this.warmup();
    return { ajax_rno: result.token, chkrno: result.chkrno };
  }

  setRotatedToken(token, chkrno) {
    this.token = token;
    this.rno = token;
    if (chkrno) this.chkrno = chkrno;
    return this;
  }

  /** Pull new_tk from a JSON response / body / cookie / redirect URL. */
  _extractNewTk(json, resp) {
    if (json) {
      for (const k of ['new_tk', 'newTk', 'newToken', 'newtk', 'new_token']) {
        if (json[k]) return json[k];
      }
    }
    const body = resp && resp.data != null ? String(resp.data) : '';
    const m = body.match(/["']?(?:new_tk|newTk|newToken)["']?\s*[:=]\s*["']([^"']+)["']/i);
    if (m) return m[1];
    try {
      const c = this.jar.getCookiesSync(BASE).find(x => /new_?tk|newtoken/i.test(x.key));
      if (c) return c.value;
    } catch (e) {}
    const url = resp && resp.request && resp.request.res && resp.request.res.responseUrl;
    if (url) { const um = String(url).match(/rno=([^&]+)/); if (um) return decodeURIComponent(um[1]); }
    return null;
  }

  _isVerified(json) {
    if (!json || json.statusCode == null) return false;
    const s = String(json.statusCode).toLowerCase();
    if (['otp_false', 'mobno_fal', 'limit_exe', 'false', 'time_out'].includes(s)) return false;
    return s === 'true' || s === 'otp_true' || s === 'success' || !!json.kno;
  }

  /** Send an OTP (fires a real SMS). Rotates the token. */
  async sendOtp(mobile, opts = {}) {
    mobile = String(mobile || '');
    if (!VALID_MOBILE.test(mobile) || /^(\d)\1{9}$/.test(mobile)) throw new Error('invalid mobile number');
    if (!this.token) await this.warmup();
    const actionid = opts.actionid || 'AC01';
    // otpgeneratenew expects a JSON body (confirmed by capturing the real
    // browser request: Content-Type application/json, {mobileno,actionid,lan,
    // TOKEN} → 200 {new_tk}). A form-urlencoded body returns 500 "INVALID
    // ACCESS". (The prior "Bug 1 fix" to form-urlencoded was backwards.)
    const jsonBody = JSON.stringify({
      mobileno: mobile, actionid, lan: this.lang, TOKEN: this.token,
    });
    const r = await this._axios.post('/land/ajax.html?page=otpgeneratenew', jsonBody, {
      responseType: 'text',
      headers: this._ajaxHeaders(true),  // JSON
    });
    let json = {}; try { json = JSON.parse(r.data); } catch (e) {}
    const tk = this._extractNewTk(json, r);
    if (tk) this.token = tk;   // token rotates on send
    this._pendingMobile = mobile;
    return {
      status: r.status,
      body: String(r.data),
      sentTime: json.sent_time || json.sentTime || Date.now(),
      statusCode: json.statusCode,
      token: this.token,
      mobile: this._pendingMobile,
    };
  }

  /** Verify an OTP. On success, upgrades the token to new_tk (chitta-unlocking). */
  async verifyOtp(mobile, otp, sentTime, opts = {}) {
    if (!this.token) throw new Error('no session token — warm up / send OTP first');
    // verify_otp_new also expects JSON (same as otpgeneratenew) — this is the
    // ORIGINAL shape; the form-urlencoded detour was wrong.
    const r = await this._axios.post('/land/ajax.html?page=verify_otp_new',
      JSON.stringify({ mobileno: String(mobile || ''), otpno: String(otp || ''), TOKEN: this.token }),
      { responseType: 'text', headers: this._ajaxHeaders(true) });
    let json = {}; try { json = JSON.parse(r.data); } catch (e) {}
    const tk = this._extractNewTk(json, r);
    if (tk) this.token = tk;   // rotates on verify too
    const verified = this._isVerified(json);
    if (verified) {
      this.newTk = this.token;
      // Remember what was verified — the chitta fetch must echo these back with
      // mobileno_ver / otpno_ver so TNSERVICES treats the request as verified.
      this._verifiedMobile = String(mobile || json.mobile || '');
      this._verifiedOtp = String(otp || json.otpno || '');
    }
    return {
      status: r.status,
      body: String(r.data),
      verified,
      statusCode: json.statusCode,
      new_tk: this.newTk,
      verifiedMobile: this._verifiedMobile,
      verifiedOtp: this._verifiedOtp,
      raw: json,
    };
  }

  /** Fetch the chitta document using the verified new_tk + verification flags. */
  async fetchChitta(survey, opts = {}) {
    const mobile = (opts && opts.mobile) || this._verifiedMobile || survey.mobile || '';
    const otp = (opts && opts.otp) || this._verifiedOtp || '';
    if (!mobile || !otp) throw new Error('no verified mobile/otp — verify OTP first');

    // chkrno + ajax_rno for the fetch are SINGLE-USE tokens that rotate per
    // submission and come from a fresh GET of the chitta form — NOT the OTP
    // verify token (that only proves verification, echoed via *_ver). Re-GET
    // the form in the same cookie jar to grab fresh ones, else the server
    // returns the blank input form.
    const formUrl = '/land/chittaExtract_en.html?lan=en';
    const formPage = await this._axios.get(formUrl, {
      responseType: 'text',
      headers: { Referer: BASE + '/home.html', 'X-Requested-With': 'XMLHttpRequest' },
    });
    const fbody = String(formPage.data);
    const chkrno = this._field(fbody, 'chkrno') || this.chkrno;
    const ajaxRno = this._field(fbody, 'ajax_rno') || this.newTk || this.token;
    const ctx = (name) => { const i = fbody.indexOf(name); return i >= 0 ? fbody.slice(Math.max(0, i - 15), i + 90).replace(/\s+/g, ' ') : '(not present)'; };
    console.log('[fetch] form GET status', formPage.status, '| size', fbody.length,
      '| invalidAccess', /INVALID\s+ACCESS/i.test(fbody),
      '| chkrno-ctx:', ctx('chkrno'), '|| ajax_rno-ctx:', ctx('ajax_rno'));

    const nflag = survey.nflag || 'Y';
    const talukCode = /\//.test(survey.talukCode || '') ? survey.talukCode : (survey.talukCode + '/' + nflag);
    const body = qs.stringify({
      task: 'chittaEng',
      searchpattano: 'no',
      chkrno,
      ajax_rno: ajaxRno,
      districtCode: survey.districtCode,
      talukCode,
      villageCode: survey.villageCode,
      viewOpt: survey.viewOpt || 'sur',   // 'sur' = survey + FMB, 'pt' = patta details
      landtype: survey.landType || survey.landtype || 'R',
      pattaNo: survey.pattaNo || '',
      surveyNo: survey.surveyNo,
      subdivNo: survey.subDivNo || survey.subdivNo || '',
      mobileno: mobile, otpno: otp,
      // *_ver fields carry the verified mobile/OTP VALUES, not 'true'.
      mobileno_ver: mobile, otpno_ver: otp,
    });
    const r = await this._axios.post(formUrl, body, {
      responseType: 'text',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Referer: BASE + formUrl,
        Origin: 'https://eservices.tn.gov.in',
        'X-Requested-With': 'XMLHttpRequest',
      },
    });
    const html = String(r.data);
    return { status: r.status, body: html, size: html.length, chkrno, ajaxRno: (ajaxRno || '').slice(0, 12) };
  }

  /** Sub-division lookup (used by cli/probe.js). */
  async getSubdivnos(districtCode, talukCode, villageCode, surveyNo, landtype = 'R', flag = 'F') {
    if (!this.token) await this.warmup();
    const tc = /\//.test(talukCode) ? talukCode : (talukCode + '/Y');
    const r = await this._axios.post(
      '/land/ajax.html?page=getSubdivNo&districtCode=' + districtCode + '&talukCode=' + tc +
      '&villageCode=' + villageCode + '&surveyno=' + surveyNo + '&landtype=' + landtype + '&flag=' + flag,
      {}, { responseType: 'text', headers: { Referer: this._formRef(), 'X-Requested-With': 'XMLHttpRequest' } });
    return { status: r.status, body: String(r.data) };
  }
}

module.exports = { TNClient };
