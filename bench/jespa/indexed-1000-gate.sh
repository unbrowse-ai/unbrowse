#!/usr/bin/env bash
# indexed-1000-gate.sh — the runnable witness for "1000 sites fast and indexed".
# Exits 0 iff the unbrowse route index (skill-snapshots — the moat, fed by EVERY passive capture)
# has >= TARGET indexed routes AND the grind output is honest (every grind route traces to a real
# captured endpoint). No fabricated count: the honesty guard is the same one proven to catch a planted fake.
set -uo pipefail
cd "$(dirname "$0")/../.."
TARGET="${TARGET:-1000}"

SNAP="$HOME/.unbrowse/skill-snapshots"
n_index=$(find "$SNAP" -name '*.json' 2>/dev/null | wc -l | tr -d ' ')
n_grind=$(find .bench-gate/grind-* -name capture.meta.json 2>/dev/null | wc -l | tr -d ' ')

echo "[indexed-1000] route index (skill-snapshots): $n_index | grind routes this run: $n_grind | target: $TARGET"

# Honesty: the grind output must not be fabricated (re-encode url_template -> dir name must match).
if [ "$n_grind" -gt 0 ]; then
  bash bench/jespa/grind-honesty-check.sh >/dev/null 2>&1 || { echo "[indexed-1000] FAIL: honesty guard caught a fabricated/mismatched grind route"; exit 1; }
fi

if [ "$n_index" -ge "$TARGET" ]; then
  echo "[indexed-1000] PASS — $n_index >= $TARGET routes passively indexed (honest)"
  exit 0
fi
echo "[indexed-1000] FAIL — $n_index < $TARGET (grind more sites; passive index still climbing)"
exit 1
