#!/usr/bin/env bash
# Create the jeson-007 VM on Google Cloud. Run in Google Cloud Shell
# (gcloud there is already signed in as you).
#
#   bash create-vm.sh
#
# Options (environment variables):
#   MACHINE=e2-micro     e2-micro is in the Always Free tier (us-west1/us-central1/us-east1 only).
#                        e2-medium (4 GB) or e2-standard-2 (8 GB) cost money / trial credits.
#   ZONE=us-central1-a
#   NAME=jeson-007
#   DISK_GB=30           Free tier covers 30 GB of standard persistent disk.
#   PROJECT=<id>         defaults to the Cloud Shell's current project
set -euo pipefail

NAME="${NAME:-jeson-007}"
ZONE="${ZONE:-us-central1-a}"
MACHINE="${MACHINE:-e2-micro}"
DISK_GB="${DISK_GB:-30}"
PROJECT="${PROJECT:-$(gcloud config get-value project 2>/dev/null || true)}"

if [ -z "$PROJECT" ]; then
  echo "No project selected. Pick one first:  gcloud config set project <PROJECT_ID>" >&2
  exit 1
fi

if [ "$MACHINE" = "e2-micro" ]; then
  case "$ZONE" in
    us-west1-*|us-central1-*|us-east1-*) ;;
    *) echo "Note: e2-micro is free only in us-west1, us-central1 or us-east1 (ZONE=$ZONE is not)." >&2 ;;
  esac
else
  echo "Note: $MACHINE is not in the free tier; it uses trial credits or is billed." >&2
fi

echo "==> Project $PROJECT, zone $ZONE, machine $MACHINE, disk ${DISK_GB} GB standard"
gcloud services enable compute.googleapis.com --project "$PROJECT"

if gcloud compute instances describe "$NAME" --zone "$ZONE" --project "$PROJECT" >/dev/null 2>&1; then
  echo "==> $NAME already exists in $ZONE; not creating another."
else
  gcloud compute instances create "$NAME" \
    --project "$PROJECT" \
    --zone "$ZONE" \
    --machine-type "$MACHINE" \
    --image-family ubuntu-2404-lts-amd64 \
    --image-project ubuntu-os-cloud \
    --boot-disk-size "${DISK_GB}GB" \
    --boot-disk-type pd-standard
fi

cat <<EOF

VM ready. Connect from this Cloud Shell (it sets up SSH keys for you):
  gcloud compute ssh $NAME --zone $ZONE --project $PROJECT

Then on the VM:
  sudo -i
  curl -fsSL https://raw.githubusercontent.com/vickykenin-lang/Jeson-007/trading-mode/deploy/vps/connect-claude.sh -o connect-claude.sh
  bash connect-claude.sh
EOF
