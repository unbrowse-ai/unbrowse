#!/usr/bin/env bash
# perf-gate — one re-runnable witness for the EmergentDB "make unbrowse faster"
# frontier. The DETERMINISTIC tier (the gate) verifies the cache logic with no
# network; the LIVE tier is best-effort evidence against real EmergentDB (it races
# a shared, mutable, non-deterministic global vector index, so it is NOT gated on).
#
# Exit 0 iff the deterministic tier is green.
#
# Covers, across the session's shipped levers:
#   - semantic cache tiering  L0 (in-process) -> L1 (qdkv exact) -> L2 (vector) + TTL
#   - deferred write-through (misses never pay the ~5s EmergentDB write inline)
#   - mget batch reads (kv.ts _idxLoad + listWithValues)
set -uo pipefail
cd "$(dirname "$0")/.."   # backend/

echo "=== DETERMINISTIC gate (mocked fetch, no network) ==="
if ! bun test tests/semantic-cache.test.ts; then
  echo "[perf-gate] FAIL — deterministic cache tests red"
  exit 1
fi

echo
echo "=== LIVE evidence (best-effort; needs EMERGENTDB_API_KEY + NEBIUS_API_KEY) ==="
if [ -f ../.env ]; then set -a; . ../.env 2>/dev/null || true; set +a; fi
if [ -n "${EMERGENTDB_API_KEY:-}" ] && [ -n "${NEBIUS_API_KEY:-}" ]; then
  for w in semantic-cache-defer-witness semantic-cache-exact-witness qdkv-mget-witness; do
    if bun "scripts/$w.ts" >/tmp/perf-gate-$w.log 2>&1; then
      echo "  ok   $w"
    else
      echo "  flaky/red  $w (live, not gated — see /tmp/perf-gate-$w.log)"
    fi
  done
else
  echo "  (skipped — keys not present)"
fi

echo
echo "[perf-gate] PASS — deterministic cache perf verified"
