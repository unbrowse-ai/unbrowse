#!/usr/bin/env bash
# ebm-refit-cron.sh — the periodic refit job for the learned energy head (layer 3).
#
# "Is it a cron job?" — yes. The ledger grows continuously (every execution appends
# a witnessed row), so the learned contrastive head is re-fit on a schedule against
# the latest ledger and shipped as a NEW content-addressed pointer. Consumers read
# bench/ebm/energy-head.latest.json; the pointer changing IS the rollout, and the
# pointer-cache invalidation (a new sha → reload) handles it with no redeploy.
#
# Install (refit nightly at 03:30):
#   (crontab -l 2>/dev/null; echo "30 3 * * * cd $PWD && bash scripts/ebm-refit-cron.sh >> bench/ebm/refit.log 2>&1") | crontab -
#
# Run once now:  bash scripts/ebm-refit-cron.sh
set -uo pipefail
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO"
TS="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

# Fit on the REAL ledger when it is large enough; the trainer falls back to the
# reproducible synthetic ledger (and says so) when the real ledger is too small.
echo "[ebm-refit] $TS refitting learned energy head..."
if python3 scripts/ebm/layer3_train.py --real; then
  PREV="${1:-}"
  NEW="$(python3 -c "import json;print(json.load(open('bench/ebm/energy-head.latest.json'))['sha256_8'])" 2>/dev/null)"
  echo "[ebm-refit] $TS shipped energy-head pointer sha=$NEW (rollout = pointer change; cache invalidates on new sha)"
  exit 0
fi
echo "[ebm-refit] $TS refit did NOT beat baseline on held-out — pointer NOT advanced (honest: no rollout of a worse head)"
exit 1
