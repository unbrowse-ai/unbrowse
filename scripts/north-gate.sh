#!/usr/bin/env bash
# north-gate — the single witness for the whole north star: unbrowse is a drop-in
# replacement for Exa, Browser-Use, MCPs and CLI skills — better, faster, with MORE
# COVERAGE, and it WORKS.
#
# It composes the two layers, and only passes when BOTH do:
#   1. replace-gate.sh — the HERMETIC, reproducible core: privacy/moat frontier
#      (zk-gate, 12 nodes), the warm-replay speed margin (≥20× the cold path), and
#      drop-in interface parity (every switch-from surface present).
#   2. coverage-gate.sh — the LIVE proof it WORKS with MORE COVERAGE: the real
#      `unbrowse search` binary returns real results across a broad, diverse intent
#      space (>= COVERAGE_MIN). Needs UNBROWSE_API_KEY; fails honestly without it.
#
# No fabricated green: tier 1 is hermetic and tier 2 reads real process output.
set -uo pipefail
cd "$(dirname "$0")/.."

echo "########## NORTH-GATE 1/2 — hermetic core (better + faster + safe + parity) ##########"
if ! bash scripts/replace-gate.sh; then
  echo "[north-gate] FAIL — hermetic core (replace-gate) red."; exit 1
fi

echo
echo "########## NORTH-GATE 2/2 — live: it WORKS, with MORE COVERAGE ##########"
if ! bash scripts/coverage-gate.sh; then
  echo "[north-gate] FAIL — live coverage (coverage-gate) red."; exit 1
fi

echo
echo "[north-gate] PASS — drop-in better+faster+safe (hermetic) AND it works with broad coverage (live)."
