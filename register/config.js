'use strict';

/**
 * REGISTER module config (TNREGINET EC / Document Copy).
 * All env vars are namespaced (REGISTER_* / CAPTCHA_* / S3_*) so they never
 * collide with the patta module. Sensible defaults for local dev.
 */
const num = (v, d) => (v == null || v === '' || Number.isNaN(Number(v)) ? d : Number(v));

module.exports = {
  // Captcha-solved session pool
  poolMaxAgeMs: num(process.env.REGISTER_POOL_MAX_AGE_MS, 30 * 60 * 1000), // 30 min (TNREGINET CSRF window)
  poolMaxBorrows: num(process.env.REGISTER_POOL_MAX_BORROWS, 1),           // one borrow per captcha
  poolMaxSize: num(process.env.REGISTER_POOL_MAX_SIZE, 30),
  healthCheckMs: num(process.env.REGISTER_HEALTH_CHECK_MS, 5 * 60 * 1000), // reap dead browsers every 5 min
  csrfRotateMs: num(process.env.REGISTER_CSRF_ROTATE_MS, 30 * 60 * 1000),

  // Captcha
  captchaMode: (process.env.CAPTCHA_MODE || 'hitl').toLowerCase(), // v1: hitl only (human-in-the-loop)
  captchaSolveTimeoutMs: num(process.env.CAPTCHA_TIMEOUT_MS, 10000),
  captchaSessionTtlMs: num(process.env.REGISTER_CAPTCHA_TTL_MS, 5 * 60 * 1000), // 5 min to type it

  // Playwright (shared knobs with patta)
  headless: !/^(0|false|no|off)$/i.test(String(process.env.PLAYWRIGHT_HEADLESS ?? 'true')),
  timeoutMs: num(process.env.PLAYWRIGHT_TIMEOUT_MS, 30000),

  // Storage (patta has none — this module brings its own; local dir by default,
  // S3 used only if S3_BUCKET + creds are present).
  localPdfDir: process.env.LOCAL_PDF_DIR || require('path').join(__dirname, '..', '.register-pdfs'),
  s3: {
    bucket: process.env.S3_BUCKET || process.env.BUCKET_NAME || null,
    region: process.env.S3_REGION || process.env.AWS_REGION || 'ap-south-1',
    accessKey: process.env.S3_ACCESS_KEY || process.env.AWS_ACCESS_KEY_ID || null,
    secretKey: process.env.S3_SECRET_KEY || process.env.AWS_SECRET_ACCESS_KEY || null,
    endpoint: process.env.S3_ENDPOINT || process.env.AWS_ENDPOINT_URL_S3 || undefined,
    publicUrlBase: process.env.S3_PUBLIC_URL_BASE || null,
  },

  testMode: /^(1|true|yes|on)$/i.test(String(process.env.MPQR_TEST_MODE || '')),

  // TNREGINET
  tnreginet: {
    base: 'https://tnreginet.gov.in',
    ecSearchUrl: 'https://tnreginet.gov.in/portal/webHP?requestType=ApplicationRH&actionVal=openEncumbranceCertSearch&screenId=8400001&scenarioId=2&menuCode=8400010&auditUSFlag=true',
  },
};
