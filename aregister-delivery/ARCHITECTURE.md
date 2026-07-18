# Architecture — MPQR A-Register (Adangal) OTP service

## What it does
Fetches the Tamil Nadu **A-Register / Adangal** land record from
`eservices.tn.gov.in`, which is gated behind a one-time OTP sent to the property
enquirer's mobile. The service drives the government's own web form in a headless
Chromium, sends the OTP, accepts the OTP the customer read, submits, and returns
the government's **own rendered PDF**. It is **stateless** — a half-finished OTP
flow lives only in RAM for a few minutes, keyed by an opaque `referenceId`.

## Request lifecycle
```
Frontend                     server.js                 lib (headless Chromium)        eservices.tn.gov.in
  │  POST /start ─────────────►│  resolve codes ─────────►│ open A-Register form ───────►│ (index → "View A-Register")
  │                            │                          │ fill parcel, click Send OTP ►│ otpgeneratenew  actionid=AC02
  │  ◄── referenceId ──────────│◄── pendingId ────────────│  (browser parked in RAM)     │ ──► OTP SMS to customer
  │                            │                          │                              │
  │  POST /verify {otp} ──────►│  ─────────────────────► │ enter OTP, Submit ──────────►│ verify_otp_new → A-Register
  │  ◄── base64 PDF ───────────│◄── {html, pdf} ─────────│ capture govt PDF (page.pdf)  │
```

## The `formKind` design
The engine (`lib/`) is shared with the patta/chitta service. A single option,
`formKind`, selects which government document it drives:

* `formKind: 'patta'` → the "View Patta / Chitta / FMB" form (`chittaNewRuralTamil.html`), OTP actionid **AC01**.
* `formKind: 'aregister'` → the "View A-Register" form (`areg_*.html`), OTP actionid **AC02**.

Everything else — field ids, the OTP send/verify endpoints, session handling — is
identical between the two, so the A-Register reuses the proven patta machinery.
`server.js` initialises the engine with `formKind: 'aregister'`.

## Capturing the result
After the OTP is verified and the form submitted, the A-Register renders as an HTML
page (tables). The engine prints the government's own page directly to an A4 PDF
(`captureAregPdf`) — no reconstruction, no branding. If the government ever returns
the document as an embedded file, the engine fetches those bytes directly instead.

## File map
| File | Responsibility |
|---|---|
| `server.js` | Express REST API: `/api/aregister/{start,verify,resend}`, `/api/live/*`, `/health`, `/metrics`; name→code resolution; graceful drain; memory watchdog. |
| `lib/index.js` | Public engine facade (`init`, `beginVerification`, `completeVerification`, `resendOtp`, `stats`, `shutdown`). |
| `lib/otp-service.js` | Orchestrates the OTP flow + a **warm pool** of pre-launched browsers parked at the form (fast "Send OTP"). |
| `lib/playwright-session.js` | Drives one headless-Chromium session: open form, fill parcel, send/verify OTP, capture the result PDF. Holds the `FORM_ACCESS` map + `formKind`. |
| `lib/browser-launcher.js` | Launches/limits Chromium (hard cap on concurrent browsers = the real memory guard). |
| `lib/pdf-generator.js` | HTML→PDF fallback renderer. |
| `lib/errors.js` | Typed error taxonomy + `classify()` → stable `{code, httpStatus, retryable}`. |
| `lib/govt-breaker.js` | opossum circuit breakers around the government calls (fast-fail on outage). |
| `lib/verify-idempotency.js` | Idempotent `/verify` cache (a retried OTP submit joins the same outcome — never a wasted OTP). |
| `lib/mem-watchdog.js` | Sheds new work at an RSS ceiling, then restarts cleanly once idle before the kernel OOM-kills. |
| `lib/metrics.js` / `lib/logger.js` | Prometheus metrics (incl. `mpqr_otp_wasted_total`) + PII-redacted structured logs. |
| `bridge/tns-live.js` | Live dropdown data via an in-page fetch on a data-only browser session (with an in-memory cache). |
| `public/areg.html` | Self-contained browser tester for the whole flow. |
| `otp-reader-android/` | Android OTP auto-reader (Kotlin) + wiring notes. |

## Reliability notes
* **Warm pool** — browsers are pre-launched and parked at the A-Register form, so a
  "Send OTP" skips the ~15 s cold start (~2 s warm).
* **Keep-alive is OFF** (`MPQR_KEEPALIVE_MS=0`) — the government session is fragile;
  an idle ping corrupted it in testing. Sessions are used quickly instead.
* **Never waste an OTP** — once the government accepts an OTP, any later failure is
  classified as terminal (not "wrong OTP"), counted in `mpqr_otp_wasted_total`, and
  the customer is given the clearest possible message.
* **Single machine is fine.** For 2+ machines the service uses Fly-Replay to route a
  `/verify` back to the machine that holds the pending session (in `referenceId`).
