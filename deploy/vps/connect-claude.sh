#!/usr/bin/env bash
# Let a Claude Code cloud session work on this VPS via Remote Control.
#
#   sudo -i
#   bash connect-claude.sh            # installs Claude Code + tmux, creates /root/work
#   claude                            # one-time: log in with YOUR Claude account, then /exit
#   tmux new -s claude-rc 'cd /root/work && claude remote-control'
#                                     # answer its prompts, then detach: Ctrl-b then d
#
# The session keeps running in tmux after you log out of SSH.
# Stop it any time:  tmux kill-session -t claude-rc
set -euo pipefail

WORK_DIR="${WORK_DIR:-/root/work}"

if [ "$(id -u)" -ne 0 ]; then
  echo "Run as root (sudo -i)." >&2
  exit 1
fi

echo "==> Base tools"
if command -v apt-get >/dev/null 2>&1; then
  apt-get update -y
  apt-get install -y ca-certificates curl git tmux
elif command -v dnf >/dev/null 2>&1; then
  dnf install -y curl git tmux
else
  echo "Unsupported OS: need apt-get or dnf." >&2
  exit 1
fi

echo "==> Claude Code"
if ! command -v claude >/dev/null 2>&1; then
  curl -fsSL https://claude.ai/install.sh | bash
fi
# The native installer puts claude in ~/.local/bin
if ! command -v claude >/dev/null 2>&1 && [ -x "$HOME/.local/bin/claude" ]; then
  ln -sf "$HOME/.local/bin/claude" /usr/local/bin/claude
fi
claude --version

echo "==> Work folder: $WORK_DIR"
mkdir -p "$WORK_DIR"

cat <<EOF

Next (by hand, these need you):
  1. claude
       Log in with your Claude account (same account as the Claude app), then type /exit
  2. tmux new -s claude-rc 'cd $WORK_DIR && claude remote-control'
       Approve its prompts. When it says it is ready, detach: press Ctrl-b, then d
  3. Tell Claude in the app that the VPS is connected.
EOF
