'use strict';

const { chromium } = require('playwright');
const retry = require('async-retry');
const { launchBrowser } = require('./browser-launcher');
const { EventEmitter } = require('events');

// Third-party analytics/tracker hosts to abort. These add zero value to the OTP
// flow AND their long-lived sockets are the reason 'networkidle' never settles —
// blocking them both sheds overhead and lets the network-idle wait return fast.
// We deliberately do NOT block images/fonts/CSS/scripts from the government's own
// hosts: the verify RESULT page is captured as the customer's PDF, so stripping
// its images or fonts (Tamil!) would degrade the delivered document.
const BLOCK_HOSTS = /(?:google-analytics|googletagmanager|google\.com\/(?:ads|pagead)|doubleclick|facebook\.net|connect\.facebook|hotjar|clarity\.ms|mixpanel|segment\.(?:io|com)|fullstory|newrelic|nr-data|bugsnag)\b/i;
const GOVT_HOSTS = /eservices\.tn\.gov\.in|tnreginet\.gov\.in|collabland-tn\.gov\.in|\.tn\.gov\.in/i;

// Which government document this session drives. Both use the SAME eservices form
// mechanics (same field ids, same OTP endpoints) — they differ only in the access
// link on the index page + the form page, and the OTP send actionid the form sets
// (AC01 patta/chitta, AC02 A-Register). formKind picks the config.
const FORM_ACCESS = {
  patta: {
    linkText: 'View Patta / Chitta / FMB', href: 'chittaNewRuralTamil', role: /patta.*chitta/i,
    extractUrl: 'https://eservices.tn.gov.in/eservicesnew/land/chittaExtract_en.html?lan=en',
  },
  aregister: {
    linkText: 'View A-Register', href: 'areg_', role: /a-?register|adangal|அ-?பதிவேடு/i,
    // The GET-able extract page (renders the form on the verified cookie, like patta's
    // chittaExtract) — NOT areg_*.html, which needs an rno access token.
    extractUrl: 'https://eservices.tn.gov.in/eservicesnew/land/aRegisterExtract_en.html?lan=en',
  },
};

const TNSERVICES_HOME = 'https://eservices.tn.gov.in/eservicesnew/index.html';
const TNSERVICES_FORM = 'https://eservices.tn.gov.in/eservicesnew/land/chittaNewRuralTamil.html';
const DEFAULT_TIMEOUT_MS = 30000;

function asBoolean(value, fallback = true) {
  if (value == null || value === '') return fallback;
  if (typeof value === 'boolean') return value;
  return !/^(?:0|false|no|off)$/i.test(String(value));
}

/**
 * One live Chromium session for the TNSERVICES Patta/Chitta/FMB flow.
 *
 * The browser stays open between OTP verification and document extraction so
 * cookies, hidden form tokens, and the rendered result page are preserved.
 */
class PlaywrightSession extends EventEmitter {
  constructor(opts = {}) {
    super();
    this.headless = opts.headless == null
      ? asBoolean(process.env.PLAYWRIGHT_HEADLESS, true)
      : opts.headless !== false;
    this.timeoutMs = Number(opts.timeoutMs || process.env.PLAYWRIGHT_TIMEOUT_MS || DEFAULT_TIMEOUT_MS);
    // 'patta' (default) or 'aregister' — picks the access link on the index page.
    // Everything else about the flow is identical (same form fields + OTP endpoints).
    this.formKind = opts.formKind === 'aregister' ? 'aregister' : 'patta';
    this.accessConfig = FORM_ACCESS[this.formKind];
    // Optional rotating outbound-proxy pool so govt traffic isn't all from one IP at
    // scale. OFF by default: with no MPQR_PROXIES set, next() returns null → direct.
    this._proxyPool = opts.proxyPool || require('./proxy-pool').defaultPool();
    this._proxy = null;
    this.browser = null;
    this.context = null;
    this.page = null;
    this.dialogMessage = null;
    this.formData = null;
    this._verifiedSubmission = null;
    this._lastSurveyKey = null;
    this._lastArtifacts = null;
    this._dialogWaiters = new Set();
    this._closed = false;
    // Keep-alive: while a browser sits idle (warm pool, or holding a sent OTP
    // while the customer reads the SMS) the government's server-side session
    // (JSESSIONID) silently times out. A resumed-but-dead session renders an
    // "INVALID ACCESS" page — the single biggest cause of "invalid page" failures.
    this._keepAliveTimer = null;
    this._lastKeepAliveOk = null; // null = not pinged yet; true/false after a ping
    this._lastKeepAliveAt = 0;
    this._pingInFlight = null;    // the in-flight keep-alive promise, or null
  }

  async start() {
    if (this.browser) return this;

    this.browser = await launchBrowser({ headless: this.headless });
    // Pick one outbound IP for this session's whole lifetime (null = direct/no pool).
    this._proxy = this._proxyPool.next();
    const ctxOpts = { ignoreHTTPSErrors: true, serviceWorkers: 'block' };
    if (this._proxy) ctxOpts.proxy = { server: this._proxy.server, username: this._proxy.username, password: this._proxy.password };
    // Playwright's JavaScript API uses newContext(). Keep the fallback so this
    // wrapper can also be exercised with older/mocked ports of the API.
    this.context = this.browser.newContext
      ? await this.browser.newContext(ctxOpts)
      : await this.browser.new_context({ ignore_https_errors: true });
    await this._applyRouting(this.context);
    this.page = this.context.newPage
      ? await this.context.newPage()
      : await this.context.new_page();
    this._attachPage(this.page);

    try {
      await this._openForm();
      console.log(`[otp] TNSERVICES ${this.formKind} form ready (#districtCode present)`);
      return this;
    } catch (error) {
      await this.close();
      throw new Error(`Unable to open the TNSERVICES ${this.formKind} form: ${error.message}`);
    }
  }

  /**
   * Re-navigate from the government HOME page to mint a brand-new session (fresh
   * JSESSIONID + rno) on this already-launched browser. The govt page expires
   * while a warm browser sits parked (keep-alive is off), so a pooled browser must
   * refresh before it sends an OTP — otherwise the govt rejects the flow. Reuses
   * the live Chromium (no cold-launch), so it is far faster than a fresh browser.
   */
  async refreshSession() {
    if (!this.page || this.page.isClosed()) throw new Error('Cannot refresh a closed session');
    // Drop any warm location/parcel state so sendOtp re-fills against the fresh form.
    this._locationKey = null;
    this._parcelFilledKey = null;
    this.formData = null;
    await this._openForm();
    return this;
  }

  /**
   * Navigate the government access chain: index.html → click "View Patta /
   * Chitta / FMB" → land on the form (#districtCode). This mints the `rno` access
   * token bound to the current JSESSIONID. Used by both start() (fresh) and
   * restoreFrom() (with a restored JSESSIONID).
   */
  async _openForm() {
    // The access chain (index → "View Patta" → form) is fully IDEMPOTENT and
    // pre-OTP, so a transient nav/new-tab blip is safe to retry — this removes a
    // common class of "session never started" failures with zero OTP risk.
    await retry(async (bail) => {
      await this.page.goto(TNSERVICES_HOME, { waitUntil: 'domcontentloaded', timeout: this.timeoutMs });
      // Resilient to a govt label/markup tweak (common on this portal): match the
      // visible text, or the form's href, or the link role — whichever appears.
      const acc = this.accessConfig;
      const entry = this.page.getByText(acc.linkText)
        .or(this.page.locator(`a[href*="${acc.href}"]`))
        .or(this.page.getByRole('link', { name: acc.role }))
        .first();
      try {
        await entry.waitFor({ timeout: this.timeoutMs });
      } catch (e) {
        // Nothing matched — retrying a fresh nav may help; only bail on a hard
        // access rejection where retrying is pointless.
        if (/INVALID\s+ACCESS/i.test(await this.page.content().catch(() => ''))) {
          // The govt refused the entry page — treat as a possible IP block: cool this
          // proxy down so the next session rotates to a different IP.
          this._proxyPool.markBad(this._proxy);
          return bail(new Error('INVALID ACCESS on the entry page'));
        }
        throw e;
      }
      const originalPage = this.page;
      const newPagePromise = this._waitForNewPage(5000);
      await entry.click();
      const openedPage = await Promise.race([
        newPagePromise,
        originalPage.waitForSelector('#districtCode', { timeout: this.timeoutMs }).then(() => null),
      ]);
      if (openedPage) {
        this.page = openedPage;
        this._attachPage(openedPage);
      }
      await this.page.waitForSelector('#districtCode', { timeout: this.timeoutMs });
    }, { retries: 2, factor: 2, minTimeout: 300, maxTimeout: 2500, randomize: true });
    await this._waitForNetworkIdle(this.page);
    this._navigatedAt = Date.now(); // when this session's govt page was minted
    this._proxyPool.markGood(this._proxy); // this proxy reached the govt form → healthy
  }

  /**
   * Abort third-party analytics/media on the session context. Government hosts
   * (and their images/fonts/CSS/scripts, needed for the captured result PDF) are
   * always allowed through — only trackers and audio/video are dropped.
   */
  async _applyRouting(context) {
    // OFF by default. Aborting ANY request on the live OTP session risks the govt
    // flow, so only enable (MPQR_BLOCK_TRACKERS=on) once proven safe on a real OTP.
    if (process.env.MPQR_BLOCK_TRACKERS !== 'on') return;
    if (!context || typeof context.route !== 'function') return;
    try {
      await context.route('**/*', (route) => {
        try {
          const req = route.request();
          const url = req.url();
          if (GOVT_HOSTS.test(url)) return route.continue();
          if (req.resourceType() === 'media' || BLOCK_HOSTS.test(url)) return route.abort();
          return route.continue();
        } catch (_) {
          try { return route.continue(); } catch (e) { /* route already handled */ }
        }
      });
    } catch (_) { /* routing is best-effort */ }
  }

  _attachPage(page) {
    if (!page || page.__mpqrDialogAttached) return;
    page.__mpqrDialogAttached = true;
    page.on('dialog', (dialog) => {
      this._handleDialog(dialog).catch((error) => {
        console.warn('[Playwright] dialog handler failed:', error.message);
      });
    });
  }

  async _handleDialog(dialog) {
    const message = dialog.message();
    this.dialogMessage = message;
    console.log(`[Playwright] dialog ${dialog.type()}: ${message}`);
    this.emit('dialog_message', message);

    for (const waiter of this._dialogWaiters) waiter(message);
    this._dialogWaiters.clear();

    try {
      await dialog.accept();
    } catch (error) {
      // A second listener or the page closing can make the dialog unavailable.
    }
  }

  _waitForDialog(timeoutMs = this.timeoutMs) {
    return new Promise((resolve) => {
      let settled = false;
      const done = (message) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this._dialogWaiters.delete(done);
        resolve(message || null);
      };
      const timer = setTimeout(() => done(null), timeoutMs);
      this._dialogWaiters.add(done);
    });
  }

  async _waitForNewPage(timeoutMs) {
    if (!this.context || typeof this.context.waitForEvent !== 'function') return null;
    try {
      return await this.context.waitForEvent('page', { timeout: timeoutMs });
    } catch (error) {
      return null;
    }
  }

  async _waitForNetworkIdle(page = this.page) {
    // The government pages keep analytics/tracker sockets alive, so 'networkidle'
    // is essentially NEVER reached — this is only a short best-effort settle, since
    // DOM selectors are the authoritative readiness signal and callers already
    // await them. With third-party trackers now blocked (_applyRouting), the page
    // actually settles, so this shim can be short. Tunable via MPQR_NETWORKIDLE_MS.
    const cap = Math.max(200, Number(process.env.MPQR_NETWORKIDLE_MS || 800));
    try {
      await page.waitForLoadState('networkidle', { timeout: cap });
    } catch (error) {
      // Expected on any page still holding a socket open; the required DOM is
      // already loaded, so proceed immediately.
    }
  }

  async _selectWhenAvailable(selector, value) {
    const stringValue = String(value);
    const started = Date.now();
    await this.page.waitForSelector(selector, { timeout: this.timeoutMs });
    try {
      await this.page.waitForFunction(
        ({ selector: currentSelector, value: currentValue }) => {
          const select = document.querySelector(currentSelector);
          return !!select && Array.from(select.options || []).some((option) => option.value === currentValue);
        },
        { selector, value: stringValue },
        { timeout: this.timeoutMs },
      );
    } catch (error) {
      // Name the offending dropdown and dump what DID load. The government
      // cascade (district→taluk→village→subdiv, each populated by its own
      // AJAX) is the usual failure point; the generic waitForFunction timeout
      // hid which step failed and why.
      const available = await this.page
        .$$eval(`${selector} option`, (nodes) => nodes.map((n) => n.value).filter(Boolean))
        .catch(() => []);
      throw new Error(`option "${stringValue}" never appeared in ${selector} within ${this.timeoutMs}ms (loaded options: ${JSON.stringify(available).slice(0, 400)})`);
    }
    await this.page.selectOption(selector, stringValue);
    console.log(`[otp] ${selector} = ${stringValue} (${Date.now() - started}ms)`);
  }

  /**
   * Browser fetch for an already-OTP-verified session: load the verified
   * session cookies into a fresh Chromium, navigate the English form, fill the
   * parcel, echo the verified mobile/OTP into the *_ver fields, and submit —
   * returning the chitta HTML. This is the piece that CANNOT be done over pure
   * HTTP (chkrno/ajax_rno are JS-computed).
   */
  async fetchWithCookies(cookies, survey, mobile, otp) {
    this.browser = await launchBrowser({ headless: this.headless });
    this.context = await this.browser.newContext({ ignoreHTTPSErrors: true });
    if (Array.isArray(cookies) && cookies.length) {
      await this.context.addCookies(cookies).catch((e) => console.warn('[fetch] addCookies:', e.message));
    }
    this.page = await this.context.newPage();
    this._attachPage(this.page);
    // GET the form DIRECTLY with the verified cookie — do NOT navigate
    // index.html, which mints a fresh (unverified) JSESSIONID and discards the
    // verified one (that's why the earlier fresh-browser test returned the form).
    await this.page.goto(this.accessConfig.extractUrl, {
      waitUntil: 'domcontentloaded', timeout: this.timeoutMs,
    });
    await this.page.waitForSelector('#districtCode', { timeout: this.timeoutMs });
    await this._waitForNetworkIdle(this.page);

    const nflag = survey.nflag || 'Y';
    await this._selectWhenAvailable('#districtCode', String(survey.districtCode));
    const talukValue = String(survey.talukCode).includes('/') ? survey.talukCode : `${survey.talukCode}/${nflag}`;
    await this._selectWhenAvailable('#talukCode', talukValue);
    await this._selectWhenAvailable('#villageCode', String(survey.villageCode));
    const viewOpt = survey.viewOpt || 'sur';
    const vr = this.page.locator(`input[name="viewOpt"][value="${viewOpt}"]`);
    if (await vr.count()) await vr.first().check({ force: true }).catch(() => {});
    const lt = this.page.locator(`#landtype[value="${survey.landType || 'R'}"]`);
    if (await lt.count()) await lt.first().check({ force: true }).catch(() => lt.first().click({ force: true }).catch(() => {}));
    await this.page.fill('#surveyNo', String(survey.surveyNo));
    await this.page.dispatchEvent('#surveyNo', 'change');
    await this.page.fill('#mobileno', String(mobile));
    await this._selectWhenAvailable('#subdivNo', String(survey.subDivNo || survey.subdivNo));

    // Session is already verified (cookie) — echo the verified mobile/OTP.
    await this.page.evaluate(({ m, o }) => {
      const set = (sel, v) => { const e = document.querySelector(sel); if (e) e.value = v; };
      set('#otpno', o);
      set('input[name="mobileno_ver"]', m);
      set('input[name="otpno_ver"]', o);
    }, { m: String(mobile), o: String(otp) });

    const oldPage = this.page;
    const newPagePromise = this._waitForNewPage(5000).then((p) => ({ page: p }));
    const navPromise = oldPage.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: this.timeoutMs })
      .then(() => ({ page: oldPage })).catch(() => ({ page: null }));
    await oldPage.click('input[type="submit"].button').catch(() => {});
    const done = await Promise.race([newPagePromise, navPromise]);
    if (done.page && done.page !== oldPage) {
      this.page = done.page;
      this._attachPage(done.page);
      await done.page.waitForLoadState('domcontentloaded', { timeout: this.timeoutMs }).catch(() => {});
    }
    await this.page.waitForSelector('table', { timeout: this.timeoutMs });
    return this.page.content();
  }

  /**
   * Fill the selected parcel and ask TNSERVICES to send an OTP.
   * Returns the alert message, normally "OTP sent to XXXXX".
   */
  /** Parcel key (mobile-independent) — tells whether a warm fill still matches. */
  parcelKey(p = {}) {
    const sub = p.subdivNo != null ? p.subdivNo : p.subDivNo;
    return [p.districtCode, p.talukCode, p.villageCode, p.surveyNo, sub, p.landType || 'R', p.nflag || 'Y']
      .map((x) => String(x == null ? '' : x)).join('|');
  }

  /**
   * Fill the parcel (district → taluk → village → survey → sub-division) WITHOUT
   * sending the OTP. This is the slow part (the AJAX cascade), so it runs ahead
   * in the background (pre-warm) while the customer is still typing their mobile.
   */
  async fillParcel({ districtCode, talukCode, villageCode, surveyNo, subdivNo, subDivNo, landType = 'R', nflag = 'Y' }) {
    if (!this.page || this.page.isClosed()) throw new Error('Playwright session is not started');
    const selectedSubdiv = subdivNo != null ? subdivNo : subDivNo;
    const required = { districtCode, talukCode, villageCode, surveyNo, subdivNo: selectedSubdiv };
    for (const [name, value] of Object.entries(required)) {
      if (value == null || String(value).trim() === '') throw new Error(`Missing ${name}`);
    }
    this.formData = {
      ...(this.formData || {}),
      districtCode: String(districtCode), talukCode: String(talukCode), villageCode: String(villageCode),
      surveyNo: String(surveyNo), subdivNo: String(selectedSubdiv),
      landType: String(landType || 'R'), nflag: String(nflag || 'Y'),
    };

    await this._selectWhenAvailable('#districtCode', this.formData.districtCode);
    // #talukCode options are "<code>/<nflag>" (e.g. "01/Y"), not the bare "01".
    const talukValue = this.formData.talukCode.includes('/')
      ? this.formData.talukCode
      : `${this.formData.talukCode}/${this.formData.nflag}`;
    await this._selectWhenAvailable('#talukCode', talukValue);
    await this._selectWhenAvailable('#villageCode', this.formData.villageCode);

    const surveyRadio = this.page.locator('input[name="viewOpt"][value="sur"]');
    if (await surveyRadio.count()) await surveyRadio.first().check({ force: true }).catch(() => {});

    // Land Type radio (Rural=R / Natham=N): BOTH options share id="landtype" and
    // the Natham one has malformed HTML (`id="landtype" "="" name=…`), so neither
    // Playwright's attribute selector nor .check() can reliably pick Natham — the
    // bot could NEVER choose it. Set .checked via the DOM value property (which
    // works regardless of the broken attribute) and call the form's own
    // viewlandtype() so its state updates. Survey + subdiv are filled AFTER this.
    await this.page.evaluate((want) => {
      const radios = document.querySelectorAll('input[name="landtype"]');
      radios.forEach((el) => { el.checked = (el.value === want); });
      try { if (typeof viewlandtype === 'function') viewlandtype(want); } catch (e) {}
    }, this.formData.landType || 'R').catch(() => {});

    await this.page.fill('#surveyNo', this.formData.surveyNo);
    await this.page.dispatchEvent('#surveyNo', 'change');
    await this._selectWhenAvailable('#subdivNo', this.formData.subdivNo);
    this._parcelFilledKey = this.parcelKey(this.formData);
    console.log('[otp] parcel filled (ready for OTP)');
    return true;
  }

  /**
   * TEMP diagnostic: fill the parcel, then dump exactly what the govt form's
   * "Send OTP" validation reads (the #sendtpid handler + the JS that raises
   * "Please Enter Subdivision Number" + every subdiv-related field). Lets us see
   * WHY a selected #subdivNo still reads as empty to the form.
   */
  async inspectSendValidation(parcel) {
    let fillError = null;
    try { await this.fillParcel(parcel); } catch (e) { fillError = e.message; }
    await this.page.fill('#mobileno', '9000000001').catch(() => {});
    const result = await this.page.evaluate(async () => {
      const out = { subFields: [], validationSnippets: [] };
      // otpgenerate lives in an external .js — fetch same-origin scripts and grab it.
      const srcs = Array.from(document.querySelectorAll('script[src]')).map((s) => s.src);
      out.scriptSrcs = srcs;
      for (const src of srcs) {
        try {
          const r = await fetch(src);
          const t = await r.text();
          const gi = t.indexOf('function otpgenerate');
          if (gi >= 0 && !out.otpgenerateSrc) { out.otpgenerateSrc = t.slice(gi, gi + 2200); out.otpgenerateFrom = src; }
        } catch (e) { /* cross-origin or 404 */ }
      }
      // Rural vs Natham: the landtype radios live in #landtype_opt, shown only
      // for /Y taluks. Dump them + their labels so we know the real values.
      const lto = document.getElementById('landtype_opt');
      out.landtypeOptHTML = lto ? lto.outerHTML.replace(/\s+/g, ' ').slice(0, 1400) : null;
      out.landtypeOptVisible = lto ? (lto.style.display !== 'none') : null;
      out.landtypeInputs = [];
      document.querySelectorAll('[name="landtype"], #landtype').forEach((el) => {
        let label = '';
        if (el.id) { const l = document.querySelector(`label[for="${el.id}"]`); if (l) label = l.textContent.trim(); }
        if (!label && el.parentElement) label = el.parentElement.textContent.replace(/\s+/g, ' ').trim().slice(0, 40);
        out.landtypeInputs.push({ tag: el.tagName, type: el.type, value: el.value, checked: el.checked, id: el.id, label });
      });
      const btn = document.querySelector('#sendtpid');
      out.sendtpidOnclick = btn ? btn.getAttribute('onclick') : null;
      out.sendtpidOuter = btn ? btn.outerHTML.slice(0, 400) : null;
      const sd = document.querySelector('#subdivNo');
      out.subdivId = sd ? { name: sd.name, id: sd.id, value: sd.value } : null;
      out.subdivOptions = sd ? Array.from(sd.options).map((o) => o.value) : null;
      document.querySelectorAll('input, select').forEach((el) => {
        const key = `${el.name || ''}|${el.id || ''}`;
        if (/sub|div|rno|chk/i.test(key)) out.subFields.push({ name: el.name, id: el.id, type: el.type, value: el.value, tag: el.tagName });
      });
      const f = document.forms[0];
      const fv = (n) => { try { return f[n] ? (f[n].value !== undefined ? f[n].value : '[radio/collection]') : '(none)'; } catch (e) { return '(err)'; } };
      out.formState = {
        viewOpt: (() => { try { return f.viewOpt.value; } catch (e) { return fv('viewOpt'); } })(),
        surveyNo: fv('surveyNo'), subdivNo: fv('subdivNo'), landtype: fv('landtype'),
        districtCode: fv('districtCode'), talukCode: fv('talukCode'), villageCode: fv('villageCode'),
        ptNo: fv('ptNo'), mobileno: fv('mobileno'),
      };
      // Grab the whole otpgenerate() function + any script mentioning the alert text.
      document.querySelectorAll('script').forEach((sc) => {
        const t = sc.textContent || '';
        const gi = t.indexOf('function otpgenerate');
        if (gi >= 0) out.otpgenerateSrc = t.slice(gi, gi + 1600);
        let i = t.search(/Enter\s+Sub|Subdivision|Sub\s*Division|Please\s+Enter/i);
        if (i >= 0) out.validationSnippets.push(t.slice(Math.max(0, i - 300), i + 120));
      });
      return out;
    });
    result.fillError = fillError;
    return result;
  }

  /** Fill the mobile and fire "Get OTP" — the fast final step on a warm form. */
  async fireOtp(mobile) {
    if (!this.page || this.page.isClosed()) throw new Error('Playwright session is not started');
    this.formData = { ...(this.formData || {}), mobile: String(mobile) };
    // Replicate the proven reference sequence (browser_utils.py fill_user_details)
    // EXACTLY: re-fire the survey `change` so the sub-division dropdown is
    // repopulated FRESH by its AJAX, fill mobile, then select the sub-division on
    // that fresh dropdown right before sending. Re-selecting a STALE (pre-warm)
    // dropdown sets the DOM value but NOT the form's validation state — so
    // #sendtpid still alerts "Please Enter Subdivision Number" even though the
    // value reads "1A" (confirmed: pre-send subdiv=1A yet the send was rejected).
    if (this.formData.surveyNo) {
      await this.page.fill('#surveyNo', this.formData.surveyNo);
      await this.page.dispatchEvent('#surveyNo', 'change');
    }
    await this.page.fill('#mobileno', this.formData.mobile);
    if (this.formData.subdivNo) {
      await this._selectWhenAvailable('#subdivNo', this.formData.subdivNo);
    }
    const preSendSub = await this.page.$eval('#subdivNo', (e) => e.value).catch(() => null);
    console.log('[otp] pre-send subdiv =', preSendSub);
    this.dialogMessage = null;
    const dialogPromise = this._waitForDialog(Math.min(this.timeoutMs, 10000));
    console.log('[otp] firing #sendtpid for', this.formData.mobile.replace(/\d(?=\d{4})/g, '*'));
    await this.page.click('#sendtpid');
    const message = await dialogPromise;
    console.log('[otp] send-OTP dialog:', message || '(no dialog within timeout)');
    return message || this.dialogMessage;
  }

  /** Location key = the pre-warmable part of a parcel (everything but survey/subdiv). */
  _locationKeyOf(p = {}) {
    return [p.districtCode, p.talukCode, p.villageCode, p.landType || 'R', p.nflag || 'Y']
      .map((x) => String(x == null ? '' : x)).join('|');
  }

  /**
   * Fill the parcel LOCATION (district → taluk → village → viewOpt → landtype) —
   * the slow AJAX cascade (~5s). This is pre-warmed in the BACKGROUND while the
   * customer types their mobile, so at send time only the survey + subdivision
   * (which must be freshly re-selected against the govt token) remain. Survey and
   * subdiv are deliberately NOT filled here.
   */
  async fillLocation(opts) {
    if (!this.page || this.page.isClosed()) throw new Error('Playwright session is not started');
    const nflag = String(opts.nflag || 'Y');
    await this._selectWhenAvailable('#districtCode', String(opts.districtCode));
    const talukValue = String(opts.talukCode).includes('/') ? String(opts.talukCode) : `${opts.talukCode}/${nflag}`;
    await this._selectWhenAvailable('#talukCode', talukValue);
    await this._selectWhenAvailable('#villageCode', String(opts.villageCode));
    const surveyRadio = this.page.locator('input[name="viewOpt"][value="sur"]');
    if (await surveyRadio.count()) await surveyRadio.first().check({ force: true }).catch(() => {});
    await this.page.evaluate((want) => {
      document.querySelectorAll('input[name="landtype"]').forEach((el) => { el.checked = (el.value === want); });
      try { if (typeof viewlandtype === 'function') viewlandtype(want); } catch (e) {}
    }, String(opts.landType || 'R')).catch(() => {});
    this._locationKey = this._locationKeyOf(opts);
    console.log('[otp] location filled (prewarm-ready):', this._locationKey);
  }

  /**
   * Fill the whole parcel + mobile and send the OTP in ONE clean pass — exactly
   * the proven reference sequence (browser_utils.py fill_user_details):
   *   district → taluk → village → viewOpt(sur) → landtype → survey → change →
   *   mobile → select subdiv on the SETTLED dropdown → #sendtpid.
   *
   * Crucially there is exactly ONE survey `change` → ONE getSubdivNo AJAX. Doing
   * the fill twice (pre-warm fill + a re-fill/re-select at send) races that AJAX:
   * it repopulates #subdivNo and wipes the selection right before otpgenerate()
   * reads document.forms[0].subdivNo.value → "Please Enter Subdivision Number"
   * (confirmed: the value read "1A" on inspect yet the send was rejected).
   */
  async sendOtp(opts) {
    if (!this.page || this.page.isClosed()) throw new Error('Playwright session is not started');
    const selectedSubdiv = opts.subdivNo != null ? opts.subdivNo : opts.subDivNo;
    const required = {
      districtCode: opts.districtCode, talukCode: opts.talukCode, villageCode: opts.villageCode,
      surveyNo: opts.surveyNo, subdivNo: selectedSubdiv, mobile: opts.mobile,
    };
    for (const [name, value] of Object.entries(required)) {
      if (value == null || String(value).trim() === '') throw new Error(`Missing ${name}`);
    }
    this.formData = {
      districtCode: String(opts.districtCode), talukCode: String(opts.talukCode),
      villageCode: String(opts.villageCode), surveyNo: String(opts.surveyNo),
      subdivNo: String(selectedSubdiv), landType: String(opts.landType || 'R'),
      nflag: String(opts.nflag || 'Y'), mobile: String(opts.mobile),
    };

    // Fill the LOCATION (district→taluk→village→viewOpt→landtype) — the slow AJAX
    // cascade. If it was already pre-warmed in the background for this location,
    // skip it (that's the whole speed win: the send then only does survey+subdiv).
    const locKey = this._locationKeyOf(this.formData);
    if (this._locationKey !== locKey) {
      await this.fillLocation(this.formData);
    } else {
      console.log('[otp] location already warm — skipping cascade');
    }

    // ONE survey change → mobile → select subdiv on the fresh dropdown → send.
    await this.page.fill('#surveyNo', this.formData.surveyNo);
    await this.page.dispatchEvent('#surveyNo', 'change');
    await this.page.fill('#mobileno', this.formData.mobile);
    await this._selectWhenAvailable('#subdivNo', this.formData.subdivNo);
    this._parcelFilledKey = this.parcelKey(this.formData);

    const preSendSub = await this.page.$eval('#subdivNo', (e) => e.value).catch(() => null);
    const preViewOpt = await this.page.$eval('input[name="viewOpt"]:checked', (e) => e.value).catch(() => null);
    console.log('[otp] pre-send subdiv =', preSendSub, '| viewOpt =', preViewOpt);
    this.dialogMessage = null;
    const timeout = Math.min(this.timeoutMs, 12000);
    // On a REAL send the govt reveals the OTP-entry box and starts a 2:00
    // countdown, with NO dialog. On ANY failure it shows an alert dialog. Race the
    // two so we resolve the instant EITHER definitive signal appears (avoids the
    // ~10s stall of waiting for a dialog that never comes on success).
    //
    // CRITICAL: we must NOT treat the Send button going disabled as success. The
    // govt disables #sendtpid the instant it's clicked for EVERY outcome (success
    // AND failure), so "button disabled" was a false positive that reported "OTP
    // sent" when the govt had actually rejected it (e.g. "maximum attempts"). The
    // ONLY trustworthy success signals are the OTP box appearing or the countdown
    // starting. If NEITHER a box nor a dialog appears, we do not claim success.
    const dialogPromise = this._waitForDialog(timeout);
    const successPromise = this.page.waitForFunction(() => {
      const cv = document.getElementById('otpcodeview');
      const cd = document.getElementById('countdown');
      return !!(
        (cv && getComputedStyle(cv).display !== 'none')
        || (cd && /[0-9]\s*:\s*[0-9]/.test(cd.textContent || ''))
      );
    }, { timeout, polling: 120 }).then(() => true).catch(() => false);
    console.log('[otp] firing #sendtpid for', this.formData.mobile.replace(/\d(?=\d{4})/g, '*'));
    const tSend = Date.now();
    await this.page.click('#sendtpid');
    // Whichever DEFINITIVE outcome lands first wins. A non-signal (no dialog, or
    // the box never appeared) maps to a never-resolving promise so it can't be
    // mistaken for success; a hard timeout is the backstop that forces a failure.
    const PENDING = new Promise(() => {});
    const outcome = await Promise.race([
      dialogPromise.then((m) => (m ? { dialog: m } : PENDING)),
      successPromise.then((ok) => (ok ? { success: true } : PENDING)),
      new Promise((res) => setTimeout(() => res({ unconfirmed: true }), timeout + 500)),
    ]);
    if (outcome.dialog) {
      console.log('[otp] send-OTP FAILED (dialog) in', Date.now() - tSend, 'ms:', outcome.dialog);
      return outcome.dialog; // caller treats ANY dialog as a failed send
    }
    if (outcome.success) {
      console.log('[otp] OTP sent (box shown) in', Date.now() - tSend, 'ms');
      return null; // null → begin treats as success
    }
    console.log('[otp] send-OTP UNCONFIRMED in', Date.now() - tSend, 'ms (no box, no dialog)');
    throw new Error('The government site did not confirm the OTP was sent (no code box appeared). Please try again.');
  }

  /**
   * Keep the government session (JSESSIONID) from idling out while this browser
   * sits waiting — parked in the warm pool, or holding a sent OTP while the
   * customer is away reading the SMS. A lightweight same-origin GET through the
   * context's request jar (NOT a page navigation) resets the server-side idle
   * timer while leaving the live page — crucially the revealed OTP box + its
   * countdown — completely untouched. Idempotent; unref'd so it never blocks exit.
   */
  startKeepAlive(intervalMs) {
    if (this._keepAliveTimer || this._closed) return;
    // DISABLED unless a POSITIVE interval is configured (MPQR_KEEPALIVE_MS>0). The
    // in-page ser=dist ping + cookie-restore was corrupting the live govt OTP
    // session (the govt then rejected correct OTPs as "invalid otp"), so keep-alive
    // is OFF by default. Only re-enable once proven safe against a real OTP.
    const raw = Number(intervalMs != null ? intervalMs : (process.env.MPQR_KEEPALIVE_MS || 0));
    if (!(raw > 0)) return;
    const ms = Math.max(5000, raw);
    this._keepAliveTimer = setInterval(() => { this._pingSession().catch(() => {}); }, ms);
    if (this._keepAliveTimer.unref) this._keepAliveTimer.unref();
  }

  /** Stop scheduling pings (synchronous — does NOT wait for one already in flight). */
  stopKeepAlive() {
    if (this._keepAliveTimer) { clearInterval(this._keepAliveTimer); this._keepAliveTimer = null; }
  }

  /**
   * Stop the pings AND wait for any in-flight one to settle. Callers MUST await
   * this (not the bare stopKeepAlive) before actively driving the tab — sending,
   * resending, or submitting the OTP — so a ping can never run concurrently with
   * the drive.
   */
  async quiesceKeepAlive() {
    this.stopKeepAlive();
    if (this._pingInFlight) { try { await this._pingInFlight; } catch (_) {} }
  }

  /**
   * Call a government ajax endpoint through THIS browser's request context — it
   * shares the page's TLS fingerprint + JSESSIONID cookie + rno, which the govt
   * firewall/session require (bare Node/axios calls get "INVALID ACCESS"). Used
   * for live dropdown data and the keep-alive liveness probe. Never touches the
   * page DOM. Returns { status, body }.
   */
  async govtAjax(query, { method = 'POST', timeoutMs } = {}) {
    if (!this.page || this.page.isClosed()) throw new Error('Playwright session is not started');
    const ms = timeoutMs || this.timeoutMs;
    // Run the ajax IN THE PAGE's own JS context (same origin, referer, cookies and
    // request pipeline the govt's own scripts use). The govt firewall/session
    // rejects EXTERNAL requests — axios AND Playwright's context.request both get
    // "INVALID ACCESS" — but the page's own fetch is accepted.
    return this.page.evaluate(async ({ q, m, t }) => {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), t);
      try {
        const r = await fetch('/eservicesnew/land/ajax.html?' + q, {
          method: m, credentials: 'include', headers: { 'X-Requested-With': 'XMLHttpRequest' }, signal: ctrl.signal,
        });
        return { status: r.status, body: await r.text() };
      } catch (e) {
        return { status: 0, body: '', err: String((e && e.message) || e) };
      } finally { clearTimeout(timer); }
    }, { q: query, m: method, t: ms });
  }

  /**
   * One keep-alive touch. It probes `ser=dist` (the districts read) through the
   * browser's request context — a SESSION-SCOPED call that returns the districts
   * JSON for a LIVE session and "INVALID ACCESS" for a dead one. So it both keeps
   * the JSESSIONID warm AND truthfully detects liveness. (A bare GET of the form
   * URL returns "INVALID ACCESS" even for a HEALTHY session — that was falsely
   * marking every warm browser dead.) Never touches the page DOM / OTP box.
   *
   * Cookie-jar guard: context.request writes response Set-Cookie back into the
   * SHARED jar, so a rogue JSESSIONID rotation would re-bind the live page to a
   * session with no pending OTP. We snapshot + restore the session cookie so the
   * keep-alive can never break a verify that would otherwise have succeeded.
   */
  async _pingSession() {
    if (this._closed || !this.context || !this.page || this.page.isClosed()) {
      this.stopKeepAlive();
      return false;
    }
    if (this._pingInFlight) return this._pingInFlight; // never overlap pings
    const origin = 'https://eservices.tn.gov.in';
    this._pingInFlight = (async () => {
      const before = await this._sessionCookie(origin);
      try {
        const { status, body } = await this.govtAjax(
          'page=ruralservice&ser=dist&lang=en&type=rur&call_type=ser',
          { timeoutMs: 8000 },
        );
        const statusOk = status >= 200 && status < 300;
        // Live districts JSON contains dcode/dname; a dead session returns INVALID ACCESS.
        const alive = statusOk && !/INVALID\s+ACCESS/i.test(body) && /dcode|dname/i.test(body);
        this._lastKeepAliveAt = Date.now();
        this._lastKeepAliveOk = alive;
        await this._restoreSessionCookie(origin, before);
        if (!alive) console.warn('[keepalive] govt session not alive (status/body)');
        return alive;
      } catch (e) {
        this._lastKeepAliveOk = false;
        return false;
      } finally {
        this._pingInFlight = null;
      }
    })();
    return this._pingInFlight;
  }

  /** The government session cookie (JSESSIONID) currently in the jar for `url`. */
  async _sessionCookie(url) {
    try {
      const cookies = await this.context.cookies(url);
      return (cookies || []).find((c) => /jsession|session/i.test(c.name)) || null;
    } catch (_) { return null; }
  }

  /** Undo any keep-alive-induced session-cookie rotation (see _pingSession). */
  async _restoreSessionCookie(url, original) {
    if (!original) return;
    try {
      const now = await this._sessionCookie(url);
      if (now && now.value !== original.value) {
        await this.context.addCookies([original]);
        console.warn('[keepalive] ignored govt Set-Cookie —', original.name, 'restored to the pending-OTP session');
      }
    } catch (_) {}
  }

  /** True if the last keep-alive touch found the session dead/unreachable. */
  keepAliveFailed() {
    return this._lastKeepAliveOk === false;
  }

  /** Re-fire "Get OTP" on the already-filled form (same live tab). */
  async resendOtp() {
    if (!this.page || this.page.isClosed()) throw new Error('Playwright session is closed');
    this.dialogMessage = null;
    const dialogPromise = this._waitForDialog(Math.min(this.timeoutMs, 10000));
    await this.page.click('#sendtpid').catch(() => {});
    return (await dialogPromise) || this.dialogMessage;
  }

  /**
   * SMOKING-GUN TEST (Solution A): after start() has navigated to the form,
   * fire otpgeneratenew via the BROWSER's own request context — same TLS/JA3
   * fingerprint + cookie jar as the page that just loaded. If this returns 200
   * + a token, the axios 500 was TLS fingerprinting and the fix is to route all
   * gov calls through context.request instead of axios.
   */
  async smokeTestOtp(parcel = {}) {
    const p = {
      districtCode: parcel.districtCode || '17',
      talukCode: parcel.talukCode || '01',
      villageCode: parcel.villageCode || '092',
      surveyNo: parcel.surveyNo || '1',
      subdivNo: parcel.subdivNo || parcel.subDivNo || '1A',
      nflag: parcel.nflag || 'Y',
      mobile: parcel.mobile || '9876543210',
    };
    // Fill the parcel exactly like the working UI path.
    await this._selectWhenAvailable('#districtCode', p.districtCode);
    const talukValue = String(p.talukCode).includes('/') ? p.talukCode : `${p.talukCode}/${p.nflag}`;
    await this._selectWhenAvailable('#talukCode', talukValue);
    await this._selectWhenAvailable('#villageCode', p.villageCode);
    const surveyRadio = this.page.locator('input[name="viewOpt"][value="sur"]');
    if (await surveyRadio.count()) await surveyRadio.first().check({ force: true }).catch(() => {});
    // Land type (Rural) — the subdiv AJAX (getSubdivNo&…&landtype=R) needs it.
    const ruralRadio = this.page.locator('#landtype[value="R"]');
    if (await ruralRadio.count()) {
      await ruralRadio.first().check({ force: true }).catch(() => ruralRadio.first().click({ force: true }).catch(() => {}));
    } else {
      const lt = this.page.locator('#landtype');
      if (await lt.count()) await lt.first().click({ force: true }).catch(() => {});
    }
    await this.page.fill('#surveyNo', String(p.surveyNo));
    await this.page.dispatchEvent('#surveyNo', 'change');
    await this.page.fill('#mobileno', String(p.mobile));
    await this._selectWhenAvailable('#subdivNo', String(p.subdivNo));
    const hidden = await this.page.$eval('input[name="ajax_rno"], #ajax_rno', (e) => e.value).catch(() => null);
    const lan = (() => { try { return new URL(this.page.url()).searchParams.get('lan') || 'en'; } catch (e) { return 'en'; } })();
    // THE FIX: the endpoint wants a JSON body (not form-urlencoded), with the
    // hidden ajax_rno as TOKEN. Replicate it via the browser's request context.
    const resp = await this.context.request.post(
      'https://eservices.tn.gov.in/eservicesnew/land/ajax.html?page=otpgeneratenew',
      {
        data: JSON.stringify({ mobileno: String(p.mobile), actionid: 'AC01', lan, TOKEN: hidden || '' }),
        headers: { 'Content-Type': 'application/json; charset=UTF-8', 'X-Requested-With': 'XMLHttpRequest', 'Referer': this.page.url() },
        timeout: this.timeoutMs,
      },
    );
    const status = resp.status();
    const body = await resp.text();
    let newTk = null; try { newTk = JSON.parse(body).new_tk; } catch (e) {}
    // Dump the chitta form the browser would submit — its action = the real
    // fetch URL, and its field names/values are the exact fetch payload.
    const formInfo = await this.page.evaluate(() => {
      const forms = Array.from(document.querySelectorAll('form'));
      return forms.map((form) => {
        const fields = {};
        for (const el of form.querySelectorAll('input, select, textarea')) {
          if (el.name) fields[el.name] = String(el.value == null ? '' : el.value).slice(0, 24);
        }
        return { action: form.action, method: (form.method || 'get').toLowerCase(), id: form.id || null, fields };
      });
    });
    // Also capture the chitta submit button's onclick target if present.
    const submitInfo = await this.page.evaluate(() => {
      const btn = document.querySelector('input[type="submit"].button, #getChitta, [onclick*="chitta" i], [onclick*="submit" i]');
      return btn ? { tag: btn.tagName, value: btn.value || btn.textContent || '', onclick: btn.getAttribute('onclick') || null } : null;
    });
    // Capture the form links on the entry pages so the axios warmup can target
    // the SAME (English) form the fetch belongs to.
    const grab = async (path) => {
      try {
        const rr = await this.context.request.get('https://eservices.tn.gov.in/eservicesnew' + path);
        const bb = await rr.text();
        const links = [...bb.matchAll(/(chitta[A-Za-z_]*\.html\?lan=[a-z]+&rno=[A-Za-z0-9]{6,})/gi)]
          .map((x) => x[1].replace(/&rno=[A-Za-z0-9]+/, '&rno=<RNO>'))
          .filter((v, i, a) => a.indexOf(v) === i).slice(0, 5);
        return { status: rr.status(), links };
      } catch (e) { return { error: e.message }; }
    };
    return {
      approach: 'context.request + JSON',
      status,
      hasNewTk: !!newTk,
      forms: formInfo,
      submitButton: submitInfo,
      indexLinks: await grab('/index.html'),
      homeLinks: await grab('/home.html'),
    };
  }

  /**
   * Verify the OTP, submit the parcel form, and wait for the Chitta result.
   */
  async submitOtp(otp) {
    if (!this.page || this.page.isClosed()) {
      return { verified: false, message: 'Playwright session is closed' };
    }
    if (!/^\d{4,8}$/.test(String(otp || '').trim())) {
      return { verified: false, message: 'OTP must contain 4 to 8 digits' };
    }

    // Once the govt confirms the OTP, it is CONSUMED. Any failure AFTER that point
    // must report otpAccepted:true so the caller classifies it as a wasted-OTP
    // (terminal) outcome, NOT as WRONG_OTP (which would tell the customer to retype
    // and burn a second OTP).
    let otpAccepted = false;
    this.dialogMessage = null;
    try {
      await this.page.waitForSelector('#otpno', { timeout: this.timeoutMs });
      await this.page.fill('#otpno', String(otp).trim());

      const dialogPromise = this._waitForDialog(Math.min(this.timeoutMs, 10000));
      await this.page.click('#otpval');
      const message = (await dialogPromise) || this.dialogMessage || '';
      console.log('[otp] submit-OTP dialog:', message || '(none)');

      // Session that idled out server-side: NOT a wrong OTP — the page sat too long.
      if (this._looksExpired(message)) {
        return { verified: false, sessionExpired: true, otpAccepted: false, message: message || 'Government session expired' };
      }
      if (/invalid\s*otp|otp[_\s-]*false|wrong\s*otp/i.test(message)) {
        return { verified: false, otpAccepted: false, message };
      }
      if (!/verified|otp[_\s-]*true|success/i.test(message)) {
        return { verified: false, otpAccepted: false, message: message || 'TNSERVICES did not confirm OTP verification' };
      }
      // Govt CONFIRMED the OTP here — it is now consumed. From this line on, every
      // exit (including the outer catch) reports otpAccepted:true.
      otpAccepted = true;

      // Keep the verified form token and flags. Subsequent pooled requests are
      // posted from Chromium with these values, just as the legacy verified
      // session reused its new_tk for the government quota.
      this._verifiedSubmission = await this.page.evaluate(() => {
        const form = document.querySelector('form');
        if (!form) throw new Error('Verified TNSERVICES form not found');
        const mobile = form.querySelector('#mobileno');
        const otp = form.querySelector('#otpno');
        const mobileVerified = form.querySelector('#mobileno_ver');
        const otpVerified = form.querySelector('#otpno_ver');
        if (mobileVerified && mobile) mobileVerified.value = mobile.value;
        if (otpVerified && otp) otpVerified.value = otp.value;
        return {
          action: form.action,
          referrer: document.location.href,
          fields: Object.fromEntries(new FormData(form).entries()),
        };
      });

      // Re-assert the parcel on the verified form ONLY IF it actually blanked
      // during the OTP round-trip (the wait while the customer reads the SMS) —
      // otherwise Submit bounces as "Enter Valid Patta". But re-firing the survey
      // `change` when the parcel is still intact needlessly races the getSubdivNo
      // AJAX (which repopulates + wipes #subdivNo), so guard it with a value check.
      try {
        if (this.formData) {
          const cur = await this.page.evaluate(() => {
            const v = (s) => { const e = document.querySelector(s); return e ? e.value : ''; };
            return { survey: v('#surveyNo'), subdiv: v('#subdivNo') };
          }).catch(() => ({ survey: '', subdiv: '' }));
          if (cur.survey !== this.formData.surveyNo || cur.subdiv !== this.formData.subdivNo) {
            console.log('[otp] parcel blanked during OTP wait — re-asserting before Submit');
            await this.page.fill('#surveyNo', this.formData.surveyNo);
            await this.page.dispatchEvent('#surveyNo', 'change');
            await this._selectWhenAvailable('#subdivNo', this.formData.subdivNo);
          }
          // Ensure the landtype radio (Rural=R / Natham=N) is still checked — the
          // govt server needs it to locate the record, and the OTP round-trip can
          // uncheck it. Set it directly; do NOT fire viewlandtype() (that re-runs
          // the subdiv AJAX and would race the selection we just confirmed).
          await this.page.evaluate((want) => {
            document.querySelectorAll('input[name="landtype"]').forEach((el) => { el.checked = (el.value === want); });
          }, this.formData.landType || 'R').catch(() => {});
        }
      } catch (refillErr) {
        console.warn('[otp] parcel re-fill before submit failed:', refillErr.message);
      }
      const preSubmit = await this.page.evaluate(() => {
        const form = document.querySelector('form');
        const lt = document.querySelector('input[name="landtype"]:checked');
        const all = {};
        if (form) for (const [k, val] of new FormData(form).entries()) all[k] = String(val).slice(0, 24);
        return { landtypeChecked: lt ? lt.value : '(none)', fields: all };
      }).catch(() => ({}));
      console.log('[otp] pre-submit form:', JSON.stringify(preSubmit));
      console.log('[otp] OTP accepted; submitting parcel for the Chitta result…');
      const oldPage = this.page;
      const newPagePromise = this._waitForNewPage(5000).then((page) => ({ page }));
      const navigationPromise = oldPage.waitForNavigation({
        waitUntil: 'domcontentloaded',
        timeout: this.timeoutMs,
      }).then(() => ({ page: oldPage })).catch(() => ({ page: null }));

      await oldPage.click('input[type="submit"].button').catch(() => {});
      const completed = await Promise.race([newPagePromise, navigationPromise]);
      if (completed.page && completed.page !== oldPage) {
        this.page = completed.page;
        this._attachPage(completed.page);
        await completed.page.waitForLoadState('domcontentloaded', { timeout: this.timeoutMs }).catch(() => {});
      }

      try {
        if (this.formKind === 'aregister') {
          // A-Register's result may be an embedded PDF or a div layout, NOT a chitta
          // <table>. The OTP is already consumed, so we must NOT hard-require a table
          // (a 30s timeout here would burn the OTP). Instead wait for the page to
          // simply LEAVE the form (no #districtCode) with real content, and capture
          // whatever loaded.
          await this.page.waitForFunction(() => (
            !document.querySelector('#districtCode') && document.body && (
              document.querySelector('table') || document.querySelector('embed,object,iframe') ||
              document.body.innerText.trim().length > 40
            )
          ), { timeout: this.timeoutMs });
        } else {
          await this.page.waitForSelector('table', { timeout: this.timeoutMs });
        }
      } catch (tableError) {
        // The OTP WAS accepted (we passed the verification dialog). A missing
        // result table almost always means the parcel has no Chitta record
        // (wrong/empty survey or sub-division), or the result opened elsewhere
        // — it is NOT a bad OTP. Capture what the page actually shows so this
        // is diagnosable instead of a bare "waitForSelector timeout".
        const diag = await this._describePage().catch(() => ({}));
        console.error('[otp] OTP accepted but NO Chitta table. url=%s | title=%s | text=%s',
          diag.url, diag.title, (diag.text || '').slice(0, 400));
        if (this._looksExpired(diag.text)) {
          return { verified: false, sessionExpired: true, otpAccepted: true, diag, message: 'Government session expired while loading the result' };
        }
        const noRecord = /enter\s+valid\s+pat|no\s+record|not\s+available/i.test(diag.text || '');
        const lt = (this.formData && this.formData.landType) === 'N' ? 'Natham' : 'Rural';
        const other = lt === 'Natham' ? 'Rural' : 'Natham';
        return {
          verified: false,
          otpAccepted: true,
          diag,
          message: noRecord
            ? `OTP verified, but the government found no patta for this parcel under ${lt} land. Double-check the survey/sub-division, or switch the Land Type to ${other} and try again.`
            : `OTP accepted, but no Chitta table appeared within ${this.timeoutMs}ms. Page said: "${(diag.text || '(empty)').slice(0, 160)}"`,
        };
      }
      // Guard against a false positive. The govt FORM page also contains a (layout)
      // <table> PLUS the #districtCode dropdown, whereas a real Chitta RESULT page
      // has NO #districtCode. If Submit did not navigate (e.g. an "Enter Valid Patta"
      // validation alert that _handleDialog auto-dismissed), we are still on the form
      // and waitForSelector('table') matched the layout table — that is NOT a chitta,
      // and returning it would serve a garbage PDF as the customer's land record.
      const stillOnForm = await this.page.$('#districtCode').then(Boolean).catch(() => false);
      if (stillOnForm) {
        const diag = await this._describePage().catch(() => ({}));
        console.error('[otp] OTP accepted but submit STAYED ON THE FORM (no result). url=%s | text=%s',
          diag.url, (diag.text || '').slice(0, 300));
        if (this._looksExpired(diag.text)) {
          return { verified: false, sessionExpired: true, otpAccepted: true, diag, message: 'Government session expired before the result loaded' };
        }
        const lt = (this.formData && this.formData.landType) === 'N' ? 'Natham' : 'Rural';
        const other = lt === 'Natham' ? 'Rural' : 'Natham';
        return {
          verified: false,
          otpAccepted: true,
          diag,
          message: `OTP verified, but the government returned no patta for this parcel under ${lt} land. Double-check the survey/sub-division, or switch the Land Type to ${other} and try again.`,
        };
      }
      await this._waitForNetworkIdle(this.page);
      const html = await this.page.content(); // capture HTML FIRST (has the FMB embed src)
      // Capture the GOVERNMENT'S OWN rendered page directly as a PDF — no HTML
      // reconstruction (the old path re-rendered the extracted table in a blank
      // origin where the govt's relative CSS/resources failed to load, clipping
      // words). Best-effort: if it fails we still return html for the HTML fallback.
      let pdf = null;
      if (this.formKind === 'aregister') {
        // A-Register capture: the result may be an embedded document (fetch its bytes
        // directly — page.pdf can't capture an <embed>/<iframe> PDF) or an HTML page
        // (print it WITHOUT hiding content). Log the real DOM shape so we can perfect
        // this against the live result on the first run.
        const shape = await this.page.evaluate(() => ({
          tables: document.querySelectorAll('table').length,
          embeds: [...document.querySelectorAll('embed,object,iframe')].map((e) => e.src || e.data || '').filter(Boolean),
          textLen: document.body ? document.body.innerText.trim().length : 0,
        })).catch(() => ({}));
        console.log('[areg] result shape:', JSON.stringify(shape).slice(0, 600));
        try { pdf = await this.captureAregPdf(shape); }
        catch (e) { console.warn('[areg] result-PDF capture failed (falling back to HTML render):', e.message); }
      } else {
        try { pdf = await this.captureResultPdf(); }
        catch (e) { console.warn('[otp] direct result-PDF capture failed (falling back to HTML render):', e.message); }
      }
      this._lastSurveyKey = surveyKey(this.formData);
      this._lastArtifacts = null;
      console.log('[otp] Chitta result loaded; session ready' + (pdf ? ` (direct govt PDF ${pdf.length}b)` : ' (HTML only)'));
      return { verified: true, otpAccepted: true, message: message || 'Your OTP has been verified', html, pdf };
    } catch (error) {
      // If the OTP was already accepted, a later failure is a wasted OTP (terminal),
      // never a wrong OTP — carry otpAccepted so the caller classifies + counts it.
      return { verified: false, otpAccepted, message: error.message };
    }
  }

  /**
   * Capture the LIVE government result page directly as a PDF. Chromium prints the
   * real page with the government's own CSS + already-loaded resources, so nothing
   * is reconstructed and no words are clipped. The FMB sketch is hidden here (it is
   * merged separately as its own high-resolution PDF page), and the whole page is
   * scaled to fit A4 width so wide chitta tables are captured in full.
   */
  async captureResultPdf() {
    if (!this.page || this.page.isClosed()) throw new Error('Playwright page is closed');
    await this.page.addStyleTag({ content: `
      @page { size: A4; margin: 8mm; }
      embed, iframe, object, script, noscript { display: none !important; }
      table { border-collapse: collapse; max-width: 100%; }
      td, th { word-break: break-word; overflow-wrap: anywhere; }
      img { max-width: 100%; height: auto; }
    ` }).catch(() => {});
    const contentWidth = await this.page.evaluate(() => Math.max(
      document.body ? document.body.scrollWidth : 0,
      document.documentElement ? document.documentElement.scrollWidth : 0, 1,
    )).catch(() => 780);
    const A4_PRINTABLE_PX = 780; // ~A4 width (794px @96dpi) minus 8mm*2 margins
    const scale = Math.max(0.1, Math.min(1, A4_PRINTABLE_PX / contentWidth));
    const pdf = await this.page.pdf({ format: 'A4', printBackground: true, scale, preferCSSPageSize: true });
    return Buffer.from(pdf);
  }

  /**
   * Capture the A-Register result. Unlike the chitta path this does NOT hide
   * embeds — if the government returns the A-Register as an embedded document
   * (<embed>/<object>/<iframe>) we fetch that document's bytes DIRECTLY through the
   * verified session (page.pdf can't rasterise an embedded PDF); otherwise we print
   * the result page itself. `shape` is the pre-measured DOM (tables/embeds/textLen).
   */
  async captureAregPdf(shape) {
    if (!this.page || this.page.isClosed()) throw new Error('Playwright page is closed');
    // 1) Embedded document? Fetch its bytes in-page (same verified cookies).
    const embeds = (shape && Array.isArray(shape.embeds)) ? shape.embeds : [];
    const docSrc = embeds.find((s) => /\.pdf(\?|$)|pdf|areg|adangal|extract|report|view.*doc|getdoc/i.test(s));
    if (docSrc) {
      try {
        const abs = new URL(docSrc, this.page.url()).href;
        const b64 = await this.page.evaluate(async (u) => {
          const r = await fetch(u, { credentials: 'include' });
          if (!r.ok) return '';
          const buf = new Uint8Array(await r.arrayBuffer());
          let bin = ''; for (let i = 0; i < buf.length; i++) bin += String.fromCharCode(buf[i]);
          return btoa(bin);
        }, abs);
        if (b64 && b64.length > 200) {
          const buf = Buffer.from(b64, 'base64');
          // Only trust it if it actually looks like a PDF (magic bytes) — otherwise
          // fall through to printing the page.
          if (buf.slice(0, 5).toString('latin1') === '%PDF-') {
            console.log(`[areg] captured embedded document ${buf.length}b from ${abs.slice(0, 120)}`);
            return buf;
          }
        }
      } catch (e) { console.warn('[areg] embedded-doc fetch failed, printing page instead:', e.message); }
    }
    // 2) Otherwise print the result page — keep ALL content visible (no embed hiding).
    await this.page.addStyleTag({ content: `
      @page { size: A4; margin: 8mm; }
      script, noscript { display: none !important; }
      table { border-collapse: collapse; max-width: 100%; }
      td, th { word-break: break-word; overflow-wrap: anywhere; }
      img, embed, object, iframe { max-width: 100%; }
    ` }).catch(() => {});
    const contentWidth = await this.page.evaluate(() => Math.max(
      document.body ? document.body.scrollWidth : 0,
      document.documentElement ? document.documentElement.scrollWidth : 0, 1,
    )).catch(() => 780);
    const scale = Math.max(0.1, Math.min(1, 780 / contentWidth));
    const pdf = await this.page.pdf({ format: 'A4', printBackground: true, scale, preferCSSPageSize: true });
    return Buffer.from(pdf);
  }

  /**
   * Does this dialog/page text look like an EXPIRED or INVALID government session
   * (as opposed to a wrong OTP or a missing record)? These fail because the page
   * sat too long — the recovery is a fresh start, not a retype, so callers surface
   * a distinct SESSION_EXPIRED signal instead of a bare "invalid page".
   */
  _looksExpired(text) {
    return /invalid\s*access|session\s*(?:has\s*)?expired|session\s*time\s*?out|please\s*re-?login|not\s*a\s*valid\s*session/i
      .test(String(text || ''));
  }

  /** Snapshot the current page (url/title/visible text) for diagnostics. */
  async _describePage() {
    const page = this.page;
    if (!page || page.isClosed()) return { url: '(closed)', title: '', text: '' };
    const url = (() => { try { return page.url(); } catch (e) { return ''; } })();
    const title = await page.title().catch(() => '');
    const text = await page
      .evaluate(() => (document.body ? document.body.innerText.replace(/\s+/g, ' ').trim() : ''))
      .catch(() => '');
    return { url, title, text };
  }

  async getChittaHtml() {
    if (!this.page || this.page.isClosed()) throw new Error('Playwright page is closed');
    await this.page.waitForSelector('table', { timeout: this.timeoutMs });
    return this.page.content();
  }

  /** Stable, public introspection used by the session pool + refresher. */
  hasVerifiedForm() {
    return !!(this._verifiedSubmission && this._verifiedSubmission.fields && this._verifiedSubmission.fields.ajax_rno);
  }

  /**
   * True only while the live browser tab is open AND still holds the verified
   * form token. The pool borrows a session ONLY when this is true — a tab whose
   * browser died (machine restart / crash) reports false and is retired, never
   * handed to a borrow (which would otherwise hang trying to use a dead page).
   */
  isHealthy() {
    try {
      return !!(this.page && !this.page.isClosed() && this.hasVerifiedForm());
    } catch (error) {
      return false;
    }
  }

  /**
   * Serialize the authenticated state (government cookies + the captured
   * verified form token) so the session can be rebuilt after a machine restart
   * WITHOUT a new OTP. Returns null if there is no verified form to persist.
   */
  async exportState() {
    if (!this.hasVerifiedForm()) return null;
    let storageState = null;
    let sessionStorage = null;
    let origin = 'https://eservices.tn.gov.in';
    try {
      // FULL storage state = cookies (incl. httpOnly JSESSIONID) + per-origin
      // localStorage + IndexedDB — not just cookies (the old bug).
      storageState = this.context ? await this.context.storageState() : null;
    } catch (error) {}
    try {
      // sessionStorage is tab-specific and NOT captured by storageState — grab it
      // from the live page so the restore can replay it via an init script.
      if (this.page && !this.page.isClosed()) {
        sessionStorage = await this.page.evaluate(() => JSON.stringify(window.sessionStorage || {})).catch(() => null);
        origin = await this.page.evaluate(() => location.origin).catch(() => origin);
      }
    } catch (error) {}
    return {
      backend: 'playwright',
      storageState, sessionStorage, origin,
      verifiedSubmission: this._verifiedSubmission,
      formData: this.formData,
    };
  }

  /**
   * Rebuild a live browser from persisted state (see exportState): launch
   * Chromium with the FULL storageState (cookies incl. JSESSIONID + localStorage),
   * replay sessionStorage, then walk the PROPER access chain (index → View Patta
   * → form) so the government mints a fresh `rno` bound to the restored JSESSIONID.
   * The old restore jumped straight to chittaExtract with cookies-only → "INVALID
   * ACCESS". Caller must VALIDATE (a real fetch) — a server-side-expired session
   * still restores cosmetically but fetches will fail.
   */
  async restoreFrom(state) {
    if (this.browser) return this;
    if (!state) throw new Error('No persisted state to restore');
    this.browser = await launchBrowser({ headless: this.headless });
    const opts = { ignoreHTTPSErrors: true };
    if (state.storageState) opts.storageState = state.storageState;
    this.context = await this.browser.newContext(opts);
    // Back-compat: older rows stored bare cookies, not a storageState.
    if (!state.storageState && Array.isArray(state.cookies) && state.cookies.length) {
      await this.context.addCookies(state.cookies).catch(() => {});
    }
    if (state.sessionStorage && state.origin) {
      await this.context.addInitScript(({ json, origin }) => {
        try {
          if (location.origin !== origin) return;
          const s = JSON.parse(json);
          for (const k of Object.keys(s)) window.sessionStorage.setItem(k, s[k]);
        } catch (e) {}
      }, { json: state.sessionStorage, origin: state.origin }).catch(() => {});
    }
    this.page = await this.context.newPage();
    this._attachPage(this.page);
    this._verifiedSubmission = state.verifiedSubmission || null;
    this.formData = state.formData || this.formData;
    // Walk index → View Patta → form WITH the restored JSESSIONID so the govt
    // re-recognises the verified session and mints a fresh rno on the form page.
    await this._openForm();
    this._restored = true;
    return this;
  }

  /**
   * Register a callback that fires for every dialog the browser surfaces.
   * Used by the stable refresher to catch TNSERVICES
   * "session expired" dialogs without a dedicated event.
   */
  onDialog(handler) {
    if (typeof handler !== 'function') return;
    this.on('dialog_message', handler);
  }

  /**
   * Re-walk the form on the current Playwright tab to refresh the
   * captured verified form tokens. TNSERVICES rotates ajax_rno /
   * chkrno periodically; the operator can trigger this from
   * `POST /api/patta/refresh/:sessionId` and the auto-refresher uses
   * it after a "session expired" dialog.
   */
  async refreshVerifiedForm() {
    if (!this._verifiedSubmission) return false;
    if (!this.page || this.page.isClosed()) return false;
    try {
      // The form page is still loaded; re-submitting it returns a fresh
      // ajax_rno that the Playwright session captures automatically.
      const form = this._verifiedSubmission.fields;
      const action = this._verifiedSubmission.action;
      const referrer = this._verifiedSubmission.referrer;
      const response = await this.page.evaluate(async ({ action, referrer, fields, timeoutMs }) => {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        try {
          const result = await fetch(action, {
            method: 'POST',
            credentials: 'include',
            referrer,
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams(fields).toString(),
            signal: controller.signal,
          });
          return { status: result.status, html: await result.text() };
        } finally {
          clearTimeout(timer);
        }
      }, { action, referrer, fields: form, timeoutMs: this.timeoutMs });

      if (response.status < 200 || response.status >= 300) return false;
      if (/id=["']districtCode["']/i.test(response.html)) return false;

      // Pull the freshly-issued tokens from the response body.
      const refreshed = await this.page.evaluate((html) => {
        const doc = new DOMParser().parseFromString(html, 'text/html');
        const ajax = doc.querySelector('input[name="ajax_rno"]');
        const chk = doc.querySelector('input[name="chkrno"]');
        return {
          ajax_rno: ajax ? ajax.value : null,
          chkrno: chk ? chk.value : null,
        };
      }, response.html);

      if (!refreshed.ajax_rno) return false;
      this._verifiedSubmission.fields.ajax_rno = refreshed.ajax_rno;
      if (refreshed.chkrno) this._verifiedSubmission.fields.chkrno = refreshed.chkrno;
      this._lastArtifacts = null;
      return true;
    } catch (error) {
      return false;
    }
  }

  /**
   * GET the chitta form in the verified cookie jar and read the freshly-issued
   * single-use chkrno + rotating ajax_rno. Returns null on any failure (the
   * caller falls back to the last-known token). Same-origin fetch from the live
   * tab, so it reuses the verified JSESSIONID.
   */
  async _mintFreshTokens() {
    if (!this._verifiedSubmission || !this.page || this.page.isClosed()) return null;
    const action = this._verifiedSubmission.action;
    const t0 = Date.now();
    try {
      const out = await this.page.evaluate(async ({ url, timeoutMs }) => {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        try {
          const r = await fetch(url, {
            method: 'GET', credentials: 'include',
            headers: { 'X-Requested-With': 'XMLHttpRequest' }, signal: controller.signal,
          });
          const html = await r.text();
          const doc = new DOMParser().parseFromString(html, 'text/html');
          const g = (n) => { const e = doc.querySelector('input[name="' + n + '"]'); return e ? e.value : null; };
          return { status: r.status, chkrno: g('chkrno'), ajax_rno: g('ajax_rno') };
        } finally { clearTimeout(timer); }
      }, { url: action, timeoutMs: Math.min(this.timeoutMs, 12000) });
      console.log('[borrow] mintFreshTokens', Date.now() - t0, 'ms | status', out && out.status,
        '| chkrno', out && out.chkrno ? 'yes' : 'no', '| ajax_rno', out && out.ajax_rno ? 'yes' : 'no');
      return out;
    } catch (error) {
      console.warn('[borrow] mintFreshTokens failed after', Date.now() - t0, 'ms:', error.message);
      return null;
    }
  }

  /**
   * Fetch the requested parcel with the OTP-verified form token from inside
   * Chromium. This is what makes a pooled browser safe for arbitrary requests
   * instead of returning the parcel that happened to be used during OTP.
   */
  async fetchChittaArtifacts(survey) {
    if (!survey) throw new Error('Survey details are required');
    const normalized = normalizeSurvey(survey, this.formData);
    const key = surveyKey(normalized);
    console.log('[borrow] fetchChittaArtifacts want=%s | verified=%s | cached=%s',
      key, surveyKey(this.formData), key === this._lastSurveyKey && !!this._lastArtifacts);
    if (key === this._lastSurveyKey && this._lastArtifacts) return this._lastArtifacts;

    if (key === surveyKey(this.formData) && !this._lastArtifacts) {
      console.log('[borrow] same parcel as verified — reading current result page');
      const artifacts = await this.getChittaArtifacts();
      this._lastSurveyKey = key;
      this._lastArtifacts = artifacts;
      return artifacts;
    }
    if (!this._verifiedSubmission) throw new Error('Playwright session has no verified form token');
    if (!this.page || this.page.isClosed()) throw new Error('Playwright page is closed');

    const originalFields = this._verifiedSubmission.fields;
    const originalTaluk = String(originalFields.talukCode || '');
    const originalCode = String(this.formData && this.formData.talukCode || '').split('/')[0];
    const suffix = originalTaluk.startsWith(`${originalCode}/`)
      ? originalTaluk.slice(originalCode.length)
      : `/${normalized.nflag}`;
    const talukCode = normalized.talukCode.includes('/')
      ? normalized.talukCode
      : `${normalized.talukCode}${suffix}`;

    // Mint FRESH single-use tokens before the POST. chkrno is SINGLE-USE and
    // ajax_rno rotates per submit; the government consumes the OTP-time token on
    // the very first Submit, so reusing it returns INVALID ACCESS / the blank
    // form — which is why a pooled session used to serve only ONE borrow. A fresh
    // GET of the form in the verified cookie jar issues new tokens (mirrors the
    // proven tns-client.fetchChitta path).
    const fresh = await this._mintFreshTokens();
    const chkrno = (fresh && fresh.chkrno) || originalFields.chkrno;
    const ajaxRno = (fresh && fresh.ajax_rno) || originalFields.ajax_rno;
    if (fresh && fresh.ajax_rno) {
      this._verifiedSubmission.fields.ajax_rno = fresh.ajax_rno;
      if (fresh.chkrno) this._verifiedSubmission.fields.chkrno = fresh.chkrno;
    }

    const fields = {
      ...originalFields,
      chkrno,
      ajax_rno: ajaxRno,
      searchpattano: 'no',
      districtCode: normalized.districtCode,
      talukCode,
      villageCode: normalized.villageCode,
      viewOpt: 'sur',
      landtype: normalized.landType,
      pattaNo: '',
      surveyNo: normalized.surveyNo,
      subdivNo: normalized.subdivNo,
      mobileno: originalFields.mobileno || this.formData.mobile,
      otpno: originalFields.otpno,
      mobileno_ver: originalFields.mobileno_ver || originalFields.mobileno || this.formData.mobile,
      otpno_ver: originalFields.otpno_ver || originalFields.otpno,
    };

    const tPost = Date.now();
    const response = await this.page.evaluate(async ({ action, referrer, fields, timeoutMs }) => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const result = await fetch(action, {
          method: 'POST',
          credentials: 'include',
          referrer,
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams(fields).toString(),
          signal: controller.signal,
        });
        return { status: result.status, html: await result.text(), url: result.url || action };
      } finally {
        clearTimeout(timer);
      }
    }, {
      action: this._verifiedSubmission.action,
      referrer: this._verifiedSubmission.referrer,
      fields,
      timeoutMs: Math.min(this.timeoutMs, 20000),
    });
    console.log('[borrow] chitta POST', Date.now() - tPost, 'ms | status', response.status,
      '| size', (response.html || '').length,
      '| isForm', /id=["']districtCode["']/i.test(response.html || ''),
      '| invalidAccess', /INVALID\s+ACCESS/i.test(response.html || ''));

    const rawFailed = response.status < 200 || response.status >= 300
      || !response.html || /INVALID\s+ACCESS/i.test(response.html)
      || /id=["']districtCode["']/i.test(response.html);
    if (rawFailed) {
      // The raw fetch can't obtain a valid chkrno (the JS never sets it — the
      // SERVER renders it into the form only on a real navigation, and it's
      // single-use). Fall back to a real browser navigation: re-load the form
      // (server issues a fresh chkrno), fill the parcel, echo the verified
      // mobile/OTP, and submit through the browser. Slower but it's the only path
      // that yields valid tokens for a different parcel on a shared session.
      console.log('[borrow] raw POST returned the form/INVALID — falling back to browser navigation');
      const artifacts = await this._fetchParcelViaForm(normalized);
      this.formData = { ...normalized, mobile: this.formData.mobile };
      this._lastSurveyKey = key;
      this._lastArtifacts = artifacts;
      return artifacts;
    }

    const artifacts = await this._renderHtmlArtifacts(response.html, response.url);
    this.formData = { ...normalized, mobile: this.formData.mobile };
    this._lastSurveyKey = key;
    this._lastArtifacts = artifacts;
    return artifacts;
  }

  /**
   * Fetch a DIFFERENT parcel on the live verified tab via a real browser form
   * flow. Re-navigating the form makes the government SERVER render a fresh,
   * valid chkrno (the JS never sets it, and a raw fetch gets the "null"
   * placeholder). The verified session cookie + echoed mobileno_ver/otpno_ver
   * authorise the submit without a new OTP.
   */
  async _fetchParcelViaForm(normalized) {
    if (!this.page || this.page.isClosed()) throw new Error('Playwright page is closed');
    const t0 = Date.now();
    const url = this.accessConfig.extractUrl;
    await this.page.goto(url, { waitUntil: 'domcontentloaded', timeout: this.timeoutMs });
    await this.page.waitForSelector('#districtCode', { timeout: this.timeoutMs });
    await this._waitForNetworkIdle(this.page);

    await this.fillParcel({
      districtCode: normalized.districtCode, talukCode: normalized.talukCode,
      villageCode: normalized.villageCode, surveyNo: normalized.surveyNo,
      subdivNo: normalized.subDivNo || normalized.subdivNo,
      landType: normalized.landType, nflag: normalized.nflag,
    });

    // Echo the verified mobile/OTP into the *_ver fields (o_key = otpno_ver) so
    // the submit is authorised by the already-verified session.
    const vf = (this._verifiedSubmission && this._verifiedSubmission.fields) || {};
    const m = vf.mobileno_ver || vf.mobileno || this.formData.mobile;
    const o = vf.otpno_ver || vf.otpno || '';
    await this.page.evaluate(({ m, o }) => {
      const set = (sel, v) => { const e = document.querySelector(sel); if (e && v != null) e.value = v; };
      set('#mobileno', m); set('#otpno', o);
      set('input[name="mobileno_ver"]', m); set('input[name="otpno_ver"]', o);
    }, { m, o }).catch(() => {});

    const chk = await this.page.$eval('input[name="chkrno"]', (e) => (e.value || '').slice(0, 10)).catch(() => '(none)');
    console.log('[borrow] via-form: chkrno', chk, '| submitting…');

    const oldPage = this.page;
    const newPagePromise = this._waitForNewPage(5000).then((page) => ({ page }));
    const navPromise = oldPage.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: this.timeoutMs })
      .then(() => ({ page: oldPage })).catch(() => ({ page: null }));
    await oldPage.click('input[type="submit"].button').catch(() => {});
    const done = await Promise.race([newPagePromise, navPromise]);
    if (done.page && done.page !== oldPage) {
      this.page = done.page;
      this._attachPage(done.page);
      await done.page.waitForLoadState('domcontentloaded', { timeout: this.timeoutMs }).catch(() => {});
    }
    await this.page.waitForSelector('table', { timeout: this.timeoutMs });
    console.log('[borrow] via-form: chitta table loaded in', Date.now() - t0, 'ms');
    return this._renderHtmlArtifacts(await this.page.content(), this.page.url());
  }

  /**
   * Extract the table, all readable CSS, the FMB embed URL, and a real A4 PDF
   * rendered by Chromium. A separate page is used so the live result page is
   * not destroyed by setContent().
   */
  async getChittaArtifacts() {
    if (!this.page || this.page.isClosed()) throw new Error('Playwright page is closed');
    await this.page.waitForSelector('table', { timeout: this.timeoutMs });
    await this._waitForNetworkIdle(this.page);

    const extracted = await this.page.evaluate(() => {
      const table = document.querySelector('table');
      if (!table) throw new Error('Chitta table not found');

      let css = '';
      for (const sheet of Array.from(document.styleSheets || [])) {
        try {
          for (const rule of Array.from(sheet.cssRules || [])) css += `${rule.cssText}\n`;
        } catch (error) {
          // Browser security blocks cssRules for some cross-origin stylesheets.
        }
      }

      const embed = document.querySelector('embed[src]');
      let fmbSketchUrl = null;
      if (embed) {
        try { fmbSketchUrl = new URL(embed.getAttribute('src'), document.baseURI).href; } catch (error) {}
      }

      return {
        tableHtml: table.outerHTML,
        css,
        fmbSketchUrl,
        baseUrl: document.baseURI,
      };
    });

    const html = await this.page.content();
    const renderPage = this.context.newPage
      ? await this.context.newPage()
      : await this.context.new_page();
    try {
      const minimalHtml = `<!doctype html>
<html><head><meta charset="utf-8"><base href="${escapeHtmlAttribute(extracted.baseUrl)}">
<style>${extracted.css}
@page { size: A4; margin: 10mm; }
html, body { margin: 0; padding: 0; }
@media print { body { zoom: 0.6; } }
</style></head><body>${extracted.tableHtml}</body></html>`;
      await renderPage.setContent(minimalHtml, { waitUntil: 'load', timeout: this.timeoutMs });
      await renderPage.emulateMedia({ media: 'screen' });
      const chittaPdf = await renderPage.pdf({ format: 'A4', printBackground: true });
      return {
        html,
        tableHtml: extracted.tableHtml,
        css: extracted.css,
        fmbSketchUrl: extracted.fmbSketchUrl,
        chittaPdf: Buffer.from(chittaPdf),
      };
    } finally {
      await renderPage.close().catch(() => {});
    }
  }

  async _renderHtmlArtifacts(html, baseUrl) {
    const renderPage = this.context.newPage
      ? await this.context.newPage()
      : await this.context.new_page();
    try {
      const base = `<base href="${escapeHtmlAttribute(baseUrl)}">`;
      const source = /<head[^>]*>/i.test(html)
        ? html.replace(/<head([^>]*)>/i, `<head$1>${base}`)
        : `<!doctype html><html><head>${base}</head><body>${html}</body></html>`;
      await renderPage.setContent(source, { waitUntil: 'load', timeout: this.timeoutMs });
      await renderPage.waitForSelector('table', { timeout: this.timeoutMs });

      const extracted = await renderPage.evaluate(() => {
        const table = document.querySelector('table');
        let css = '';
        for (const sheet of Array.from(document.styleSheets || [])) {
          try {
            for (const rule of Array.from(sheet.cssRules || [])) css += `${rule.cssText}\n`;
          } catch (error) {}
        }
        const embed = document.querySelector('embed[src]');
        let fmbSketchUrl = null;
        if (embed) {
          try { fmbSketchUrl = new URL(embed.getAttribute('src'), document.baseURI).href; } catch (error) {}
        }
        return { tableHtml: table.outerHTML, css, fmbSketchUrl, baseUrl: document.baseURI };
      });

      const minimalHtml = `<!doctype html>
<html><head><meta charset="utf-8"><base href="${escapeHtmlAttribute(extracted.baseUrl)}">
<style>${extracted.css}
@page { size: A4; margin: 10mm; }
html, body { margin: 0; padding: 0; }
@media print { body { zoom: 0.6; } }
</style></head><body>${extracted.tableHtml}</body></html>`;
      await renderPage.setContent(minimalHtml, { waitUntil: 'load', timeout: this.timeoutMs });
      await renderPage.emulateMedia({ media: 'screen' });
      const chittaPdf = await renderPage.pdf({ format: 'A4', printBackground: true });
      return {
        html,
        tableHtml: extracted.tableHtml,
        css: extracted.css,
        fmbSketchUrl: extracted.fmbSketchUrl,
        chittaPdf: Buffer.from(chittaPdf),
      };
    } finally {
      await renderPage.close().catch(() => {});
    }
  }

  isHealthy() {
    return !!(
      this.browser && this.browser.isConnected() &&
      this.page && !this.page.isClosed() &&
      !this._closed
    );
  }

  async close() {
    if (this._closed) return;
    this._closed = true;
    this.stopKeepAlive();
    for (const waiter of this._dialogWaiters) waiter(null);
    this._dialogWaiters.clear();
    try { if (this.context) await this.context.close(); } catch (error) {}
    try { if (this.browser) await this.browser.close(); } catch (error) {}
    this.page = null;
    this.context = null;
    this.browser = null;
  }
}

function normalizeSurvey(survey, fallback = {}) {
  const normalized = {
    districtCode: String(survey.districtCode || survey.district || ''),
    talukCode: String(survey.talukCode || survey.taluk || ''),
    villageCode: String(survey.villageCode || survey.village || ''),
    surveyNo: String(survey.surveyNo || survey.survey || ''),
    subdivNo: String(survey.subdivNo || survey.subDivNo || survey.sub || ''),
    landType: String(survey.landType || fallback.landType || 'R'),
    nflag: String(survey.nflag || fallback.nflag || 'Y'),
  };
  for (const [name, value] of Object.entries(normalized)) {
    if (!value) throw new Error(`Missing ${name}`);
  }
  return normalized;
}

function surveyKey(survey) {
  if (!survey) return null;
  try {
    const value = normalizeSurvey(survey, survey);
    return [value.districtCode, value.talukCode.split('/')[0], value.villageCode,
      value.surveyNo, value.subdivNo, value.landType].join('|');
  } catch (error) {
    return null;
  }
}

function escapeHtmlAttribute(value) {
  return String(value || '')
    .replace(/&/g, '\x26amp;')
    .replace(/"/g, '\x26quot;')
    .replace(/</g, '\x26lt;')
    .replace(/>/g, '\x26gt;');
}

module.exports = { PlaywrightSession, TNSERVICES_HOME, TNSERVICES_FORM };
