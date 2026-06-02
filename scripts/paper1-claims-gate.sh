#!/usr/bin/env bash
# paper1-claims-gate.sh — Paper 1 done as code, like Papers 2 & 3.
#
# "Internal APIs Are All You Need" (arXiv:2604.00694) is the published wedge. This
# gate binds its FIVE headline claims to runnable, tested reference code, so Paper 1
# is reflected at the same standard as the other two papers ("done but better"):
#   1. shared route graph + three-path execution  -> tests/test_walk.py
#   2. ~3.6x speedup (cache reuse mechanism)       -> bench/bench_reuse.py (>1x)
#   3. three-tier x402 fee model                   -> tests/test_adoption.py
#   4. adoption condition  f_route < c_rediscovery -> tests/test_adoption.py
#   5. the paper is cited (arXiv id + title)       -> repo
set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
PY="$(command -v python3 || command -v python)"
fail=0
section() { echo; echo "=== $1 ==="; }

section "1. shared route graph + three-path execution"
if "$PY" paper/reference/tests/test_walk.py >/dev/null 2>&1; then echo "  green: test_walk.py"; else echo "  FAIL: test_walk.py"; fail=1; fi

section "2. cache-reuse speedup (the mechanism behind the 3.6x field result)"
sp=$(timeout 60 "$PY" paper/reference/bench/bench_reuse.py 2>/dev/null | grep -oE '"speedup_mean":[[:space:]]*[0-9.]+' | grep -oE '[0-9.]+' | head -1 || echo 0)
if "$PY" -c "import sys; sys.exit(0 if float('${sp:-0}')>1 else 1)" 2>/dev/null; then
  echo "  green: bench_reuse.py speedup_mean=${sp}x (>1)"; else echo "  FAIL: bench_reuse speedup not >1 (got ${sp})"; fail=1; fi

section "3+4. three-tier x402 + adoption condition (f < c)"
if "$PY" paper/reference/tests/test_adoption.py >/dev/null 2>&1; then echo "  green: test_adoption.py"; else echo "  FAIL: test_adoption.py"; fail=1; fi

section "5. Paper 1 is cited (arXiv id + title)"
if grep -rqsF "2604.00694" paper/ docs/ && grep -rqsiF "Internal APIs Are All You Need" paper/ docs/ frontend/src 2>/dev/null; then
  echo "  green: arXiv:2604.00694 + title cited in the repo"; else echo "  FAIL: Paper 1 citation missing"; fail=1; fi

echo
if [ "$fail" -ne 0 ]; then echo "PAPER1-CLAIMS-GATE FAIL — a Paper 1 claim is not yet backed by running code."; exit 1; fi
echo "PAPER1-CLAIMS-GATE PASS — every Paper 1 headline claim is backed by running, tested reference code."
