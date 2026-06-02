#!/usr/bin/env bash
# open-core-live-gate.sh — the LIVE public open-core branch shows the wedge, hides
# the moat. Fetches unbrowse-ai/unbrowse@open-core and runs open-core-gate on the
# real published tree. Exit 0 iff the live public branch is correct.
set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
PUB="${OPEN_CORE_REMOTE:-git@github.com:unbrowse-ai/unbrowse.git}"
tmp="$(mktemp -d)"; wt="$tmp/oc"
cleanup() { git worktree remove "$wt" --force >/dev/null 2>&1 || true; rm -rf "$tmp"; }
trap cleanup EXIT

echo "=== fetch live public open-core ==="
git fetch "$PUB" open-core --quiet || { echo "  FETCH-FAIL: $PUB open-core"; exit 1; }
live=$(git rev-parse FETCH_HEAD)
echo "  live open-core: ${live:0:12}"
git worktree add --detach "$wt" FETCH_HEAD >/dev/null 2>&1 || { echo "  worktree-add failed"; exit 1; }

echo "=== gate the live tree ==="
bash scripts/open-core-gate.sh "$wt"
