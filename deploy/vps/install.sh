#!/usr/bin/env bash
# Install or update the Jeson-007 paper-trading automaton on a Linux VPS.
# Tested target: Ubuntu 22.04/24.04 (x86_64 or ARM). Oracle Linux 8/9 also supported.
#
#   sudo -i
#   curl -fsSL https://raw.githubusercontent.com/vickykenin-lang/Jeson-007/trading-mode/deploy/vps/install.sh | bash
#   (or, from a clone:  bash deploy/vps/install.sh)
#
# Re-running it updates the code, rebuilds, and restarts running services.
set -euo pipefail

REPO_URL="${REPO_URL:-https://github.com/vickykenin-lang/Jeson-007.git}"
BRANCH="${BRANCH:-trading-mode}"
APP_DIR="${APP_DIR:-/root/jeson-007}"

if [ "$(id -u)" -ne 0 ]; then
  echo "Run as root (sudo -i). The runtime keeps its files in /root/.automaton." >&2
  exit 1
fi

echo "==> System packages and Node.js 22"
need_node=1
if command -v node >/dev/null 2>&1; then
  major="$(node -p 'process.versions.node.split(".")[0]')"
  [ "$major" -ge 20 ] && need_node=0
fi
if command -v apt-get >/dev/null 2>&1; then
  apt-get update -y
  apt-get install -y ca-certificates curl git build-essential python3 sqlite3
  if [ "$need_node" -eq 1 ]; then
    curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
    apt-get install -y nodejs
  fi
elif command -v dnf >/dev/null 2>&1; then
  dnf install -y git gcc-c++ make python3 sqlite curl
  if [ "$need_node" -eq 1 ]; then
    curl -fsSL https://rpm.nodesource.com/setup_22.x | bash -
    dnf install -y nodejs
  fi
else
  echo "Unsupported OS: need apt-get or dnf." >&2
  exit 1
fi
node --version

echo "==> Code ($BRANCH) in $APP_DIR"
if [ -d "$APP_DIR/.git" ]; then
  git -C "$APP_DIR" fetch origin "$BRANCH"
  git -C "$APP_DIR" checkout "$BRANCH"
  git -C "$APP_DIR" pull --ff-only origin "$BRANCH"
else
  git clone --branch "$BRANCH" "$REPO_URL" "$APP_DIR"
fi

echo "==> Install and build"
cd "$APP_DIR"
corepack enable
corepack prepare pnpm@10.28.1 --activate
pnpm install --frozen-lockfile
pnpm build

echo "==> systemd services"
for unit in automaton automaton-dashboard; do
  sed "s#__APP_DIR__#$APP_DIR#g" "deploy/vps/$unit.service" > "/etc/systemd/system/$unit.service"
done
systemctl daemon-reload
for unit in automaton automaton-dashboard; do
  if systemctl is-active --quiet "$unit"; then
    systemctl restart "$unit"
    echo "    restarted $unit"
  fi
done

cat <<EOF

Done. Next steps (first install only):
  1. cd $APP_DIR && node dist/index.js --setup        # wizard: name, goal, API key
  2. node deploy/vps/configure-trading.mjs --market NSE
  3. systemctl enable --now automaton automaton-dashboard
  4. journalctl -u automaton -f                        # live logs
Dashboard (from your own computer):
  ssh -L 4747:127.0.0.1:4747 <user>@<server-ip>   then open http://127.0.0.1:4747/
EOF
