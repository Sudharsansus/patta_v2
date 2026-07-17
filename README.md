# MPQR Patta OTP — REST API

A lean, **stateless** microservice that fetches Tamil Nadu land records
(**Patta / Chitta / FMB**) from the government portal (`eservices.tn.gov.in`),
gated by the customer's mobile **OTP**, and returns the document as a **base64
PDF**. Built for MyPropertyQR to consume over REST.

- **No** session pool, **no** database, **no** object storage, **no** cache.
- Each request is self-contained: `send OTP → verify → fetch → PDF`.
- The customer's OTP is auto-read on **their** device (MyPropertyQR's app) and
  posted back — the service never handles SIMs or numbers.
- Runs headless Chromium (Playwright) from an **Indian IP** (Fly.io, Mumbai) —
  the government firewalls non-IN IPs.

---

## API

All `/api/*` routes require the header `X-API-Key: <MPQR_API_KEY>`. `/health` and
`/dashboard` are open.

### `POST /api/patta/start` — send the OTP
```jsonc
{
  "mobileNo": "8940352877",
  "districtName": "Salem", "talukName": "Edappady", "villageName": "Pulampatti",
  "surveyNumber": "489/1B", "subDivisionNumber": "1B",
  "landType": "R",                 // R = Rural, N = Natham
  "typeOfDocument": "Patta",
  "memberId": "…"                  // echoed back
}
```
Resolves the **names → government codes** live from the govt dropdowns, then sends
the OTP to `mobileNo`.
→ `{ "status": true, "referenceId": "…", "ttlSeconds": 300, "memberId": "…" }`

### `POST /api/patta/verify` — submit OTP, get the PDF
```jsonc
{ "referenceId": "…", "otp": "123456" }
```
→ `{ "status": true, "data": "<base64 PDF>", "referenceId": "…", "memberId": "…" }`
The PDF is the **government's own rendered page** + a branded front page + the FMB
sketch, merged.

### `POST /api/patta/resend` — resend OTP on a reference
`{ "referenceId": "…" }`

### `GET /api/live/{districts,taluks,villages,subdivs}`
The government dropdowns (code + name) — so callers can pre-populate pickers and/or
send codes instead of names.

### `GET /metrics` — Prometheus (needs `X-API-Key`)
Per-stage latency, cold-launch rate, warm-pool depth, and `mpqr_otp_wasted_total`.

### `GET /health`
Always **200** (liveness). `degraded` is a *field*, not a status, so a transient dip
doesn't pull the machine from rotation:
`{ "ok": true, "degraded": false, "machine": "…", "warmPool": {…}, "pending": 0, "lastGovtSuccessAt": … }`

### Reference IDs, retries & error codes
`referenceId` is `"<machineId>.<id>"`. A `/verify` that lands on the wrong machine
(multi-machine deploy) is transparently `fly-replay`'d to the one holding the session.
A retried `/verify` with the same `referenceId`+`otp` returns the **same** result (it never
re-spends the OTP). Failures carry a stable `code`:

| `code` | HTTP | Meaning / caller action |
|---|---|---|
| `INVALID_INPUT` | 400 | Bad mobile/survey/subdiv or missing field. Fix and retry. |
| `WRONG_OTP` | 400 | OTP rejected. Re-enter. |
| `SESSION_EXPIRED` | 400 | Govt page/session idled out — **start again** (fresh OTP). |
| `VERIFY_EXPIRED` | 400 | Reference no longer held — start again. |
| `CHITTA_UNAVAILABLE` | 422 | OTP fine, but no patta for this parcel (try the other Land Type). |
| `RATE_LIMITED` | 429 | Daily OTP limit for this mobile. Back off. |
| `OTP_SEND_FAILED` | 502 | Govt didn't send the OTP. Retryable. |
| `GOVT_DOWN` | 503 | Portal down / circuit open. Retry shortly. |
| `GOVT_TIMEOUT` | 504 | Portal timed out. Retryable. |
| `SHEDDING` | 503 | Instance draining / memory-pressured. Retry shortly. |

A successful `/verify` may return `"degraded": true` — the OTP was accepted but the branded
front page / FMB sketch couldn't be assembled, so the government's own PDF is served instead of
losing the OTP to a 502.

---

## Repository structure

Every file, and what it does:

### Service entry
| File | Purpose |
|---|---|
| **`bot/server.js`** | The Express REST API. Routes above, API-key auth, name→code resolution, base64 PDF response, graceful shutdown, and serves the tester dashboard. The only process started in production (`node bot/server.js`). |

### Core OTP automation (`lib/`)
| File | Purpose |
|---|---|
| **`lib/index.js`** | Public entry point. Inits the OTP service and exposes `beginVerification` / `completeVerification` / `prewarm` / `resendOtp` / `shutdown`. |
| **`lib/otp-service.js`** | OTP orchestration + the **standing warm-browser pool**. `beginVerification` sends the OTP (grabbing a pre-warmed browser for speed); `completeVerification` submits the OTP, captures the chitta, and **closes its own browser** (no leak). |
| **`lib/playwright-session.js`** | The government automation — one headless Chromium session driving the TNSERVICES form: navigate + mint access tokens, fill the location cascade, `sendOtp`, `submitOtp` (verify → submit → wait for the result → capture the govt's **own** page as a PDF), dialog handling. |
| **`lib/browser-launcher.js`** | Concurrency-limited Chromium launcher (a semaphore) so a burst of launches can't OOM the VM. |
| **`lib/pdf-generator.js`** | Builds the final PDF with `pdf-lib`: branded front page + the government's chitta PDF + the FMB sketch page, merged. |
| **`lib/fmb-extractor.js`** | Pulls the FMB (field-map) sketch URL — and owners / reference id — out of the chitta HTML. |
| **`lib/tns-client.js`** | Lightweight HTTP client for the government dropdown/data endpoints (keep-alive agent + retry on idempotent GETs; used by `tns-live`). |

### Resilience, observability & errors (`lib/`)
| File | Purpose |
|---|---|
| **`lib/errors.js`** | Typed error taxonomy (`AppError` with `code` + `httpStatus` + `retryable`) and `classify()` — maps a govt/dialog message to a stable code so the API never regex-guesses statuses. |
| **`lib/govt-breaker.js`** | Circuit breaker (opossum) around the govt-facing steps. A portal outage fast-fails as `GOVT_DOWN` (503) instead of stacking 30s timeouts; business errors (wrong OTP, no record, rate-limit…) pass through and never trip it. |
| **`lib/verify-idempotency.js`** | In-memory `(referenceId, otp)` cache so a retried `POST /verify` joins/returns the same outcome instead of hitting "expired" and wasting the OTP. |
| **`lib/mem-watchdog.js`** | RSS-ceiling watchdog: sheds new `/start` under memory pressure and, once idle, restarts cleanly **before** the kernel OOM-kills. |
| **`lib/http-agent.js`** | Shared keep-alive HTTPS agents (bounded sockets + hard timeout) for the govt axios clients. |
| **`lib/logger.js`** | Structured JSON logging (pino) → stdout, with mobile/OTP/API-key redaction. |
| **`lib/metrics.js`** | Prometheus metrics (prom-client): per-stage latency, cold-launch rate, warm-pool depth, and `mpqr_otp_wasted_total` — the money event. Served at `GET /metrics`. |

### Government data resolution (`bridge/`)
| File | Purpose |
|---|---|
| **`bridge/tns-live.js`** | Live government dropdowns — `getDistricts / getTaluks / getVillages / getSubdivs` (code + name). Backs `/api/live/*` and the name→code resolution. |
| **`bridge/mpqr-resolver.js`** | Resolves district/taluk/village **names → codes** (CSV lookup + a nested tree builder). |

### Data / UI
| Path | Purpose |
|---|---|
| **`data/tn-districts.csv`** | Small district/taluk/village name↔code sample used as a resolver fallback. |
| **`public/dashboard.html`** | The **API tester** (served open at `/dashboard`): pick district→taluk→village, enter survey/mobile → Send OTP → enter OTP → Verify → the PDF renders inline. Its API calls carry the key. |

### Android OTP reader (`otp-reader-android/`)
For MyPropertyQR's app — auto-reads the OTP on the customer's phone so no one types it.
| File | Purpose |
|---|---|
| **`OtpAutoReader.kt`** | Silent `RECEIVE_SMS` receiver, filtered to the fixed TN govt sender; extracts the code and hands it to a callback. |
| **`README.md`** | Wiring, the Google-Play caveat, and the one-tap **SMS User Consent** fallback (needed if you ship on Play Store; SMS *Retriever* can't work — the govt won't embed an app hash). |

### Config & build
| File | Purpose |
|---|---|
| **`Dockerfile`** | Playwright + Node 22 image; copies `lib bot bridge data public`; runs `node bot/server.js`. |
| **`fly.toml`** | Fly.io deploy (Mumbai `bom`, health check, blue-green, env). The API key is a Fly **secret**, not here. |
| **`package.json` / `package-lock.json`** | Dependencies + scripts (`start`, `dev`). |
| **`.env` / `.env.example`** | Local config (real key gitignored / template). |
| **`.gitignore` / `.dockerignore`** | Ignore rules. |
| **`GOVERNMENT_ENDPOINTS.md`** | Reference of the raw TN government endpoints (OTP, dropdowns, chitta, FMB). |

### Reference only (not part of the service, not deployed)
| Path | Purpose |
|---|---|
| **`mypropertyqr-patta-otp-mypropertyqr-dev/`** | MyPropertyQR's **existing Python (FastAPI)** patta-OTP module, kept for reference. Not copied into the Docker image. Safe to delete once no longer needed. |

---

## Configuration (env)

| Var | Default | Notes |
|---|---|---|
| `MPQR_API_KEY` | `dev-key-change-me` | Required in `X-API-Key`. Set in prod via `fly secrets set`. |
| `PORT` | `3030` | |
| `PLAYWRIGHT_HEADLESS` | `true` | |
| `PLAYWRIGHT_TIMEOUT_MS` | `30000` | Per-step Playwright timeout. |
| `MPQR_MAX_CONCURRENT_BROWSERS` | `4` (fly: `6`) | HARD cap on simultaneous headless browsers — the real memory guard (~300 MB each). |
| `MPQR_WARM_POOL_SIZE` | `2` (fly: `3`) | Pre-launched browsers parked at the govt form → fast OTP send. |
| `MPQR_KEEPALIVE_MS` | `30000` | Keep-alive ping that stops an idle govt session from timing out into "INVALID ACCESS". |
| `MPQR_RSS_CEILING_MB` | `1600` (fly: `1500`) | Memory watchdog: shed new `/start` above this, then restart cleanly once idle. |
| `LOG_LEVEL` | `info` | pino level (`debug`/`info`/`warn`/`error`). |
| `PDF_BRAND_NAME` / `PDF_BRAND_TAGLINE` | MyPropertyQR / … | PDF front-page branding. |

Optional tuning (sane defaults): `MPQR_POOL_TICK_MS` (20000), `MPQR_NETWORKIDLE_MS` (800), `MPQR_LAUNCH_TIMEOUT_MS` (30000).

---

## Run

```bash
# local (needs an Indian IP / VPN to reach the govt site)
cp .env.example .env      # set MPQR_API_KEY
npm install
npm start                 # → http://localhost:3030/dashboard

# deploy (Fly.io, Mumbai)
fly secrets set MPQR_API_KEY=<strong-key>
fly deploy --remote-only
```

The government limits **10 OTPs per day per mobile**. Since each customer uses their
**own** mobile, that limit is per-customer, not a system bottleneck.
