/**
 * MPQR Patta OTP — public entry point.
 * ────────────────────────────────────
 * A lean REST-API backend: send the government OTP to the customer's own mobile,
 * verify the OTP their app read back, and return the chitta as the government's
 * own PDF. No session pool, no Postgres persistence, no S3/cache.
 */
'use strict';

const { PlaywrightSession } = require('./playwright-session');
const { OtpService } = require('./otp-service');

let _otp = null;

async function init(opts = {}) {
  _otp = new OtpService(opts.otpService || opts.sessionPool || {});
  return { otpService: _otp };
}

function _require() {
  if (!_otp) throw new Error('mpqr-pat-bot not initialized. Call init() first.');
  return _otp;
}

async function prewarm(parcel = {}) { return _require().prewarm(parcel); }
async function beginVerification(mobile, opts = {}) { return _require().beginVerification(mobile, opts); }
async function completeVerification(pendingId, otp) { return _require().completeVerification(pendingId, otp); }
async function resendOtp(pendingId) { return _require().resendOtp(pendingId); }

function getStatus() { return { initialized: !!_otp, ...(_otp ? _otp.stats() : {}) }; }
function stats() { return _otp ? _otp.stats() : {}; }
function busyCount() { return _otp ? _otp.busyCount() : 0; }
function warmingCount() { return _otp ? _otp.warmingCount() : 0; }

async function shutdown() {
  if (_otp) await _otp.shutdown();
  _otp = null;
}

module.exports = {
  init,
  prewarm, beginVerification, completeVerification, resendOtp,
  getStatus, stats, busyCount, warmingCount, shutdown,
  PlaywrightSession, OtpService,
};
