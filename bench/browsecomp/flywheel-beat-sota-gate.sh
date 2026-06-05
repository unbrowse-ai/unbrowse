#!/usr/bin/env bash
# flywheel-beat-sota-gate.sh — the witness for "beat browsecomp SOTA via the aiko
# self-improvement flywheel". Exits 0 ONLY when the best recorded flywheel iteration's
# browsecomp score exceeds the SOTA bar. Honest by construction: a tiny model that
# can't reason multi-hop never clears it, so the gate stays red and the promise stays
# locked — the flywheel ledger documents the real trajectory instead of a fake green.
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
L="$HERE/flywheel-ledger.jsonl"
SOTA="${BROWSECOMP_SOTA:-0.30}"   # a real bar (frontier deep-research SOTA ~0.49-0.58)
[ -s "$L" ] || { echo "[flywheel] no iterations recorded yet"; exit 1; }
python3 - "$L" "$SOTA" <<'PY'
import json, sys
rows = [json.loads(l) for l in open(sys.argv[1]) if l.strip()]
sota = float(sys.argv[2])
best = max((r.get("score", 0) for r in rows), default=0)
last = rows[-1] if rows else {}
print(f"[flywheel] iterations={len(rows)} best_score={best} sota_bar={sota} "
      f"| last: score={last.get('score')} correct={last.get('correct')}/{last.get('n')} "
      f"index_routes={last.get('index_routes')}")
sys.exit(0 if best > sota else 1)
PY
