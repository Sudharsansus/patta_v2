#!/bin/bash
# EC2 user-data: turn a fresh Amazon Linux 2023 instance into a hardened HTTPS
# forward proxy (Squid) with basic auth. One instance = one Elastic IP = one outbound
# IP for the MPQR proxy pool. __USER__ / __PASS__ are substituted by provision-proxies.sh.
set -euxo pipefail

dnf install -y squid httpd-tools

# Credential file (basic auth). Backend connects with these creds.
htpasswd -b -c /etc/squid/passwd '__USER__' '__PASS__'
chown squid:squid /etc/squid/passwd
chmod 640 /etc/squid/passwd

# Minimal forward-proxy config: authenticated CONNECT to 443 only (HTTPS to the govt).
cat > /etc/squid/squid.conf <<'CONF'
auth_param basic program /usr/lib64/squid/basic_ncsa_auth /etc/squid/passwd
auth_param basic realm mpqr-proxy
auth_param basic credentialsttl 12 hours

acl authenticated proxy_auth REQUIRED
acl SSL_ports port 443
acl Safe_ports port 80 443
acl CONNECT method CONNECT

http_access deny !Safe_ports
http_access deny CONNECT !SSL_ports
http_access allow authenticated
http_access deny all

http_port 3128

# Don't leak that a proxy is in the path (look like a normal client to the govt).
via off
forwarded_for delete
request_header_access X-Forwarded-For deny all
request_header_access Via deny all
request_header_access Cache-Control deny all

# Trim logging/caching — this is a pass-through relay.
cache deny all
access_log none
cache_log /var/log/squid/cache.log
CONF

systemctl enable squid
systemctl restart squid
