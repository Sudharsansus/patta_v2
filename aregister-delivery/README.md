# MPQR A-Register (Adangal) OTP — REST API

A lean, stateless service that fetches the **Tamil Nadu A-Register / Adangal**
land record from the government portal (`eservices.tn.gov.in`) behind the
customer's own OTP, and returns it as a PDF. No database, no S3, no session pool.

It is the same engine as the patta/chitta service, pointed at the **A-Register
form** — the only government-side difference is the OTP send uses **actionid AC02**
(patta uses AC01). It delivers the government's **own rendered document** (no
branding).

```
POST /api/aregister/start   { mobileNo, parcel } → { referenceId, ttlSeconds }
POST /api/aregister/verify  { referenceId, otp } → { data: <base64 A-Register PDF> }
POST /api/aregister/resend  { referenceId }
GET  /api/live/{districts,taluks,villages,subdivs}   (build the parcel cascade)
GET  /health   ·   GET /metrics (Prometheus, behind the API key)
```

## Quick start (local)
```bash
cp .env.example .env          # then set MPQR_API_KEY
npm ci
npx playwright install chromium
npm start                     # → http://localhost:3050/areg  (test page)
```
> Government dropdowns + OTP only work from an **Indian IP** (the portal blocks
> foreign IPs). Locally the server boots and `/health` works, but live calls need
> to run from India — see `DEPLOYMENT.md` (Fly.io, Mumbai region).

## What's in the box
| Path | What it is |
|---|---|
| `server.js` | The whole REST service (start / verify / resend / dropdowns / health). |
| `lib/` | The engine — headless-browser OTP flow, PDF capture, reliability layer. |
| `bridge/tns-live.js` | Live government dropdown data (districts/taluks/villages/subdivs). |
| `public/areg.html` | A working browser tester for the full flow. |
| `otp-reader-android/` | Android OTP auto-reader (Kotlin) — SMS User Consent. |
| `PAYLOADS.txt` | **Every request/response payload** — hand this to your frontend team. |
| `ARCHITECTURE.md` | How it works + the file map. |
| `DEPLOYMENT.md` | Deploy + operate as a Docker container — **AWS `ap-south-1`**, or any Indian host. |
| `GOVERNMENT_ENDPOINTS.md` | The raw government endpoints this wraps. |

## Integration in one paragraph
Send every request with header `X-API-Key: <MPQR_API_KEY>`. Build the parcel with
the `GET /api/live/*` cascade, `POST /api/aregister/start` to send the OTP, then
`POST /api/aregister/verify` with the OTP to get a base64 PDF. Full payloads and a
copy-paste frontend snippet are in **`PAYLOADS.txt`**.
