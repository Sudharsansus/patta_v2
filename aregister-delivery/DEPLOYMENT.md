# MPQR A-Register (Adangal) OTP — Deployment Guide

How to deploy the service on your own platform. It is a standard **Docker
container** (Node 22 + Playwright Chromium) — build the image and run it anywhere
that meets the one hard requirement below.

---

## 0. The one hard requirement: an INDIAN IP

The TN government portal (`eservices.tn.gov.in`) **firewalls all non-Indian IPs**.
The container **must** run from an Indian datacenter/residential IP — e.g. **AWS
`ap-south-1` (Mumbai)**, GCP `asia-south1`, Azure Central India, Fly.io `bom`, or
any Indian VPS. A US/EU host fails with connection/timeout errors.

It also needs **headless Chromium** (Playwright): ~1–2 GB RAM and the Playwright
system libraries. The included `Dockerfile` bundles all of that — deploy the
container and you're done. Health check path: `GET /health` (HTTP 200), with a
generous ~60 s grace period (Chromium warms on boot).

---

## 1. Build the image (platform-agnostic)

```bash
docker build -t mpqr-aregister .

# Run locally / on any Indian host:
docker run -d --name aregister -p 3050:3050 \
  -e MPQR_API_KEY=<a-strong-random-key> \
  -e PORT=3050 \
  --restart unless-stopped \
  mpqr-aregister

curl http://localhost:3050/health          # {"ok":true,...}
```

That's the whole runtime contract: one container, port `3050`, `MPQR_API_KEY` in
the environment, ≥2 GB RAM, an Indian egress IP.

---

## 2. Deploy on AWS (recommended for this client)

Any AWS compute in **`ap-south-1` (Mumbai)** works. Two common shapes:

### A) ECS on Fargate (serverless containers)
1. Push the image to **ECR**:
   ```bash
   aws ecr create-repository --repository-name mpqr-aregister --region ap-south-1
   docker tag mpqr-aregister:latest <acct>.dkr.ecr.ap-south-1.amazonaws.com/mpqr-aregister:latest
   aws ecr get-login-password --region ap-south-1 | docker login --username AWS --password-stdin <acct>.dkr.ecr.ap-south-1.amazonaws.com
   docker push <acct>.dkr.ecr.ap-south-1.amazonaws.com/mpqr-aregister:latest
   ```
2. Create an ECS **Fargate** task/service in `ap-south-1`:
   - **CPU/Memory:** 1 vCPU / **2 GB** (or more) per task.
   - **Container port:** `3050`.
   - **Env:** `PORT=3050`, and `MPQR_API_KEY` from **AWS Secrets Manager / SSM
     Parameter Store** (do NOT hardcode it).
   - **Health check:** ALB/NLB target-group health check → `GET /health`, grace ~60 s.
   - **Networking:** a public subnet or a NAT gateway with an Indian IP; put an ALB
     in front for TLS.
   - Keep **at least 1 task always running** so the warm pool stays hot.

### B) EC2 (a single VM)
Launch an EC2 (e.g. `t3.small`+ / ≥2 GB) in `ap-south-1`, install Docker, then run
the `docker run` from section 1. Put nginx/Caddy in front for TLS, or an ALB.

> Scaling on AWS: raise task memory + `MPQR_MAX_CONCURRENT_BROWSERS` together for
> more concurrency, or run more tasks (the service is stateless). With 2+ tasks
> behind a load balancer, use **sticky sessions** (or a single task) so a `/verify`
> lands on the same task that sent the OTP — the OTP flow's pending state is in that
> task's RAM. (`fly.toml`'s built-in `fly-replay` handles this automatically on Fly;
> on AWS use LB stickiness.)

---

## 3. Deploy on other platforms

- **GCP:** Cloud Run (2 GB, min-instances 1, `asia-south1`) or a GCE VM in `asia-south1`.
- **Azure:** Container Apps or a VM in **Central India**.
- **Fly.io:** an `fly.toml` is included (region `bom`). `fly apps create <name>` →
  `fly secrets set -a <name> MPQR_API_KEY=<key>` → `fly deploy --remote-only`.
- **Any Indian VPS:** `docker run` as in section 1, behind nginx/Caddy for TLS.

---

## 4. Configuration (environment variables)

Only `MPQR_API_KEY` is required; the rest have safe defaults (see `.env.example`).

| Var | Prod value | Purpose |
|---|---|---|
| `MPQR_API_KEY` | *(secret)* | **Required.** The key callers send in `X-API-Key`. Store in a secret manager. |
| `PORT` | `3050` | Listen port. |
| `MPQR_MAX_CONCURRENT_BROWSERS` | `5` | Hard cap on headless browsers (~300 MB each) — the memory guard. Raise only with more RAM. |
| `MPQR_WARM_POOL_SIZE` | `2` | Pre-launched browsers for fast OTP send. |
| `MPQR_KEEPALIVE_MS` | `0` | Session keep-alive — **leave 0 (disabled)**; it corrupted live OTP sessions. |
| `MPQR_RSS_CEILING_MB` | `1700` | Memory watchdog ceiling — keep **below** the container's RAM. |
| `PLAYWRIGHT_TIMEOUT_MS` | `30000` | Per-step government-page timeout. |
| `LOG_LEVEL` | `info` | pino log level. |

Sizing: each live customer verify pins one Chromium (~150–350 MB). **2 GB** holds
~5 concurrent safely; scale RAM (or add tasks) for higher concurrency.

---

## 5. Verify a deployment

```bash
BASE=https://<your-host>
KEY=<your-api-key>

curl -s $BASE/health                                              # {"ok":true,...}
curl -s -H "X-API-Key: $KEY" "$BASE/api/live/districts" | head -c 300   # 38 districts
curl -s -H "X-API-Key: $KEY" "$BASE/metrics" | head              # Prometheus
# Full OTP flow: open the tester at $BASE/areg (enter the key), or POST
# /api/aregister/start then /api/aregister/verify with a real OTP.
```

A healthy instance shows `warmPool.depth` climbing to `2/2` in `/health`.

---

## 6. Operations

- **Logs:** container stdout (structured JSON; mobile/OTP/key are redacted).
- **Metrics:** `GET /metrics` (Prometheus). Watch `mpqr_otp_wasted_total` — it should
  stay flat; a rise means OTPs are being consumed without delivering a PDF.
- **Rate limit:** the government allows **10 OTPs/day/mobile** — per customer, not a
  system cap. Surface `RATE_LIMITED` (429) gracefully.
- **Restart/scale:** stateless — restart or add tasks freely. With 2+ tasks, use LB
  sticky sessions (or Fly-Replay on Fly) so `/verify` reaches the OTP's owning task.
- **Secrets:** rotate `MPQR_API_KEY` in your secret manager and redeploy. Never bake
  it into the image, `fly.toml`, or a committed `.env`.

---

## 7. Local development

```bash
cp .env.example .env          # set MPQR_API_KEY
npm ci
npx playwright install chromium
npm start                     # → http://localhost:3050/areg
```

> Local runs need an **Indian IP / VPN** to reach the government site; without one,
> the boot succeeds and `/health` works, but `/api/live/*` and the OTP flow fail
> with connection errors.
