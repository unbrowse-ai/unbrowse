#!/usr/bin/env bash
set -euo pipefail

# Unbrowse skill setup helper.
# Verifies `agent-browser` is installed and optionally installs its Chromium bundle.

want_install=0
if [[ "${1:-}" == "--install" ]]; then
  want_install=1
fi

if ! command -v agent-browser >/dev/null 2>&1; then
  cat <<'EOF'
agent-browser not found on PATH.

Install one of:
  npm install -g agent-browser
  brew install agent-browser

Then (first time only) download Chromium:
  agent-browser install
EOF
  exit 1
fi

agent-browser --version >/dev/null 2>&1 || true

if [[ "$want_install" == "1" ]]; then
  agent-browser install
fi

echo "OK: agent-browser available"

