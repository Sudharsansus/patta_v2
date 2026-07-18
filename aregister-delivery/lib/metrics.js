'use strict';

/**
 * Prometheus metrics (prom-client). Surfaces the invisible bottlenecks (cold
 * launches, per-stage latency), the OOM risk (default RSS/heap/event-loop-lag),
 * and — most importantly — otp_wasted_total, the money event: an OTP the govt
 * accepted but which never became a delivered PDF. Scrape at GET /metrics.
 */
const client = require('prom-client');

const register = new client.Registry();
client.collectDefaultMetrics({ register, prefix: 'mpqr_' });

const stageSeconds = new client.Histogram({
  name: 'mpqr_stage_seconds',
  help: 'Latency per pipeline stage (seconds)',
  labelNames: ['stage'],
  buckets: [0.1, 0.25, 0.5, 1, 2, 3, 5, 8, 13, 21, 34],
  registers: [register],
});
const otpSent = new client.Counter({
  name: 'mpqr_otp_sent_total', help: 'OTPs sent to customers', labelNames: ['warm'], registers: [register],
});
const verifySuccess = new client.Counter({
  name: 'mpqr_verify_success_total', help: 'Verifications that produced a PDF', registers: [register],
});
const otpWasted = new client.Counter({
  name: 'mpqr_otp_wasted_total', help: 'OTP accepted by govt but no PDF delivered (money event)', labelNames: ['reason'], registers: [register],
});
const coldLaunch = new client.Counter({
  name: 'mpqr_cold_launch_total', help: 'Browser cold launches (warm-pool miss)', registers: [register],
});
const errorsTotal = new client.Counter({
  name: 'mpqr_errors_total', help: 'Errors by code + endpoint', labelNames: ['code', 'endpoint'], registers: [register],
});

/** Bind live-state gauges; `getState()` returns { browsers, warmPool, pending }. */
function bindGauges(getState) {
  const g = (name, help, read) => new client.Gauge({
    name, help, registers: [register],
    collect() { try { this.set(Number(read(getState()) || 0)); } catch (_) { this.set(0); } },
  });
  g('mpqr_browsers_active', 'Active headless browsers', (s) => s.browsers && s.browsers.active);
  g('mpqr_browsers_queued', 'Queued browser launches', (s) => s.browsers && s.browsers.queued);
  g('mpqr_warm_pool_depth', 'Standing warm-pool browsers ready', (s) => s.warmPool && s.warmPool.depth);
  g('mpqr_pending_verifications', 'Sent-OTP sessions awaiting verify', (s) => s.pending);
}

/** Time an async stage into the stageSeconds histogram. */
async function timeStage(stage, fn) {
  const end = stageSeconds.startTimer({ stage });
  try { return await fn(); } finally { end(); }
}

module.exports = {
  register, client,
  stageSeconds, otpSent, verifySuccess, otpWasted, coldLaunch, errorsTotal,
  bindGauges, timeStage,
};
