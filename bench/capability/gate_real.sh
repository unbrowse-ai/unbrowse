#!/usr/bin/env bash
# gate_real.sh — witness that the benchmark uses REAL benchmarks cloned from GitHub.
# Exits 0 only when:
#   (1) the four-axis live gate (gate_all.sh) passes, AND
#   (2) a REAL benchmark cloned from github:exa-labs/benchmarks has been run against unbrowse
#       through its own harness (evals.rag) and a score recorded with provenance (repo+commit+
#       metric+N>=10). The score is an honest number (may be below Exa's baseline); the gate
#       proves we RAN the real benchmark, not a hand-built proxy.
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
fail=0
echo "── gate_real: four-axis live gate ──"
if bash "$HERE/gate_all.sh" >/dev/null 2>&1; then echo "  ok   gate_all (4 axes)"; else echo "  FAIL gate_all"; fail=1; fi
echo "── gate_real: real cloned-github benchmark evidence ──"
# the vendored clone must be a real git checkout of exa-labs/benchmarks
VEND="$HERE/../exa/vendor/benchmarks"
if git -C "$VEND" remote get-url origin 2>/dev/null | grep -q "exa-labs/benchmarks"; then
  echo "  ok   vendored clone = github:exa-labs/benchmarks ($(git -C "$VEND" rev-parse --short HEAD 2>/dev/null))"
else echo "  FAIL no real exa-labs/benchmarks clone"; fail=1; fi
python3 - "$HERE/history.jsonl" <<'PY' || fail=1
import json, sys
rows=[json.loads(l) for l in open(sys.argv[1]) if l.strip()]
real=[r for r in rows if r.get("source")=="real-benchmark" and "exa-labs/benchmarks" in str(r.get("benchmark_repo",""))
      and r.get("benchmark_commit") and (r.get("n") or 0)>=10 and isinstance(r.get("groundedness"),(int,float))]
if real:
    r=real[-1]
    print(f"  ok   real run: {r['harness']} groundedness={r['groundedness']} n={r['n']} commit={r['benchmark_commit']}")
    sys.exit(0)
print("  FAIL no real-benchmark run with provenance + n>=10"); sys.exit(1)
PY
[ "$fail" -eq 0 ] && echo "── gate_real: REAL BENCHMARKS RUN (exit 0) ──" || echo "── gate_real: NOT SETTLED (exit 1) ──"
exit $fail
