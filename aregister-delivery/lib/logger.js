'use strict';

/**
 * Structured JSON logging (pino) → stdout (Fly captures it).
 * PII (mobile, otp, api key) is redacted. Handlers create a child logger keyed
 * on referenceId so one customer's start→verify→resend is greppable end-to-end.
 * No transport/worker thread (would cost latency+memory on the 1-CPU VM).
 */
const pino = require('pino');

const logger = pino({
  level: process.env.LOG_LEVEL || 'info',
  base: { service: 'mpqr-patta-otp', region: process.env.FLY_REGION || undefined },
  redact: {
    paths: [
      'mobile', 'otp', 'mobileNo', 'otpno',
      '*.mobile', '*.otp', '*.mobileNo',
      'req.headers["x-api-key"]', 'req.headers.authorization', 'req.headers.cookie',
    ],
    censor: '[redacted]',
  },
});

module.exports = logger;
