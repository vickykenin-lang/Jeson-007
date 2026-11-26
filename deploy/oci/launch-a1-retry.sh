#!/usr/bin/env bash
# Keep trying to create the Always Free Ampere A1 instance until OCI has capacity.
# Run in OCI Cloud Shell (the OCI CLI there is already signed in as you).
#
#   bash launch-a1-retry.sh
#
# Options (environment variables):
#   OCPUS=2 MEMORY_GB=12        shape size (Always Free A1 total: 2 OCPU / 12 GB)
#   SHAPE=VM.Standard.E2.1.Micro   create the Always Free AMD micro instead (fixed size)
#   NAME=jeson-007              instance name
#   SUBNET_NAME=hermes-public-subnet
#   WAIT_SECONDS=60             pause between attempts (OCI may rate-limit below ~60)
#   KEY=~/.ssh/jeson007         SSH key pair (created here if missing)
#
# Stop it any time with Ctrl-C. Keep the Cloud Shell tab open while it runs.
set -uo pipefail

OCPUS="${OCPUS:-2}"
MEMORY_GB="${MEMORY_GB:-12}"
NAME="${NAME:-jeson-007}"
SUBNET_NAME="${SUBNET_NAME:-hermes-public-subnet}"
WAIT_SECONDS="${WAIT_SECONDS:-60}"
KEY="${KEY:-$HOME/.ssh/jeson007}"
SHAPE="${SHAPE:-VM.Standard.A1.Flex}"
# Flex shapes need an explicit size; fixed shapes (E2.1.Micro) must not get one.
SHAPE_ARGS=()
SIZE_LABEL="fixed size"
if [[ "$SHAPE" == *.Flex ]]; then
  SHAPE_ARGS=(--shape-config "{\"ocpus\": $OCPUS, \"memoryInGBs\": $MEMORY_GB}")
  SIZE_LABEL="${OCPUS} OCPU / ${MEMORY_GB} GB"
fi

COMPARTMENT="${COMPARTMENT:-${OCI_TENANCY:-}}"
if [ -z "$COMPARTMENT" ]; then
  echo "Could not find your tenancy OCID (OCI_TENANCY is empty). Run this in OCI Cloud Shell." >&2
  exit 1
fi

echo "==> SSH key"
if [ ! -f "$KEY" ] || [ ! -f "$KEY.pub" ]; then
  mkdir -p "$(dirname "$KEY")"
  rm -f "$KEY" "$KEY.pub"
  # Cloud Shell runs in FIPS mode, which rejects ed25519; RSA is allowed.
  if ! ssh-keygen -t rsa -b 4096 -N "" -f "$KEY" -C "$NAME" >/dev/null || [ ! -f "$KEY.pub" ]; then
    echo "Could not create an SSH key at $KEY." >&2
    exit 1
  fi
  echo "    created $KEY (RSA; private key stays in your Cloud Shell)"
else
  echo "    using existing $KEY"
fi

echo "==> Looking up availability domain, subnet and Ubuntu 24.04 image"
AD="$(oci iam availability-domain list --compartment-id "$COMPARTMENT" --query 'data[0].name' --raw-output)"
SUBNET="$(oci network subnet list --compartment-id "$COMPARTMENT" --all \
  --query "data[?\"display-name\"=='$SUBNET_NAME'] | [0].id" --raw-output)"
IMAGE="$(oci compute image list --compartment-id "$COMPARTMENT" --all \
  --operating-system "Canonical Ubuntu" --operating-system-version "24.04" --shape "$SHAPE" \
  --sort-by TIMECREATED --sort-order DESC \
  --query "data[?!contains(\"display-name\", 'Minimal')] | [0].id" --raw-output)"

for v in AD SUBNET IMAGE; do
  if [ -z "${!v}" ] || [ "${!v}" = "null" ]; then
    echo "Could not find $v. Check SUBNET_NAME ('$SUBNET_NAME') and that Ubuntu 24.04 exists for $SHAPE." >&2
    exit 1
  fi
done
echo "    AD:     $AD"
echo "    subnet: $SUBNET_NAME"
echo "    image:  $(oci compute image get --image-id "$IMAGE" --query 'data."display-name"' --raw-output)"

existing="$(oci compute instance list --compartment-id "$COMPARTMENT" --all \
  --query "data[?\"display-name\"=='$NAME' && \"lifecycle-state\"!='TERMINATED'] | [0].id" --raw-output 2>/dev/null)"
if [ -n "$existing" ] && [ "$existing" != "null" ]; then
  echo "An instance named '$NAME' already exists ($existing). Not creating another." >&2
  exit 1
fi

attempt=0
while true; do
  attempt=$((attempt + 1))
  echo "==> Attempt $attempt at $(date -u +%H:%M:%S) UTC: $SHAPE ($SIZE_LABEL)"
  # --no-retry: fail fast on "out of capacity" instead of the CLI's own long internal retries
  out="$(oci --no-retry compute instance launch \
    --availability-domain "$AD" \
    --compartment-id "$COMPARTMENT" \
    --display-name "$NAME" \
    --shape "$SHAPE" \
    "${SHAPE_ARGS[@]}" \
    --image-id "$IMAGE" \
    --subnet-id "$SUBNET" \
    --assign-public-ip true \
    --ssh-authorized-keys-file "$KEY.pub" \
    --wait-for-state RUNNING \
    --query 'data.id' --raw-output 2>&1)"
  code=$?

  if [ $code -eq 0 ] && [[ "$out" == ocid1.instance* ]]; then
    ID="$(echo "$out" | grep -o 'ocid1.instance[^" ]*' | head -1)"
    IP="$(oci compute instance list-vnics --instance-id "$ID" --query 'data[0]."public-ip"' --raw-output)"
    echo
    echo "SUCCESS: $NAME is RUNNING"
    echo "  public IP: $IP"
    echo "  connect:   ssh -i $KEY ubuntu@$IP"
    exit 0
  fi

  if echo "$out" | grep -qiE "capacity"; then
    echo "    out of capacity, retrying in ${WAIT_SECONDS}s"
  elif echo "$out" | grep -qiE "TooManyRequests|429"; then
    echo "    rate limited, waiting longer"
    sleep "$WAIT_SECONDS"
  else
    echo "    launch failed with an unexpected error, stopping:" >&2
    echo "$out" | tail -20 >&2
    exit 1
  fi
  sleep "$WAIT_SECONDS"
done
