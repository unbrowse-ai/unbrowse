#!/usr/bin/env bash
# gitignore-clean-gate.sh — the trainer's per-sha head snapshots must be ignored (so a
# refit never dirties the worktree / blocks a release), while the tracked `latest` pointer
# the runtime reads stays trackable. Exits 0 only when both hold.
set -uo pipefail
cd "$(git rev-parse --show-toplevel)"
fail=0
# a FRESH (never-seen) sha snapshot must be ignored
git check-ignore -q bench/ebm/energy-head.deadbeef.json || { echo "FAIL: fresh sha snapshot NOT ignored"; fail=1; }
# the live pointer must NOT be ignored (stays tracked)
git check-ignore -q bench/ebm/energy-head.latest.json && { echo "FAIL: latest pointer is ignored (must stay tracked)"; fail=1; }
[ "$fail" -eq 0 ] && echo "PASS: sha snapshots ignored, latest pointer tracked" || true
exit $fail
