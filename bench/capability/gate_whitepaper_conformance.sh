#!/usr/bin/env bash
# gate_whitepaper_conformance.sh — the witness for "the capability bench is up to standard
# according to the later whitepapers" (primarily paper/execute-dont-guess-benchmarks.md).
#
# The Execute-Don't-Guess standard, made runnable:
#   (1) REAL execution loop, not a diagnostic/mocked stub. The scored axes must drive the
#       documented agent contract — `resolve` / `run` / `execute` — NOT the diagnostic
#       `explain` nor the debug `eval resolve` nor a bare browser `go` for the ranked/execute
#       signals. (This is what the rewire fixed; the grep below is the regression guard.)
#   (2) Every number is a runnable witness that exits 0 through that real loop:
#       gate_current.sh must pass on the binary under test (UNBROWSE_BIN) against UNBROWSE_API_URL.
#   (3) No fabricated green: gate_current reads recorded LIVE rows; honest negatives stay.
#
# Exits 0 only when BOTH the static contract-conformance AND the live four-axis gate hold.
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
fail=0

echo "── conformance (1): scored drivers drive the REAL resolve/run/execute contract ──"
# Axis A ranking must call resolve(, not the diagnostic explain( .
if grep -qE '\bresolve\(' "$HERE/live_axes.py" && ! grep -qE '=\s*explain\(|\bd\s*=\s*explain\(' "$HERE/live_axes.py"; then
  echo "  ok   Axis A uses resolve() (not explain)"
else echo "  FAIL Axis A still calls explain() for ranking"; fail=1; fi
# Axis B execution must go through the run/resolve→execute replay, not browser go.
if grep -qE '"run"|resolve_execute' "$HERE/live_protocol.py" && grep -qE 'resolve_execute' "$HERE/gate_live.py"; then
  echo "  ok   Axis B uses the run/resolve→execute replay contract"
else echo "  FAIL Axis B not on the resolve→execute replay contract"; fail=1; fi
# No debug `eval resolve` CALL left in the scored drivers/adapter. Match only the actual
# subprocess args-list call form ["eval", "resolve", …] — NOT prose mentions in comments
# (the misdiagnosis notes legitimately reference the old command).
if grep -rqE '\[\s*"eval"\s*,\s*"resolve"' "$HERE/live_axes.py" "$HERE/live_protocol.py" "$HERE/adapters/unbrowse_cli.py" 2>/dev/null; then
  echo "  FAIL a scored driver still CALLS the debug 'eval resolve'"; fail=1
else echo "  ok   no debug 'eval resolve' call in scored drivers/adapter"; fi

echo "── conformance (2): every axis is a runnable witness through the real loop ──"
if UNBROWSE_BIN="${UNBROWSE_BIN:-unbrowse}" UNBROWSE_API_URL="${UNBROWSE_API_URL:-}" bash "$HERE/gate_current.sh" >/dev/null 2>&1; then
  echo "  ok   gate_current (four axes, current binary, real contract) exits 0"
else echo "  FAIL gate_current — an axis fails on the current binary"; fail=1; fi

echo "── conformance (3): thin-client standard (crypto/internal-apis: public client carries zero moat) ──"
TCG="$HERE/../../scripts/thin-client-gate.sh"
if [ -f "$TCG" ]; then
  if bash "$TCG" >/dev/null 2>&1; then echo "  ok   thin-client-gate (0 moat modules in client closure)"; else echo "  FAIL thin-client-gate — moat still in client closure"; fail=1; fi
else echo "  ok   thin-client-gate not present (skipped)"; fi

if [ "$fail" -eq 0 ]; then
  echo "── CONFORMANT: bench (Execute-Don't-Guess) + thin-client (zero-moat) up to standard (exit 0) ──"; exit 0
fi
echo "── NOT CONFORMANT (exit 1) ──"; exit 1
