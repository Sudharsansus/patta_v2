#!/bin/bash
# EC2 user-data: stand up the MPQR combined backend for a 50-concurrent live demo.
# Builds the image ON the instance (fast AWS bandwidth), runs it with the proxy pool +
# a big warm pool, and fronts it with Caddy for automatic HTTPS on <public-ip>.sslip.io.
set -xe
echo "=== MPQR EC2 setup start: $(date) ==="

# --- Docker + git ---
dnf install -y docker git
systemctl enable --now docker

# --- Public IP (IMDSv2) → sslip.io hostname for HTTPS ---
TOKEN=$(curl -s -X PUT "http://169.254.169.254/latest/api/token" -H "X-aws-ec2-metadata-token-ttl-seconds: 600")
IP=$(curl -s -H "X-aws-ec2-metadata-token: $TOKEN" http://169.254.169.254/latest/meta-data/public-ipv4)
HOST="${IP}.sslip.io"
echo "public IP=$IP host=$HOST"

# --- Build the combined image from the repo ---
cd /opt
git clone --depth 1 https://github.com/Sudharsansus/patta_v2.git mpqr
cd mpqr
docker build -f combined/Dockerfile -t mpqr-combined:latest .

# --- Run the backend (proxy pool + big warm pool; sized for c5.2xlarge = 8 vCPU / 16 GB) ---
# Serves ~30 concurrent users snappily. 4 proxies for IP-spread (gold bot removed freed the vCPU: 4 proxies=8 + backend=8 = 16, the account cap).
docker run -d --name mpqr --restart unless-stopped -p 127.0.0.1:8080:8080 \
  -e PORT=8080 \
  -e NODE_ENV=production \
  -e MPQR_NO_SANDBOX=1 \
  -e MPQR_API_KEY='mpqr-ae864c446c659d08127847b105a10e4d' \
  -e MPQR_PROXIES='http://mpqr:8ecc738e0fe0049eaadf4616@13.206.230.150:3128,http://mpqr:8ecc738e0fe0049eaadf4616@13.202.14.107:3128,http://mpqr:8ecc738e0fe0049eaadf4616@35.154.86.231:3128,http://mpqr:8ecc738e0fe0049eaadf4616@13.203.150.213:3128' \
  -e MPQR_PROXY_COOLDOWN_MS=120000 \
  -e MPQR_WARM_POOL_SIZE=2 \
  -e MPQR_MAX_CONCURRENT_BROWSERS=20 \
  -e MPQR_KEEPALIVE_MS=0 \
  -e MPQR_RSS_CEILING_MB=13500 \
  -e PLAYWRIGHT_TIMEOUT_MS=30000 \
  mpqr-combined:latest

# --- Caddy: automatic HTTPS on <ip>.sslip.io → localhost:8080 ---
# Install from the official static binary (no distro repo — AL2023 isn't in Caddy's
# RPM repo and the el/9 mirror returns empty metadata, which fails `dnf install caddy`).
curl -fsSL -o /tmp/caddy "https://caddyserver.com/api/download?os=linux&arch=amd64"
install -m 0755 /tmp/caddy /usr/bin/caddy
/usr/bin/caddy version
mkdir -p /etc/caddy /var/lib/caddy
cat > /etc/caddy/Caddyfile <<CADDY
${HOST} {
  reverse_proxy localhost:8080
}
CADDY
cat > /etc/systemd/system/caddy.service <<'UNIT'
[Unit]
Description=Caddy
After=network.target
[Service]
ExecStart=/usr/bin/caddy run --config /etc/caddy/Caddyfile --adapter caddyfile
ExecReload=/usr/bin/caddy reload --config /etc/caddy/Caddyfile --adapter caddyfile --force
Restart=on-failure
Environment=XDG_DATA_HOME=/var/lib/caddy
LimitNOFILE=1048576
[Install]
WantedBy=multi-user.target
UNIT
systemctl daemon-reload
systemctl enable --now caddy

echo "=== MPQR EC2 setup DONE: https://${HOST} ($(date)) ==="
