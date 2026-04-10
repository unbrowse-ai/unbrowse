#!/usr/bin/env bash
# benchmark-historical.sh — retroactive benchmark across past npm versions
#
# Installs each target version fresh on a remote blank-slate host, runs
# the same dogfood corpus, records results. Lets us see the improvement
# curve across the whole release history, not just forward from now.
#
# Each run is isolated: wipe → npm install @ver → setup → dogfood → record
#
# Usage:
#   bash scripts/benchmark-historical.sh --remote HOST --versions "3.5.0 3.6.0 3.7.0 3.7.1"
#   bash scripts/benchmark-historical.sh --remote HOST --last-n 5
#
set -uo pipefail

REMOTE=""
VERSIONS=""
LAST_N=0
N=15
for arg in "$@"; do
  case "$arg" in
    --remote) shift; REMOTE="${1:-}"; shift || true ;;
    --versions) shift; VERSIONS="${1:-}"; shift || true ;;
    --last-n) shift; LAST_N="${1:-5}"; shift || true ;;
    --n) shift; N="${1:-15}"; shift || true ;;
  esac
done

if [ -z "$REMOTE" ]; then
  echo "usage: --remote HOST required" >&2
  exit 1
fi

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
HISTORY_FILE="${UNBROWSE_BENCHMARK_HISTORY:-$HOME/.unbrowse/benchmark-history.jsonl}"

# Build list of versions to test
if [ -z "$VERSIONS" ] && [ "$LAST_N" -gt 0 ]; then
  VERSIONS=$(npm view unbrowse versions --json 2>/dev/null | python3 -c "
import sys, json
vs = json.loads(sys.stdin.read())
# Take stable releases only (no -preview)
stable = [v for v in vs if '-' not in v and v.startswith('3.')]
print(' '.join(stable[-$LAST_N:]))
")
fi

if [ -z "$VERSIONS" ]; then
  echo "no versions specified — use --versions or --last-n" >&2
  exit 1
fi

echo "[historical] versions to benchmark: $VERSIONS"
echo "[historical] remote: $REMOTE"
echo "[historical] history file: $HISTORY_FILE"
echo ""

for VER in $VERSIONS; do
  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
  echo "[historical] benchmarking $VER..."
  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

  # Wipe + install specific version on remote
  ssh "$REMOTE" bash -s "$VER" <<'REMOTE_SCRIPT'
    set -uo pipefail
    VER="$1"
    export PATH="$HOME/.npm-global/bin:$PATH"
    # Wipe state
    pkill -9 -u "$USER" -f 'unbrowse|kuri' 2>/dev/null || true
    sleep 1
    rm -rf ~/.unbrowse 2>/dev/null || true
    npm uninstall -g unbrowse 2>/dev/null || true
    rm -rf ~/.npm-global/lib/node_modules/unbrowse 2>/dev/null || true
    # Install target
    npm cache clean --force 2>/dev/null || true
    if npm install -g "unbrowse@$VER" 2>&1 | tail -3; then
      echo "[historical-remote] installed $(unbrowse --version 2>/dev/null || echo 'missing')"
    else
      echo "[historical-remote] install failed for $VER"
      exit 1
    fi
REMOTE_SCRIPT

  if [ $? -ne 0 ]; then
    echo "[historical] install failed for $VER — skipping"
    continue
  fi

  # Run dogfood with this version
  bash "$ROOT_DIR/scripts/benchmark-over-time.sh" --remote "$REMOTE" --n "$N" 2>&1 | tail -15

  sleep 2
done

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "[historical] FINAL HISTORY:"
bash "$ROOT_DIR/scripts/benchmark-over-time.sh" --show
