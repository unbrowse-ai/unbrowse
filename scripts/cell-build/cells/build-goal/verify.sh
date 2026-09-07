#!/usr/bin/env bash
# build-goal/verify.sh — the meta-cell's verification.
# Green only when every sibling cell's last verdict in state.json is "pass".
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
HARNESS_DIR="$(dirname "$HERE")/.."
STATE_JSON="$HARNESS_DIR/state.json"

if [ ! -f "$STATE_JSON" ]; then
  echo "[build-goal] state.json missing — run check.sh at least once"
  exit 2
fi

python3 - "$STATE_JSON" <<'PY'
import json, sys
state = json.load(open(sys.argv[1]))
cells = state.get("cells", [])
non_self = [c for c in cells if c.get("cell") != "build-goal"]
if not non_self:
    print("[build-goal] no child cells defined — nothing to verify yet")
    sys.exit(2)
failing = [c for c in non_self if c.get("verdict") != "pass"]
if failing:
    summary = ", ".join(f"{c['cell']}={c['verdict']}" for c in failing[:5])
    print(f"[build-goal] {len(failing)}/{len(non_self)} children not green: {summary}")
    sys.exit(1)
print(f"[build-goal] all {len(non_self)} child cells green")
sys.exit(0)
PY
