#!/usr/bin/env bash
# decompose-browsecomp-gate.sh — beat the 0.8B's 0/15 browsecomp baseline via the
# untried in-harness lever: best-of-N parallel rollouts + confidence vote (the
# DeepResearchAgent already decomposes). Exit 0 iff a recorded run (N>=10) scored >0.
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
S="$HERE/decompose-score.json"
[ -f "$S" ] || { echo "[decomp] no recorded run yet"; exit 1; }
python3 -c "
import json,sys
d=json.load(open('$S'))
print(f\"[decomp] 0.8B browsecomp best-of-{d.get('best_of')}: score={d['score']} correct={d['correct']}/{d['n']} (baseline 0.0)\")
sys.exit(0 if d['score']>0 and d['n']>=10 else 1)
"
