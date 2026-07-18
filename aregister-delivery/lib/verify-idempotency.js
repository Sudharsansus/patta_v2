'use strict';

/**
 * Idempotent /verify.
 * completeVerification() deletes the pending and closes the browser BEFORE the
 * HTTP response returns, so a client/proxy retry of the same (referenceId, otp)
 * after a transient blip would otherwise get "expired" — even though the govt
 * may already have accepted the OTP. This caches the settled outcome (and joins
 * an in-flight one) by referenceId+otp so a retry returns the SAME result rather
 * than wasting the OTP.
 *
 * In-memory only (no persistence reintroduced), tight TTL + small cap so it can't
 * grow the RSS the mem-watchdog guards. Bounded to the VERIFY result (html + govt
 * PDF buffer); PDF assembly runs after and is cheap to redo from the cached hit.
 */
class IdempotencyCache {
  constructor({ ttlMs = 90000, max = 32, keepRejection = null } = {}) {
    this.ttlMs = ttlMs;
    this.max = max;
    // keepRejection(err) → true to CACHE a rejection (terminal outcome), false to
    // DROP it so a retry re-attempts. Default: cache everything (back-compat).
    this._keepRejection = keepRejection;
    this.map = new Map(); // key -> { at, promise }
  }

  _evictExpired(now) {
    for (const [k, e] of this.map) if (now - e.at > this.ttlMs) this.map.delete(k);
  }

  /**
   * Run `fn` once per (referenceId, otp); a concurrent or later call within the
   * TTL joins the same promise instead of re-running (which would hit "expired").
   * The settled outcome — success OR a business failure — is cached so a retry is
   * consistent. A retry storm can't grow past `max`.
   */
  async run(referenceId, otp, fn) {
    const now = Date.now();
    this._evictExpired(now);
    const key = `${referenceId}:${otp}`;
    const existing = this.map.get(key);
    if (existing) { existing.at = now; return existing.promise; }
    const promise = Promise.resolve().then(fn);
    const entry = { at: now, promise };
    this.map.set(key, entry);
    // On SETTLE: refresh the age so the TTL window covers post-completion retries
    // (a retry after a slow verify still JOINS the settled result instead of
    // re-running into "expired"); and DROP a transient/retryable rejection so a
    // retry re-attempts — a cached GOVT_DOWN from an OPEN circuit (pending still
    // intact, OTP not consumed) must not block recovery for the whole TTL. This
    // also attaches a rejection handler, so there's no unhandled rejection.
    promise.then(
      () => { entry.at = Date.now(); },
      (err) => { if (this._keep(err)) entry.at = Date.now(); else this.map.delete(key); },
    );
    // Cap AFTER inserting so the just-added (newest) entry is never the victim.
    // Map preserves insertion order → keys().next() is the oldest.
    while (this.map.size > this.max) this.map.delete(this.map.keys().next().value);
    return promise;
  }

  _keep(err) { return this._keepRejection ? !!this._keepRejection(err) : true; }

  size() { return this.map.size; }
}

module.exports = { IdempotencyCache };
