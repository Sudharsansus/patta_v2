#!/usr/bin/env bash
# Provision an MPQR proxy pool: N EC2 forward-proxy instances in ap-south-1 (Mumbai),
# each with its OWN Elastic IP, so government-facing traffic is spread across many
# Indian IPs. Prints the MPQR_PROXIES string to set on the backend.
#
# Usage:   BACKEND_CIDR=<backend-egress-ip>/32 ./provision-proxies.sh [count]
# Example: BACKEND_CIDR=13.201.5.6/32 ./provision-proxies.sh 4
#
# Needs an AWS profile with ec2:RunInstances, AllocateAddress, AssociateAddress,
# CreateSecurityGroup, AuthorizeSecurityGroupIngress. (render-user could NOT do IAM,
# but EC2 create perms are separate — verify with a dry run.)
set -euo pipefail

REGION="${REGION:-ap-south-1}"
COUNT="${1:-3}"
TYPE="${TYPE:-t3.micro}"
PROXY_USER="${PROXY_USER:-mpqr}"
PROXY_PASS="${PROXY_PASS:-$(openssl rand -hex 12)}"
# IMPORTANT: lock the proxy to your BACKEND's public egress IP in production.
# 0.0.0.0/0 (default) leaves the proxy open to anyone who has the credentials.
BACKEND_CIDR="${BACKEND_CIDR:-0.0.0.0/0}"
HERE="$(cd "$(dirname "$0")" && pwd)"

echo "region=$REGION count=$COUNT type=$TYPE backend_cidr=$BACKEND_CIDR" >&2

# Latest Amazon Linux 2023 x86_64 AMI
AMI=$(aws ec2 describe-images --owners amazon --region "$REGION" \
  --filters "Name=name,Values=al2023-ami-2023.*-x86_64" "Name=state,Values=available" \
  --query 'sort_by(Images,&CreationDate)[-1].ImageId' --output text)

# Security group: allow the proxy port only from the backend.
SG=$(aws ec2 create-security-group --region "$REGION" \
  --group-name "mpqr-proxy-sg-$(date +%s)" --description "MPQR proxy pool" \
  --query GroupId --output text)
aws ec2 authorize-security-group-ingress --region "$REGION" --group-id "$SG" \
  --protocol tcp --port 3128 --cidr "$BACKEND_CIDR" >/dev/null

# User-data with the credentials baked in.
UD=$(sed "s|__USER__|$PROXY_USER|g; s|__PASS__|$PROXY_PASS|g" "$HERE/squid-cloud-init.sh" | base64 | tr -d '\n')

PROXIES=""
for i in $(seq 1 "$COUNT"); do
  IID=$(aws ec2 run-instances --region "$REGION" --image-id "$AMI" --instance-type "$TYPE" \
    --security-group-ids "$SG" --user-data "$UD" \
    --tag-specifications 'ResourceType=instance,Tags=[{Key=Name,Value=mpqr-proxy}]' \
    --query 'Instances[0].InstanceId' --output text)
  ALLOC=$(aws ec2 allocate-address --region "$REGION" --domain vpc --query AllocationId --output text)
  aws ec2 wait instance-running --region "$REGION" --instance-ids "$IID"
  aws ec2 associate-address --region "$REGION" --instance-id "$IID" --allocation-id "$ALLOC" >/dev/null
  IP=$(aws ec2 describe-addresses --region "$REGION" --allocation-ids "$ALLOC" --query 'Addresses[0].PublicIp' --output text)
  echo "  proxy $i: instance=$IID ip=$IP" >&2
  PROXIES="$PROXIES,http://$PROXY_USER:$PROXY_PASS@$IP:3128"
done

echo "" >&2
echo "# Set this on the backend (Squid takes ~60-90s to finish installing):" >&2
echo "MPQR_PROXIES=${PROXIES#,}"
