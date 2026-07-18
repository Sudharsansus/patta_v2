# A-Register (Adangal) service — working notes

SEPARATE service (own app/process, like the EC service), for the Tamil Nadu
**A-Register / Adangal** land record — NOT the TNREGINET EC.

Same government portal as patta: `eservices.tn.gov.in`, entry point
`land/aRegisterExtract_en.html?lan=en`. So it REUSES the patta engine
(headless browser + customer-OTP flow) — none of the EC captcha/pool/TrueCaptcha.

## Reuse from the patta service (lib/)
- lib/browser-launcher.js, lib/playwright-session.js (drive the govt form in-page)
- lib/pdf-generator.js (capture the govt's own rendered page as PDF)
- the reliability/observability layer (errors, metrics, logger, etc.)
- warm pool + fresh-navigation model

## TO CONFIRM (from the pasted details / live)
- The A-Register form fields + submit flow (survey/subdiv? patta-no? district cascade?).
- Whether it is OTP-gated (like patta) or open — decided live.
- The result page / document structure for the PDF capture.
- The exact endpoints (send-OTP if any, fetch/submit).

Awaiting the A-Register endpoints/flow to scaffold this service.
