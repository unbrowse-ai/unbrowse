#!/usr/bin/env bash
# gate_selfimprove.sh — witness that unbrowse RELIABLY self-improved on a real cloned
# benchmark (not single-run noise). Exits 0 only when:
#   (1) gate_real.sh passes (four-axis live + real exa-labs/benchmarks run), AND
#   (2) improvements.jsonl records a RELIABLE n>=30 A/B where the improved searcher beats the
#       baseline by a real margin (> the measured single-run noise), AND
#   (3) the search was thorough: >= 7 documented improvement attempts (incl. honest negatives).
# Honesty note: the metric has ~1-query single-run variance at n=12 (proven: 0.500/0.500/0.417),
# so improvements are only counted at n>=30 with margin >= 0.05. No single-run delta is trusted.
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
fail=0
echo "── gate_selfimprove: real-benchmark gate ──"
if bash "$HERE/gate_real.sh" >/dev/null 2>&1; then echo "  ok   gate_real"; else echo "  FAIL gate_real"; fail=1; fi
echo "── gate_selfimprove: RELIABLE improvement (n>=30 A/B) + thorough search ──"
python3 - "$HERE/improvements.jsonl" <<'PY' || fail=1
import json, sys
rows=[json.loads(l) for l in open(sys.argv[1]) if l.strip()]
base=[r for r in rows if r.get("role")=="baseline_n30" and (r.get("n") or 0)>=30]
imp =[r for r in rows if r.get("role")=="improved_n30" and (r.get("n") or 0)>=30]
attempts=[r for r in rows if "change" in r]
MARGIN=0.05
reliable = bool(base and imp and (imp[-1]["groundedness"] - base[-1]["groundedness"]) >= MARGIN)
thorough = len(attempts) >= 7
if reliable:
    print(f"  ok   reliable improvement: baseline={base[-1]['groundedness']:.3f} -> improved={imp[-1]['groundedness']:.3f} (+{imp[-1]['groundedness']-base[-1]['groundedness']:.3f}, n>=30)")
else:
    print("  FAIL no reliable n>=30 improvement with margin >= 0.05")
print(f"  {'ok  ' if thorough else 'FAIL'} thorough search: {len(attempts)} documented attempts (need >=7)")
sys.exit(0 if (reliable and thorough) else 1)
PY
[ "$fail" -eq 0 ] && echo "── gate_selfimprove: RELIABLY SELF-IMPROVED (exit 0) ──" || echo "── gate_selfimprove: KEEP IMPROVING (exit 1) ──"
exit $fail
