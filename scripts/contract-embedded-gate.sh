#!/usr/bin/env bash
# contract-embedded-gate.sh — witness for "arch /contract embedded native --completion-promise
# levers pulled 100 times." Binding legs:
#   A. levers-gate green — the stated --completion-promise: >=100 unbrowse-related levers
#   B. value/resolution/search/plan layers ride /contract (witnessed): iq-mirror-resolution,
#      iq-ledger, iq-sealed-value, iq-cold-hydrate, emergentdb-contract-search, plan-drill
#   C. ROUTING layer renders as a native /contract three-shape (witnessed): resolution-contract
#      (interpret -> verify -> adjudicate drilled to terminal)
# HONEST SCOPE: gated-true for value/resolution/search/plan AND now the routing decision's
# three-shape rendering. The live resolve-race does not YET EMIT the neuron (named next lever),
# so "entire" is approached, not yet complete — the gate witnesses what is real.
set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"; cd "$ROOT"
fail=0
bash scripts/levers-gate.sh >/dev/null 2>&1 && echo "  ok   A: 100+ unbrowse-related levers (stated promise)" || { echo "  RED  A: levers-gate"; fail=1; }
if timeout 150 bun test tests/iq-mirror-resolution.test.ts tests/iq-ledger.test.ts tests/iq-sealed-value.test.ts tests/iq-cold-hydrate.test.ts tests/emergentdb-contract-search.test.ts tests/plan-drill.test.ts >/dev/null 2>&1; then
  echo "  ok   B: value/resolution/search/plan layers ride /contract (witnessed)"
else echo "  RED  B: /contract-embedding tests"; fail=1; fi
if timeout 60 bun test tests/resolution-contract.test.ts >/dev/null 2>&1; then
  echo "  ok   C: routing decision renders as native /contract three-shape (witnessed)"
else echo "  RED  C: resolution-contract three-shape"; fail=1; fi
echo
[ "$fail" -eq 0 ] && { echo "CONTRACT-EMBEDDED-GATE GREEN."; exit 0; } || { echo "CONTRACT-EMBEDDED-GATE RED."; exit 1; }
