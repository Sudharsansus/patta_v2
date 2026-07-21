'use strict';

/**
 * Rotating outbound-proxy pool.
 *
 * Spreads government-facing browser traffic across MANY Indian IPs so no single IP
 * hammers eservices.tn.gov.in (the IP-rate-limit / WAF-block risk at scale). Each
 * browser session is assigned one proxy for its lifetime; a proxy that starts
 * getting blocked is put in cooldown and rotated out automatically.
 *
 * OFF BY DEFAULT: with no proxies configured, next() returns null and sessions
 * connect directly — identical to the pre-proxy behaviour. Turn on in production by
 * setting MPQR_PROXIES to a comma-separated list of proxy URLs, e.g.:
 *   MPQR_PROXIES="http://user:pass@13.201.1.10:3128,http://user:pass@13.201.1.11:3128"
 *
 * The proxies themselves are your own EC2 instances (one Elastic IP each) running a
 * forward proxy — see production/proxy-pool/ for the provisioning scripts.
 */

function parseProxies(raw) {
  return String(raw || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((u) => {
      try {
        const url = new URL(u.includes('://') ? u : `http://${u}`);
        return {
          server: `${url.protocol}//${url.host}`,               // Playwright proxy.server
          username: url.username ? decodeURIComponent(url.username) : undefined,
          password: url.password ? decodeURIComponent(url.password) : undefined,
          _key: url.host,                                        // stable id for health tracking
        };
      } catch (_) { return null; }
    })
    .filter(Boolean);
}

class ProxyPool {
  constructor(opts = {}) {
    this._all = parseProxies(opts.proxies != null ? opts.proxies : process.env.MPQR_PROXIES);
    this._cooldownMs = Number(opts.cooldownMs || process.env.MPQR_PROXY_COOLDOWN_MS || 120000);
    this._i = Math.floor(Math.random() * Math.max(1, this._all.length)); // stagger start across instances
    this._bad = new Map(); // _key -> cooldown-until timestamp
  }

  get enabled() { return this._all.length > 0; }
  size() { return this._all.length; }

  /** Next healthy proxy (round-robin, skipping those in cooldown). null = go direct. */
  next() {
    if (!this._all.length) return null;
    const now = Date.now();
    for (let n = 0; n < this._all.length; n++) {
      const p = this._all[this._i++ % this._all.length];
      const until = this._bad.get(p._key);
      if (!until || until <= now) { if (until) this._bad.delete(p._key); return p; }
    }
    // Everything is in cooldown — better to reuse one than fail the request outright.
    return this._all[this._i++ % this._all.length];
  }

  /** Mark a proxy as blocked/unhealthy → cooled down + rotated out for a while. */
  markBad(proxy) {
    if (proxy && proxy._key) this._bad.set(proxy._key, Date.now() + this._cooldownMs);
  }

  /** Mark a proxy as good again (e.g. after a successful fetch) — clears any cooldown. */
  markGood(proxy) {
    if (proxy && proxy._key) this._bad.delete(proxy._key);
  }

  stats() {
    const now = Date.now();
    const healthy = this._all.filter((p) => { const u = this._bad.get(p._key); return !u || u <= now; }).length;
    return { total: this._all.length, healthy, cooling: this._all.length - healthy };
  }
}

// Process-wide default pool from env, shared by all sessions unless one is injected.
let _default = null;
function defaultPool() { if (!_default) _default = new ProxyPool(); return _default; }

module.exports = { ProxyPool, defaultPool, parseProxies };
