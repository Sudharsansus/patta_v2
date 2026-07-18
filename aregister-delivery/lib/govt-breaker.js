'use strict';

/**
 * Circuit breaker (opossum) around the government-facing steps.
 * When the portal is down, this converts N requests each stacking a ~30-40s
 * Playwright timeout (and piling browsers toward OOM) into fast GOVT_DOWN 503s.
 *
 * CRITICAL: business errors (wrong OTP, no record, rate-limit, session expired,
 * bad input) must NOT trip the breaker — otherwise one customer's typo opens the
 * circuit for everyone. `errorFilter` marks those as non-failures, and the
 * fallback re-throws them unchanged so only genuine portal failures become
 * GOVT_DOWN. Breaker state is per-machine + in-memory → stateless-safe.
 */
const CircuitBreaker = require('opossum');
const { E, BUSINESS_CODES, classify } = require('./errors');

function isBusiness(err) {
  const code = (err && err.code) || (classify(err) || {}).code;
  return BUSINESS_CODES.has(code);
}

function makeBreaker(name, fn, opts = {}) {
  const breaker = new CircuitBreaker(fn, {
    name,
    timeout: opts.timeout || 40000,
    errorThresholdPercentage: opts.errorThresholdPercentage || 50,
    volumeThreshold: opts.volumeThreshold || 5,
    resetTimeout: opts.resetTimeout || 15000,
    // Return true for errors that should NOT count as a circuit failure.
    errorFilter: isBusiness,
  });
  // Fallback fires when the circuit is OPEN or on a genuine failure. opossum
  // appends the original error as the last argument — pass business errors
  // through untouched, and surface everything else as GOVT_DOWN.
  breaker.fallback((...args) => {
    const err = args[args.length - 1];
    if (err instanceof Error && isBusiness(err)) throw err;
    throw E.GOVT_DOWN();
  });
  breaker.on('open', () => console.warn(`[breaker] ${name} OPEN — govt portal treated as down`));
  breaker.on('halfOpen', () => console.warn(`[breaker] ${name} half-open — probing`));
  breaker.on('close', () => console.log(`[breaker] ${name} closed — govt portal healthy`));
  return breaker;
}

module.exports = { makeBreaker };
