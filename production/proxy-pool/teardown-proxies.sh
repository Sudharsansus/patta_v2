#!/usr/bin/env bash
# Tear down the MPQR proxy pool: terminate the mpqr-proxy instances, release their
# Elastic IPs, and delete the proxy security group(s). Region-scoped to ap-south-1.
set -euo pipefail
REGION="${REGION:-ap-south-1}"

echo "Finding mpqr-proxy instances in $REGION…" >&2
IIDS=$(aws ec2 describe-instances --region "$REGION" \
  --filters "Name=tag:Name,Values=mpqr-proxy" "Name=instance-state-name,Values=running,stopped,pending" \
  --query 'Reservations[].Instances[].InstanceId' --output text)

if [ -n "${IIDS:-}" ]; then
  # Release the Elastic IPs associated with these instances first.
  for IID in $IIDS; do
    ALLOC=$(aws ec2 describe-addresses --region "$REGION" \
      --filters "Name=instance-id,Values=$IID" --query 'Addresses[0].AllocationId' --output text 2>/dev/null || true)
    if [ -n "${ALLOC:-}" ] && [ "$ALLOC" != "None" ]; then
      aws ec2 disassociate-address --region "$REGION" --association-id \
        "$(aws ec2 describe-addresses --region "$REGION" --allocation-ids "$ALLOC" --query 'Addresses[0].AssociationId' --output text)" 2>/dev/null || true
      aws ec2 release-address --region "$REGION" --allocation-id "$ALLOC" 2>/dev/null || true
      echo "  released EIP $ALLOC" >&2
    fi
  done
  echo "  terminating: $IIDS" >&2
  aws ec2 terminate-instances --region "$REGION" --instance-ids $IIDS >/dev/null
  aws ec2 wait instance-terminated --region "$REGION" --instance-ids $IIDS
fi

# Delete the mpqr-proxy security groups (once no instances use them).
for SG in $(aws ec2 describe-security-groups --region "$REGION" \
  --filters "Name=group-name,Values=mpqr-proxy-sg-*" --query 'SecurityGroups[].GroupId' --output text); do
  aws ec2 delete-security-group --region "$REGION" --group-id "$SG" 2>/dev/null && echo "  deleted SG $SG" >&2 || true
done
echo "Proxy pool torn down." >&2
