'use strict';

/**
 * MPQR OTP Service — the government OTP → fetch → PDF flow, and NOTHING else.
 *
 * This replaced the old "session pool": there is no borrowing, no Postgres
 * persistence, no S3/cache. It is a pure REST-API backend — send the OTP to the
 * customer's own mobile, verify the OTP the app read back, capture the chitta as
 * the government's own PDF, and return it. One browser per verification, closed
 * as soon as it has served its purpose.
 */

const crypto = require('crypto');
const { E, classify } = require('./errors');
const metrics = require('./metrics');

class OtpService {
  constructor(opts = {}) {
    this._pending = {};  // pendingId -> { mobile, playwrightSession, opts, createdAt }
    this._warm = {};     // warmId   -> { session, parcel, ready, error } (interactive prewarm)
    this._warmPool = []; // STANDING pool of pre-launched browsers sitting at the blank form
    this._warming = 0;
    this.opts = {
      playwrightHeadless: opts.playwrightHeadless,
      playwrightTimeoutMs: opts.playwrightTimeoutMs,
      // 'patta' (default) or 'aregister' — passed to every PlaywrightSession this
      // service launches so the whole warm pool drives the right government form.
      formKind: opts.formKind === 'aregister' ? 'aregister' : 'patta',
      maxWarmSessions: opts.maxWarmSessions
        || parseInt(process.env.MPQR_MAX_WARM_SESSIONS || '4', 10),
    };
    // How many browsers to keep pre-launched + navigated to the govt form so
    // "Send OTP" skips the ~5-15s cold launch. Keep <= MPQR_MAX_CONCURRENT_BROWSERS
    // minus the peak concurrent verifications, or launches queue.
    this._warmPoolSize = parseInt(process.env.MPQR_WARM_POOL_SIZE || '2', 10);
    this._warmMaxAgeMs = 3 * 60 * 1000; // govt form/token freshness window
    // Recycle a warm browser well before its govt session can go stale, so a
    // Send-OTP almost always grabs a FRESH one (< MPQR_WARM_FRESH_MS) and sends in
    // ~2s without needing a re-navigation.
    this._warmRelaunchAgeMs = Math.min(this._warmMaxAgeMs - 20000, parseInt(process.env.MPQR_WARM_RELAUNCH_MS || '90000', 10));
    this._lastGovtSuccessAt = null; // last time the govt accepted a send or verify
    this._inflightVerifies = 0;     // completeVerification calls in progress
    // Reap expired pendings + orphaned prewarms; keep the standing pool topped up.
    // A short tick (default 20s) replaces aged/dead warm entries before a request
    // arrives, instead of leaving the pool empty up to a full minute.
    const tickMs = Math.max(5000, parseInt(process.env.MPQR_POOL_TICK_MS || '20000', 10));
    this._timer = setInterval(() => {
      this._prunePending(); this._pruneWarm(); this._ensureWarmPool();
    }, tickMs);
    if (this._timer.unref) this._timer.unref();
    this._ensureWarmPool(); // pre-launch at boot so the very first OTP is fast
  }

  /**
   * Begin a customer-OTP verification: send the OTP to TNSERVICES via a live
   * Playwright tab and park the half-verified browser under `_pending[pendingId]`
   * until `completeVerification` is called.
   */
  async beginVerification(mobile, opts = {}) {
    mobile = String(mobile || '').trim();
    if (!/^[6-9]\d{9}$/.test(mobile) || /^(\d)\1{9}$/.test(mobile)) {
      throw E.INVALID_INPUT('Invalid mobile number');
    }
    this._prunePending();
    // A customer who left and came back re-starts — they must NOT be handed their
    // own earlier, now server-side-expired session (that's the "invalid page"). Drop
    // any pending for this mobile so this start mints a fresh, live one.
    this._evictPendingByMobile(mobile);

    const { PlaywrightSession } = require('./playwright-session');
    const parcel = {
      districtCode: opts.districtCode || opts.district || '17',
      talukCode: opts.talukCode || opts.taluk || '01',
      villageCode: opts.villageCode || opts.village || '092',
      surveyNo: opts.surveyNo || opts.survey || '1',
      subdivNo: opts.subdivNo || opts.subDivNo || opts.sub || '1A',
      landType: opts.landType || 'R',
      nflag: opts.nflag || 'Y',
    };
    // Reject a malformed parcel BEFORE spending a warm browser + the AJAX cascade.
    this._validateParcel(parcel);

    // Prefer the pre-warmed tab (browser already launched + navigated to the form
    // in the background). Fill + send then happen in ONE pass at send time.
    let playwrightSession = null;
    let warmHit = false;
    const warm = opts.warmId && this._warm && this._warm[opts.warmId];
    if (warm) {
      delete this._warm[opts.warmId];
      try {
        const deadline = Date.now() + (this.opts.playwrightTimeoutMs || 60000);
        while (!warm.ready && !warm.error && Date.now() < deadline) {
          await new Promise((r) => setTimeout(r, 150));
        }
        if (warm.error || !warm.ready || !warm.session) throw new Error(warm.error || 'prewarm not ready');
        playwrightSession = warm.session;
        warmHit = true;
        console.log('[otp] using pre-warmed (navigated) tab', opts.warmId);
      } catch (e) {
        console.warn('[otp] prewarm unusable, cold path:', e.message);
        try { if (warm.session) await warm.session.close(); } catch (_) {}
        playwrightSession = null;
      }
    }
    if (!playwrightSession) {
      // Grab a STANDING warm browser (already launched + at the blank govt form).
      // This is what makes the OTP send fast; fillLocation happens inside sendOtp.
      playwrightSession = this._takeWarm();
      if (playwrightSession) { warmHit = true; console.log('[otp] using standing warm-pool browser'); }
    }
    if (!playwrightSession) {
      metrics.coldLaunch.inc();
      playwrightSession = new PlaywrightSession({
        headless: this.opts.playwrightHeadless, timeoutMs: this.opts.playwrightTimeoutMs, formKind: this.opts.formKind,
      });
      try {
        await playwrightSession.start();
      } catch (e) {
        try { await playwrightSession.close(); } catch (_) {}
        throw e;
      }
    }
    this._ensureWarmPool(); // replenish the pool in the background

    // About to actively drive the tab — make sure no keep-alive ping is mid-flight
    // (a warm-pool browser may have had one running when we grabbed it).
    try { await playwrightSession.quiesceKeepAlive(); } catch (_) {}

    // A warm browser's govt session goes STALE if it sat parked too long (the page
    // expires; keep-alive is off). Re-navigate FRESH from the govt home page ONLY
    // when it's actually stale — a fresh one (just launched/refreshed) sends in ~2s,
    // so we don't re-navigate needlessly and slow every OTP down. Cold browsers just
    // navigated in start(). On refresh failure, fall back to a cold launch.
    const freshMs = parseInt(process.env.MPQR_WARM_FRESH_MS || '60000', 10);
    const ageMs = Date.now() - (playwrightSession._navigatedAt || 0);
    if (warmHit && ageMs > freshMs) {
      console.log(`[otp] warm session ${Math.round(ageMs / 1000)}s old — refreshing from home`);
      try {
        await playwrightSession.refreshSession();
      } catch (e) {
        console.warn('[otp] warm-session refresh failed — cold-launching a fresh browser:', e.message);
        try { await playwrightSession.close(); } catch (_) {}
        metrics.coldLaunch.inc();
        playwrightSession = new PlaywrightSession({
          headless: this.opts.playwrightHeadless, timeoutMs: this.opts.playwrightTimeoutMs, formKind: this.opts.formKind,
        });
        await playwrightSession.start();
      }
    }

    try {
      const dialogText = await playwrightSession.sendOtp({ ...parcel, mobile });
      // sendOtp returns null ONLY when the govt actually revealed the OTP box. ANY
      // dialog text means the send FAILED (rate-limit, "maximum attempts", etc.).
      if (dialogText) {
        await playwrightSession.close();
        // A "maximum attempts / limit" dialog is RATE_LIMITED (429, non-retryable);
        // anything else is a send failure. classify() picks the right code.
        const cls = classify(new Error(dialogText));
        throw cls.code === 'INTERNAL'
          ? E.OTP_SEND_FAILED(`The government site did not send the OTP: ${dialogText}`)
          : cls;
      }
      const pendingId = crypto.randomBytes(8).toString('hex');
      this._pending[pendingId] = { mobile, playwrightSession, opts, createdAt: Date.now() };
      // Keep the govt session alive while the customer is away reading the SMS, so
      // the page never idles out into an "INVALID ACCESS" page before they verify.
      try { playwrightSession.startKeepAlive(); } catch (_) {}
      metrics.otpSent.inc({ warm: warmHit ? 'true' : 'false' });
      this._lastGovtSuccessAt = Date.now();
      return { pendingId, message: `OTP sent to ${this._maskMobile(mobile)}`, ttlSeconds: 300 };
    } catch (error) {
      try { await playwrightSession.close(); } catch (e) {}
      throw error;
    }
  }

  /** Reject a malformed parcel before spending a browser (lenient shapes, not whitelists). */
  _validateParcel(p) {
    if (!/^\d{1,6}$/.test(String(p.surveyNo == null ? '' : p.surveyNo).trim())) {
      throw E.INVALID_INPUT(`Invalid survey number "${p.surveyNo}"`);
    }
    if (!/^[0-9A-Za-z]{1,8}$/.test(String(p.subdivNo == null ? '' : p.subdivNo).trim())) {
      throw E.INVALID_INPUT(`Invalid sub-division "${p.subdivNo}"`);
    }
  }

  /**
   * Pre-warm a tab in the BACKGROUND: launch Chromium, navigate the form, and
   * fill the LOCATION cascade — so "Send OTP" is just the #sendtpid click.
   */
  async prewarm(parcel = {}) {
    this._pruneWarm();
    this._warm = this._warm || {};
    const cap = this.opts.maxWarmSessions || 4;
    while (Object.keys(this._warm).length >= cap) {
      const oldestId = Object.keys(this._warm)
        .sort((a, b) => (this._warm[a].createdAt || 0) - (this._warm[b].createdAt || 0))[0];
      const victim = this._warm[oldestId];
      delete this._warm[oldestId];
      if (victim && victim.session && typeof victim.session.close === 'function') {
        victim.session.close().catch(() => {});
      }
    }
    const { PlaywrightSession } = require('./playwright-session');
    const ps = new PlaywrightSession({
      headless: this.opts.playwrightHeadless, timeoutMs: this.opts.playwrightTimeoutMs, formKind: this.opts.formKind,
    });
    const warmId = crypto.randomBytes(8).toString('hex');
    const entry = { session: ps, parcel, createdAt: Date.now(), ready: false, error: null };
    this._warm[warmId] = entry;
    (async () => {
      try {
        await ps.start();
        if (parcel.districtCode && parcel.talukCode && parcel.villageCode) {
          await ps.fillLocation({
            districtCode: parcel.districtCode, talukCode: parcel.talukCode,
            villageCode: parcel.villageCode, landType: parcel.landType || 'R',
            nflag: parcel.nflag || 'Y',
          });
        }
        entry.ready = true;
        console.log('[prewarm]', warmId, 'ready (location filled)');
      } catch (e) {
        entry.error = e.message;
        console.error('[prewarm]', warmId, 'failed:', e.message);
        try { await ps.close(); } catch (_) {}
      }
    })();
    return { warmId };
  }

  _pruneWarm() {
    if (!this._warm) return;
    const now = Date.now();
    for (const [id, w] of Object.entries(this._warm)) {
      if (w.error || now - w.createdAt > 5 * 60 * 1000) {
        if (w.session) Promise.resolve(w.session.close()).catch(() => {});
        delete this._warm[id];
      }
    }
  }

  /** Take a fresh, still-alive browser from the standing warm pool (or null). */
  _takeWarm() {
    const now = Date.now();
    while (this._warmPool.length) {
      const w = this._warmPool.shift();
      const alive = w && w.session && w.session.page && !w.session.page.isClosed();
      // Fresh = young enough AND its last keep-alive touch did not fail. A browser
      // whose keep-alive started returning non-2xx has a dead govt session — using
      // it would send the OTP into an "INVALID ACCESS" void, so discard it.
      const fresh = alive && now - w.at < this._warmMaxAgeMs
        && !(typeof w.session.keepAliveFailed === 'function' && w.session.keepAliveFailed());
      if (fresh) {
        // About to be actively driven (fillLocation + sendOtp) — stop the periodic
        // ping so it can't race the send. It is re-armed when parked as pending.
        try { w.session.stopKeepAlive(); } catch (_) {}
        return w.session;
      }
      if (w && w.session) w.session.close().catch(() => {}); // stale/dead → discard
    }
    return null;
  }

  /** Close and forget any pending verification held for this mobile. */
  _evictPendingByMobile(mobile) {
    for (const [id, p] of Object.entries(this._pending)) {
      if (p && p.mobile === mobile) {
        delete this._pending[id];
        if (p.playwrightSession && typeof p.playwrightSession.close === 'function') {
          Promise.resolve(p.playwrightSession.close()).catch(() => {});
        }
      }
    }
  }

  /** Keep the standing warm pool topped up; reap stale/dead entries. Non-blocking. */
  _ensureWarmPool() {
    const now = Date.now();
    this._warmPool = this._warmPool.filter((w) => {
      const dead = !w.session || !w.session.page || w.session.page.isClosed()
        || (typeof w.session.keepAliveFailed === 'function' && w.session.keepAliveFailed());
      // Recycle BEFORE the token window closes so a Send-OTP never grabs a
      // near-expired browser (self-healing).
      if (dead || now - w.at > this._warmRelaunchAgeMs) {
        if (w.session) w.session.close().catch(() => {});
        return false;
      }
      return true;
    });
    const need = this._warmPoolSize - this._warmPool.length - this._warming;
    for (let i = 0; i < need; i++) {
      this._warming += 1;
      const { PlaywrightSession } = require('./playwright-session');
      const ps = new PlaywrightSession({
        headless: this.opts.playwrightHeadless, timeoutMs: this.opts.playwrightTimeoutMs, formKind: this.opts.formKind,
      });
      ps.start()
        .then(() => {
          this._warmPool.push({ session: ps, at: Date.now() });
          // Keep this parked browser's govt session alive so it is still valid
          // whenever a customer's Send-OTP grabs it (up to the relaunch age).
          try { ps.startKeepAlive(); } catch (_) {}
          // Crash → drop from the pool and immediately refill, rather than waiting
          // for the next tick to notice a dead browser (self-healing).
          try {
            const b = ps.browser;
            if (b && typeof b.on === 'function') {
              b.on('disconnected', () => {
                this._warmPool = this._warmPool.filter((x) => x.session !== ps);
                this._ensureWarmPool();
              });
            }
          } catch (_) {}
          console.log(`[warm] pool ready ${this._warmPool.length}/${this._warmPoolSize}`);
        })
        .catch((e) => { console.warn('[warm] pool launch failed:', e.message); ps.close().catch(() => {}); })
        .finally(() => { this._warming -= 1; });
    }
  }

  /** Resend the OTP on an existing pending verification (same live tab). */
  async resendOtp(pendingId) {
    this._prunePending();
    const pending = this._pending[pendingId];
    if (!pending || !pending.playwrightSession) {
      throw new Error('Verification expired — please start again');
    }
    // Resend clicks #sendtpid — an active drive — so quiesce the ping first, then
    // re-arm it (the session stays pending afterward, waiting on the customer).
    try { await pending.playwrightSession.quiesceKeepAlive(); } catch (_) {}
    let msg;
    try {
      msg = await pending.playwrightSession.resendOtp();
    } finally {
      try { pending.playwrightSession.startKeepAlive(); } catch (_) {}
    }
    pending.createdAt = Date.now();
    return { pendingId, message: msg || `OTP resent to ${this._maskMobile(pending.mobile)}`, ttlSeconds: 300 };
  }

  /**
   * Submit the OTP, capture the chitta (the government's own rendered PDF + HTML),
   * and CLOSE the browser immediately — nothing pools it, so leaving it open would
   * hold a launcher slot / ~250MB and eventually deadlock new verifications.
   */
  async completeVerification(pendingId, otp) {
    this._prunePending();
    const pending = this._pending[pendingId];
    if (!pending || !pending.playwrightSession) throw E.VERIFY_EXPIRED();
    const { mobile, playwrightSession } = pending;
    // Do NOT delete the pending up front — a WRONG OTP keeps the live govt session
    // so the customer can retype/resend within the countdown (no wasted OTP). We
    // only tear it down on success or on a terminal (OTP-consumed / dead-session)
    // outcome, in the finally.
    this._inflightVerifies += 1;
    let keepSession = false;
    // We are about to actively drive the tab — stop the ping AND wait out any that
    // is mid-flight so it can't race the submit.
    try { await playwrightSession.quiesceKeepAlive(); } catch (_) {}
    try {
      const result = await playwrightSession.submitOtp(otp);
      console.log('[otp] submitOtp → verified', result.verified, '| otpAccepted', result.otpAccepted,
        '| sessionExpired', !!result.sessionExpired,
        '| htmlSize', (result.html || '').length, '| pdf', result.pdf ? `${result.pdf.length}b` : 'none');
      if (!result.verified) {
        // OTP ACCEPTED but no document (no record, result page lost, or a post-accept
        // error) → the OTP is CONSUMED: terminal and counted as wasted. Checked
        // BEFORE sessionExpired, because an accepted-then-expired result is a wasted
        // OTP, NOT a "start again".
        if (result.otpAccepted) {
          const err = E.CHITTA_UNAVAILABLE(result.message);
          err.wasted = true;
          throw err;
        }
        // Session idled out BEFORE acceptance (OTP NOT consumed) → clean restart.
        if (result.sessionExpired) throw E.SESSION_EXPIRED(result.message);
        // Genuinely wrong OTP, session still live → keep it for a retry/resend.
        keepSession = true;
        throw E.WRONG_OTP(result.message);
      }
      metrics.verifySuccess.inc();
      this._lastGovtSuccessAt = Date.now();
      delete this._pending[pendingId];
      return { mobile, opts: pending.opts || {}, html: result.html || null, pdf: result.pdf || null };
    } finally {
      this._inflightVerifies = Math.max(0, this._inflightVerifies - 1);
      const alive = playwrightSession && !playwrightSession._closed
        && playwrightSession.page && !playwrightSession.page.isClosed();
      if (keepSession && alive) {
        // Wrong OTP — leave the pending in place for a retry/resend; re-arm keep-alive.
        pending.createdAt = Date.now();
        try { playwrightSession.startKeepAlive(); } catch (_) {}
      } else {
        // Success or terminal outcome — free the browser + its launcher slot and
        // refill the warm pool immediately so the next customer still gets a fast send.
        delete this._pending[pendingId];
        try { await playwrightSession.close(); } catch (_) {}
        try { this._ensureWarmPool(); } catch (_) {}
      }
    }
  }

  _prunePending() {
    const now = Date.now();
    const ttlMs = 5 * 60 * 1000;
    for (const [pendingId, pending] of Object.entries(this._pending)) {
      if (now - pending.createdAt <= ttlMs) continue;
      delete this._pending[pendingId];
      if (pending.playwrightSession && typeof pending.playwrightSession.close === 'function') {
        Promise.resolve(pending.playwrightSession.close()).catch(() => {});
      }
    }
  }

  _maskMobile(m) {
    return m ? String(m).replace(/(.{5})(.{5})/, '$1*****') : '';
  }

  /** Live state for deep /health + metrics gauges. Cheap; reads in-memory only. */
  stats() {
    const now = Date.now();
    const ages = this._warmPool.map((w) => now - w.at);
    return {
      warmPool: {
        depth: this._warmPool.length,
        size: this._warmPoolSize,
        warming: this._warming,
        oldestAgeMs: ages.length ? Math.max(...ages) : 0,
      },
      pending: Object.keys(this._pending).length,
      inflightVerifies: this._inflightVerifies,
      lastGovtSuccessAt: this._lastGovtSuccessAt,
    };
  }

  /**
   * "Busy" = anything that must NOT be interrupted by an RSS-triggered restart:
   * a verify actively in flight OR a customer holding a sent OTP awaiting verify.
   * The mem-watchdog gates its drain on this so a restart never wastes an OTP.
   */
  busyCount() {
    return this._inflightVerifies + Object.keys(this._pending).length;
  }

  warmingCount() { return this._warming; }

  async shutdown() {
    if (this._timer) clearInterval(this._timer);
    const backends = [
      ...Object.values(this._pending).map((p) => p.playwrightSession),
      ...Object.values(this._warm || {}).map((w) => w.session),
      ...(this._warmPool || []).map((w) => w.session),
    ].filter(Boolean);
    await Promise.allSettled(backends.map((b) => (
      typeof b.close === 'function' ? b.close() : Promise.resolve()
    )));
    this._pending = {};
    this._warm = {};
    this._warmPool = [];
  }
}

module.exports = { OtpService };
