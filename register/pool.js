'use strict';

/**
 * REGISTER session model (DIFFERENT from patta's mobile-keyed pool):
 *
 *   - Sessions are ANONYMOUS captcha-solved browser instances (no per-user mobile).
 *   - sessionId = sha256(timestamp + random).
 *   - Two collections:
 *       pending — a browser that fetched a captcha via /begin, awaiting /verify
 *                 (short TTL, ~5 min to type the captcha).
 *       pool    — a captcha-VERIFIED browser added on /verify success, borrowable
 *                 by Quick EC (/fetch) for ~30 min; CONSUMED after one borrow.
 *   - Retire reasons: consumed (one borrow) | expired (TTL) | manual (DELETE) | dead.
 *   - NO error-based retirement: a transient TNREGINET error keeps the captcha valid.
 */
const crypto = require('crypto');
const config = require('./config');

function newSessionId() {
  return crypto.createHash('sha256')
    .update(Date.now() + ':' + crypto.randomBytes(12).toString('hex'))
    .digest('hex')
    .slice(0, 16);
}

class RegisterPool {
  constructor(opts = {}) {
    this.maxAgeMs = opts.maxAgeMs || config.poolMaxAgeMs;
    this.maxBorrows = opts.maxBorrows || config.poolMaxBorrows;
    this.maxSize = opts.maxSize || config.poolMaxSize;
    this.captchaTtlMs = opts.captchaTtlMs || config.captchaSessionTtlMs;

    this._pending = new Map(); // sessionId -> { sessionId, sess, csrfToken, parcel, createdAt }
    this._pool = [];           // FIFO of { sessionId, sess, state, addedAt, expiresAt, captchaSolvedAt, lastUsed, borrowsServed, consumed }
    this._borrowsThisHour = 0;
    this._hourStart = 0; // set lazily (Date.now can't run in some sandboxes at module load)

    this._timer = setInterval(() => this.reap(), opts.healthCheckMs || config.healthCheckMs);
    if (this._timer.unref) this._timer.unref();
  }

  // ── Pending captcha sessions (from /begin) ─────────────────────────────────
  addPending(sess, csrfToken, parcel) {
    const sessionId = newSessionId();
    this._pending.set(sessionId, { sessionId, sess, csrfToken, parcel, createdAt: Date.now() });
    return sessionId;
  }

  getPending(sessionId) {
    const p = this._pending.get(sessionId);
    if (!p) return null;
    if (Date.now() - p.createdAt > this.captchaTtlMs) { this._closePending(sessionId, 'expired'); return null; }
    return p;
  }

  _closePending(sessionId, _reason) {
    const p = this._pending.get(sessionId);
    if (!p) return;
    this._pending.delete(sessionId);
    try { p.sess && p.sess.close && p.sess.close(); } catch (_) {}
  }

  // ── Promote a verified session into the borrowable pool (on /verify success) ─
  promoteToPool(sessionId) {
    const p = this._pending.get(sessionId);
    if (!p) return null;
    this._pending.delete(sessionId);
    // Cap the pool: drop the oldest if full.
    while (this._pool.length >= this.maxSize) this._retireEntry(this._pool[0], 'evicted');
    const now = Date.now();
    const entry = {
      sessionId,
      sess: p.sess,
      csrfToken: p.csrfToken,
      state: 'IDLE',
      addedAt: now,
      expiresAt: now + this.maxAgeMs,
      captchaSolvedAt: now,
      lastUsed: now,
      borrowsServed: 0,
      consumed: false,
    };
    this._pool.push(entry);
    return entry;
  }

  /** Add an already-built pool entry directly (test mode / simulate-pool). */
  addPoolEntry(sess, sessionId) {
    const id = sessionId || newSessionId();
    const now = Date.now();
    const entry = {
      sessionId: id, sess, csrfToken: 'test-csrf', state: 'IDLE', addedAt: now,
      expiresAt: now + this.maxAgeMs, captchaSolvedAt: now, lastUsed: now,
      borrowsServed: 0, consumed: false,
    };
    this._pool.push(entry);
    return entry;
  }

  // ── Borrow (Quick EC) ──────────────────────────────────────────────────────
  /** Pop the oldest IDLE, still-fresh, still-alive session; mark BUSY. Or null. */
  borrow() {
    const now = Date.now();
    while (this._pool.length) {
      const e = this._pool.find((x) => x.state === 'IDLE');
      if (!e) return null;
      if (now > e.expiresAt || !this._alive(e)) { this._retireEntry(e, now > e.expiresAt ? 'expired' : 'dead'); continue; }
      e.state = 'BUSY';
      e.lastUsed = now;
      return e;
    }
    return null;
  }

  /** Return a borrowed session. If it did its allowed borrows → consume + retire. */
  releaseBorrow(entry, { success } = {}) {
    if (!entry) return;
    if (success) {
      entry.borrowsServed += 1;
      this._noteBorrow();
      if (entry.borrowsServed >= this.maxBorrows) {
        entry.consumed = true;
        this._retireEntry(entry, 'consumed');
        return;
      }
    }
    // Transient failure OR still has borrows left → back to IDLE (captcha still valid).
    entry.state = 'IDLE';
  }

  retire(sessionId, reason = 'manual') {
    const e = this._pool.find((x) => x.sessionId === sessionId);
    if (e) { this._retireEntry(e, reason); return true; }
    if (this._pending.has(sessionId)) { this._closePending(sessionId, reason); return true; }
    return false;
  }

  _retireEntry(entry, _reason) {
    const i = this._pool.indexOf(entry);
    if (i >= 0) this._pool.splice(i, 1);
    try { entry.sess && entry.sess.close && entry.sess.close(); } catch (_) {}
  }

  _alive(entry) {
    try { return !entry.sess || typeof entry.sess.isAlive !== 'function' || entry.sess.isAlive(); }
    catch (_) { return false; }
  }

  _noteBorrow() {
    const now = Date.now();
    if (!this._hourStart || now - this._hourStart > 3600 * 1000) { this._hourStart = now; this._borrowsThisHour = 0; }
    this._borrowsThisHour += 1;
  }

  // ── Maintenance: drop expired + dead sessions ──────────────────────────────
  reap() {
    const now = Date.now();
    for (const e of [...this._pool]) {
      if (now > e.expiresAt) this._retireEntry(e, 'expired');
      else if (!this._alive(e)) this._retireEntry(e, 'dead');
    }
    for (const [id, p] of this._pending) {
      if (now - p.createdAt > this.captchaTtlMs) this._closePending(id, 'expired');
    }
  }

  // ── Introspection ──────────────────────────────────────────────────────────
  sessions() {
    const now = Date.now();
    return this._pool.map((e) => ({
      sessionId: e.sessionId,
      state: now > e.expiresAt ? 'EXPIRED' : e.state,
      addedAt: Math.round(e.addedAt / 1000),
      expiresAt: Math.round(e.expiresAt / 1000),
      captchaSolvedAt: Math.round(e.captchaSolvedAt / 1000),
      lastUsed: Math.round(e.lastUsed / 1000),
      borrowsServed: e.borrowsServed,
      consumed: e.consumed,
    }));
  }

  stats() {
    const now = Date.now();
    const idle = this._pool.filter((e) => e.state === 'IDLE' && now <= e.expiresAt).length;
    const busy = this._pool.filter((e) => e.state === 'BUSY').length;
    const expired = this._pool.filter((e) => now > e.expiresAt).length;
    return {
      totalSessions: this._pool.length,
      idleSessions: idle,
      busySessions: busy,
      expiredSessions: expired,
      consumedSessions: this._pool.filter((e) => e.consumed).length,
      totalBorrowsThisHour: this._borrowsThisHour,
    };
  }

  /** Compact pool summary for /health. */
  health() {
    const s = this.stats();
    return { idle: s.idleSessions, busy: s.busySessions, total: s.totalSessions };
  }

  async shutdown() {
    if (this._timer) clearInterval(this._timer);
    const closers = [
      ...[...this._pending.values()].map((p) => p.sess),
      ...this._pool.map((e) => e.sess),
    ].filter(Boolean);
    await Promise.allSettled(closers.map((s) => (s.close ? s.close() : Promise.resolve())));
    this._pending.clear();
    this._pool = [];
  }
}

module.exports = { RegisterPool, newSessionId };
