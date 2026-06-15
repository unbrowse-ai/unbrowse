#!/usr/bin/env bash
# cascade-invalidation-gate.sh — the no-stale-serve gate (node 6).
#
# The single light to steer by: a value change anywhere in the pointer DAG must cascade to invalidate
# every transitive dependent — no stale serve — and fail closed (a composite with no content_id is
# treated as stale, never served). Exits 0 only if BOTH cascade witnesses pass: the value/resolution
# layer (content-addressed + hash-chain) AND the composite layer (Merkle content-id + validate-on-hit,
# incl. the fail-closed pre-Merkle case).
set -uo pipefail
cd "$(dirname "$0")/.."

fail=0
run() {
  echo "── $1"
  if timeout 120 bun "$2" 2>&1 | tail -3; then echo "  PASS: $1"; else echo "  FAIL: $1"; fail=1; fi
}

echo "[cascade-gate] no-stale-serve: a value change cascades to invalidate transitive dependents"
run "composite layer (Merkle content-id, validate-on-hit, fail-closed)" "bench/capability/test_composite_cascade_invalidation.ts"
run "value/resolution layer (content-addressed + hash-chain prev-fold)" "bench/capability/test_value_layer_cascade.ts"

if [ "$fail" -eq 0 ]; then
  echo "[cascade-gate] ✓ GREEN — both layers cascade; no stale serve; fail-closed on missing content-id"
  exit 0
else
  echo "[cascade-gate] ✗ a cascade witness FAILED — stale serve is possible; chase the failing layer"
  exit 1
fi
