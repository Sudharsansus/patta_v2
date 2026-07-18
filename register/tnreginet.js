'use strict';

/**
 * TNREGINET EC browser client (tnreginet.gov.in).
 *
 * NOTE: TNREGINET is captcha-gated and multi-step; the exact DOM selectors and the
 * combo/search/preview request shapes must be TUNED AGAINST THE LIVE SITE from an
 * Indian IP (same as the patta reverse-engineering). Every step below is
 * structured and best-effort from GOVERNMENT_ENDPOINTS.md §2; points that need
 * live confirmation are marked `LIVE-TUNE`. In test mode a FakeSession is used so
 * the pool + routes + storage work end-to-end without the real portal.
 */
const { launchBrowser } = require('../lib/browser-launcher');
const config = require('./config');

class TnreginetSession {
  constructor(opts = {}) {
    this.headless = opts.headless != null ? opts.headless : config.headless;
    this.timeoutMs = opts.timeoutMs || config.timeoutMs;
    this.browser = null;
    this.context = null;
    this.page = null;
    this.csrfToken = null;
    this.authToken = null;
    this._closed = false;
  }

  async start() {
    this.browser = await launchBrowser({ headless: this.headless });
    this.context = await this.browser.newContext({ ignoreHTTPSErrors: true });
    this.page = await this.context.newPage();
    await this.page.goto(config.tnreginet.ecSearchUrl, { waitUntil: 'domcontentloaded', timeout: this.timeoutMs });
    await this._extractTokens();
    return this;
  }

  async _extractTokens() {
    // LIVE-TUNE: TNREGINET renders _csrf + authToken as hidden inputs on the form.
    try {
      const t = await this.page.evaluate(() => {
        const val = (n) => { const e = document.querySelector(`input[name="${n}"]`); return e ? e.value : null; };
        return { csrf: val('_csrf') || val('CSRFToken'), auth: val('authToken') };
      });
      this.csrfToken = t.csrf;
      this.authToken = t.auth;
    } catch (_) {}
  }

  /**
   * Capture the captcha image as a base64 PNG (screenshot the captcha <img>).
   * LIVE-TUNE: confirm the captcha element selector + whether it needs a reload click.
   */
  async fetchCaptcha() {
    const sel = 'img#captcha_image, img[id*="captcha" i], img[src*="captcha" i]';
    await this.page.waitForSelector(sel, { timeout: this.timeoutMs });
    const el = await this.page.$(sel);
    const png = await el.screenshot({ type: 'png' });
    await this._extractTokens(); // captcha refresh may rotate the csrf
    const src = await el.getAttribute('src').catch(() => null);
    return {
      captchaImage: 'data:image/png;base64,' + Buffer.from(png).toString('base64'),
      captchaUrl: src ? new URL(src, config.tnreginet.base).href : null,
      csrfToken: this.csrfToken,
    };
  }

  /** Fetch a fresh captcha (reload the captcha element), returns the same shape. */
  async refreshCaptcha() {
    // LIVE-TUNE: TNREGINET usually has a "refresh captcha" control; else re-nav.
    try {
      const r = this.page.locator('[onclick*="captcha" i], a[title*="refresh" i], img#captcha_image');
      if (await r.count()) await r.first().click({ timeout: 3000 }).catch(() => {});
    } catch (_) {}
    return this.fetchCaptcha();
  }

  /**
   * Fill the EC search form + captcha and submit. Returns the parsed EC records.
   * Throws { code:'CAPTCHA_WRONG' } / { code:'CAPTCHA_EXPIRED' } / { code:'NO_RECORDS' }.
   * LIVE-TUNE: the field ids, the checkCaptcha/searchDocYearWise flow, results table.
   */
  async searchEc(parcel, captcha) {
    const p = this.page;
    const setSelect = async (name, value) => {
      const el = p.locator(`select[name="${name}"], #${name}`);
      if (await el.count() && value != null && value !== '') await el.first().selectOption(String(value)).catch(() => {});
    };
    const setInput = async (name, value) => {
      const el = p.locator(`input[name="${name}"], #${name}`);
      if (await el.count() && value != null) await el.first().fill(String(value)).catch(() => {});
    };

    // LIVE-TUNE: names below are best-effort from the endpoint doc.
    await setSelect('zone', parcel.zoneId);
    await setSelect('districtCode', parcel.districtId);
    await setSelect('sroCode', parcel.sroId);
    await setSelect(parcel.isRevenueVillage ? 'revVillage' : 'villageCode', parcel.villageCode);
    await setInput('surveyNo', parcel.surveyNo);
    await setInput('flatNo', parcel.flatNo || '');
    await setInput('plotNo', parcel.plotNo || '');
    await setInput('ecStartDate', parcel.ecPeriodStartDt);
    await setInput('ecEndDate', parcel.ecPeriodEndDt);
    await setInput('captcha', captcha);

    const submit = p.locator('input[type="submit"], button[type="submit"], #searchButton, [onclick*="search" i]');
    await submit.first().click({ timeout: this.timeoutMs }).catch(() => {});

    // Detect a captcha error dialog / message.
    const body = (await p.evaluate(() => document.body ? document.body.innerText : '').catch(() => '')) || '';
    if (/invalid\s*captcha|wrong\s*captcha|captcha.*not.*match/i.test(body)) { const e = new Error('Wrong captcha'); e.code = 'CAPTCHA_WRONG'; throw e; }
    if (/captcha.*expired|session.*expired/i.test(body)) { const e = new Error('Captcha expired'); e.code = 'CAPTCHA_EXPIRED'; throw e; }

    const records = await this._parseEcRecords();
    if (!records.length) { const e = new Error('No EC records'); e.code = 'NO_RECORDS'; throw e; }
    return records;
  }

  /** LIVE-TUNE: parse the EC results table into structured records. */
  async _parseEcRecords() {
    try {
      return await this.page.evaluate(() => {
        const rows = Array.from(document.querySelectorAll('table tr')).slice(1);
        return rows.map((r) => {
          const c = Array.from(r.querySelectorAll('td')).map((td) => (td.innerText || '').trim());
          if (c.length < 3) return null;
          return { appTransId: c[0] || '', docNumber: c[1] || '', docType: c[2] || '', execDate: c[3] || '', parties: c[4] || '', marketValue: c[5] || '' };
        }).filter(Boolean);
      });
    } catch (_) { return []; }
  }

  /** Capture the EC as a PDF (the govt's own rendered result). LIVE-TUNE: preview flow. */
  async captureEcPdf() {
    await this.page.addStyleTag({ content: '@page{size:A4;margin:8mm}' }).catch(() => {});
    const pdf = await this.page.pdf({ format: 'A4', printBackground: true });
    return Buffer.from(pdf);
  }

  isAlive() {
    try { return !!(this.browser && this.browser.isConnected && this.browser.isConnected() && this.page && !this.page.isClosed() && !this._closed); }
    catch (_) { return false; }
  }

  async close() {
    if (this._closed) return;
    this._closed = true;
    try { if (this.context) await this.context.close(); } catch (_) {}
    try { if (this.browser) await this.browser.close(); } catch (_) {}
    this.page = this.context = this.browser = null;
  }
}

/**
 * FakeSession — used in MPQR_TEST_MODE (and simulate-pool) so the pool + routes +
 * storage can be exercised without the live TNREGINET portal.
 */
class FakeSession {
  constructor() { this._closed = false; this.csrfToken = 'test-csrf'; }
  async start() { return this; }
  async fetchCaptcha() { return { captchaImage: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', captchaUrl: null, csrfToken: 'test-csrf' }; }
  async refreshCaptcha() { return this.fetchCaptcha(); }
  async searchEc(parcel, captcha) {
    if (String(captcha).toUpperCase() === 'WRONG') { const e = new Error('Wrong captcha'); e.code = 'CAPTCHA_WRONG'; throw e; }
    return [{ appTransId: 'TX-TEST-1', docNumber: `${parcel.surveyNo}/2020`, docType: 'Sale Deed', execDate: '15-Mar-2020', parties: 'Ramu → Shyam', marketValue: '₹12,50,000' }];
  }
  async captureEcPdf() { return Buffer.from('%PDF-1.4\n% fake EC pdf (test mode)\n'); }
  isAlive() { return !this._closed; }
  async close() { this._closed = true; }
}

async function createSession() {
  if (config.testMode) return new FakeSession();
  const s = new TnreginetSession();
  await s.start();
  return s;
}

module.exports = { TnreginetSession, FakeSession, createSession };
