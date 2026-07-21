# MPQR Proxy Pool (production) — spread government traffic across many IPs

At scale, every patta/A-Register fetch leaves through the backend's IP, and hammering
`eservices.tn.gov.in` from **one** IP risks the portal's rate-limit / WAF blocking it.
This pool routes each browser session through a **different Indian IP**, so no single
IP looks like it's hammering the government.

## How it works
```
                          ┌── EC2 proxy #1 (Elastic IP A) ──┐
  backend (browser  ──►   ├── EC2 proxy #2 (Elastic IP B) ──┤  ──►  eservices.tn.gov.in
  session per OTP)        └── EC2 proxy #3 (Elastic IP C) ──┘        (sees A / B / C …)
```
- Each session picks the next healthy proxy (round-robin) and uses it for its lifetime.
- A proxy that returns `INVALID ACCESS` (a possible block) is **cooled down** and
  rotated out automatically (`lib/proxy-pool.js`); it rejoins after the cooldown.
- **Off by default** — with no `MPQR_PROXIES` set the backend connects directly
  (unchanged). It only proxies when you provide the list.

## 1. Stand up the proxy instances
```bash
cd production/proxy-pool
# Lock the proxies to the backend's public egress IP (find it: curl ifconfig.me from the backend)
BACKEND_CIDR=<backend-ip>/32 ./provision-proxies.sh 4     # 4 proxy IPs
```
It launches 4 `t3.micro` instances in `ap-south-1`, gives each an Elastic IP running a
Squid forward proxy (basic-auth, HTTPS CONNECT only, proxy headers stripped), and prints:
```
MPQR_PROXIES=http://mpqr:<pass>@A:3128,http://mpqr:<pass>@B:3128,...
```

## 2. Turn it on
Set that value on the backend and restart:
- **Lightsail:** add `MPQR_PROXIES` to the container deployment env.
- **Docker/EC2:** `-e MPQR_PROXIES="..."`.
- Optional: `MPQR_PROXY_COOLDOWN_MS` (default 120000) — how long a blocked IP sits out.

Verify: `GET /health` should still be ok; each new OTP session now egresses from a
different proxy IP.

## 3. Scale / operate
- **More IPs:** re-run `provision-proxies.sh <n>` and append to `MPQR_PROXIES`.
- **Rule of thumb:** keep each IP well under the govt's per-IP burst — more concurrent
  users → more proxy IPs. Start with ~1 IP per 10–15 concurrent fetches and tune.
- **Monitoring:** the pool auto-cools blocked IPs; watch backend logs for
  `INVALID ACCESS` bursts on one IP (that IP is being throttled — add more).
- **Residential option:** for the hardest blocking, point `MPQR_PROXIES` at a
  residential-proxy provider (Bright Data / Smartproxy, India geo) instead of / in
  addition to these EC2 IPs — same config, just their proxy URLs.

## Security
- The Squid security group allows port 3128 **only from `BACKEND_CIDR`** — set it to
  the backend's IP, never leave `0.0.0.0/0` in production.
- Basic-auth credentials gate the proxy; rotate them by re-provisioning.
- Squid strips `Via` / `X-Forwarded-For` so the govt doesn't see a proxy hop.

## Cost (ap-south-1, rough)
- `t3.micro` ≈ $7.5/mo each; Elastic IP is free **while associated** to a running
  instance. 4 proxies ≈ ~$30/mo. Scale to your concurrency.

## Teardown
```bash
./teardown-proxies.sh      # terminates the mpqr-proxy instances + releases their EIPs + deletes the SG
```
