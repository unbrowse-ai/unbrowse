#!/usr/bin/env bash
# aiko08-browsecomp-gate.sh — beat our previous aiko 0.8B browsecomp baseline of ZERO.
# Exit 0 iff a recorded run (N>=10) scored > 0 (the 0.8B got at least one right with
# the EBM-equipped unbrowse). The run writes bench/browsecomp/aiko08-score.json.
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
S="$HERE/aiko08-score.json"
[ -f "$S" ] || { echo "[bc08] no recorded run yet"; exit 1; }
python3 -c "
import json,sys
d=json.load(open('$S'))
print(f\"[bc08] aiko 0.8B browsecomp: score={d['score']} correct={d['correct']}/{d['n']} (baseline was 0.0)\")
sys.exit(0 if d['score']>0 and d['n']>=10 else 1)
"
