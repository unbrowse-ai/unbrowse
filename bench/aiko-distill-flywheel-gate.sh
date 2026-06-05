#!/usr/bin/env bash
# aiko-distill-flywheel-gate.sh — the composite witness for the distillation flywheel.
# Exits 0 only when BOTH are real:
#   1. the SFT moved the student toward the teacher (held-out val loss dropped below the
#      3.427 base) — distill-gate.sh in aiko-claude-distill.
#   2. a measured before->after: distilled-aiko BEATS base-aiko on a held-out winnable
#      task set (data/before_after.json, written by the before-after eval).
# Honest by construction: if the student can't beat base, no green.
set -uo pipefail
DISTILL="/Users/lekt9/Projects/aiko-claude-distill"
fail(){ echo "[flywheel] FAIL: $*"; exit 1; }

bash "$DISTILL/distill-gate.sh" >/dev/null 2>&1 || fail "distillation not proven (held-out val loss has not dropped below base 3.427)"
echo "[flywheel] ok: distillation worked — student moved toward teacher (val loss dropped)"

R="$DISTILL/data/before_after.json"
[ -f "$R" ] || fail "no before->after eval recorded yet (run the before-after harness)"
python3 - "$R" <<'PY'
import json, sys
d = json.load(open(sys.argv[1]))
dist, base = d.get("distilled_score", 0), d.get("base_score", 0)
print(f"[flywheel] before->after on {d.get('benchmark')}: base={base} -> distilled={dist} (n={d.get('n')})")
sys.exit(0 if dist > base else 1)
PY
echo "[flywheel] PASS — distilled aiko beats base aiko on the winnable benchmark"
