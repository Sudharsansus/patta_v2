'use strict';

/**
 * Typed error taxonomy.
 * ─────────────────────
 * The API layer maps a stable `code` → HTTP status instead of regex-matching
 * government wording (a govt copy tweak used to silently flip 400↔502). `code`
 * is machine-readable for MyPropertyQR's app; `retryable` tells a caller whether
 * a retry could plausibly help; `httpStatus` is the response status.
 */
class AppError extends Error {
  constructor(code, message, { httpStatus = 500, retryable = false, cause } = {}) {
    super(message);
    this.name = 'AppError';
    this.code = code;
    this.httpStatus = httpStatus;
    this.retryable = retryable;
    if (cause) this.cause = cause;
  }
}

const E = {
  INVALID_INPUT: (m) => new AppError('INVALID_INPUT', m || 'Invalid input', { httpStatus: 400 }),
  WRONG_OTP: (m) => new AppError('WRONG_OTP', m || 'Invalid OTP — check the code and try again', { httpStatus: 400 }),
  CHITTA_UNAVAILABLE: (m) => new AppError('CHITTA_UNAVAILABLE', m || 'No patta found for this parcel', { httpStatus: 422 }),
  // The govt page/session idled out — the customer must start again (fresh OTP).
  SESSION_EXPIRED: (m) => new AppError('SESSION_EXPIRED', m || 'Government session expired — please start again', { httpStatus: 400, retryable: true }),
  VERIFY_EXPIRED: (m) => new AppError('VERIFY_EXPIRED', m || 'Verification expired — please start again', { httpStatus: 400, retryable: true }),
  RATE_LIMITED: (m) => new AppError('RATE_LIMITED', m || 'Daily OTP limit reached for this mobile', { httpStatus: 429, retryable: false }),
  OTP_SEND_FAILED: (m) => new AppError('OTP_SEND_FAILED', m || 'The government site did not send the OTP', { httpStatus: 502, retryable: true }),
  GOVT_DOWN: (m) => new AppError('GOVT_DOWN', m || 'Government portal is currently unavailable — please try again shortly', { httpStatus: 503, retryable: true }),
  GOVT_TIMEOUT: (m) => new AppError('GOVT_TIMEOUT', m || 'Government portal timed out', { httpStatus: 504, retryable: true }),
  INTERNAL: (m) => new AppError('INTERNAL', m || 'Internal error', { httpStatus: 500 }),
};

// The business codes that must NEVER trip the circuit breaker (they are the
// customer's fault or a per-parcel fact, not a portal outage).
const BUSINESS_CODES = new Set([
  'INVALID_INPUT', 'WRONG_OTP', 'CHITTA_UNAVAILABLE', 'SESSION_EXPIRED', 'VERIFY_EXPIRED', 'RATE_LIMITED',
]);

/**
 * Classify a raw govt/dialog message or an arbitrary error into an AppError.
 * Order matters: rate-limit and session-expiry are checked before wrong-OTP so
 * "maximum attempts" / "invalid access" are not mislabeled as a bad code.
 */
function classify(err) {
  if (err instanceof AppError) return err;
  const msg = (err && err.message) || String(err || '');
  const t = msg.toLowerCase();
  if (/limit_exe|maximum\s*(attempt|limit)|too\s*many|exceed|attempts?\s*(left|remaining|over)/.test(t)) return E.RATE_LIMITED(msg);
  if (/invalid\s*access|session\s*(has\s*)?expired|session\s*time\s*?out|re-?login|not\s*a\s*valid\s*session/.test(t)) return E.SESSION_EXPIRED(msg);
  if (/invalid\s*otp|wrong\s*otp|otp[_\s-]*false|otp\s*rejected/.test(t)) return E.WRONG_OTP(msg);
  if (/no\s*patta|no\s*record|not\s*available|enter\s*valid|chitta\s*not\s*available/.test(t)) return E.CHITTA_UNAVAILABLE(msg);
  if (/verification\s*(expired|not\s*found)|expired\s*or\s*not\s*found/.test(t)) return E.VERIFY_EXPIRED(msg);
  if (/did\s*not\s*send|otp\s*was\s*sent.*no|send.*otp.*fail/.test(t)) return E.OTP_SEND_FAILED(msg);
  if (/timeout|timed\s*out|etimedout/.test(t)) return E.GOVT_TIMEOUT(msg);
  if (/econnreset|econnrefused|enotfound|eai_again|socket\s*hang|network|getaddrinfo/.test(t)) return E.GOVT_DOWN(msg);
  if (/unknown\s*(district|taluk|village)|required|missing\s|invalid\s*(mobile|survey|sub-?division)|survey\s*number/.test(t)) return E.INVALID_INPUT(msg);
  return E.INTERNAL(msg);
}

module.exports = { AppError, E, BUSINESS_CODES, classify };
