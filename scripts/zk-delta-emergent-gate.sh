#!/usr/bin/env bash
# zk-delta-emergent-gate — the witness for moving the shared-graph store to EmergentDB
# primary + CF KV fallback (plan.md): per-endpoint keys (fit the ~10KB qdkv cap), an
# EmergentDB-backed FallbackKV, and a per-endpoint route merge. CHECKLIST gate: each node is
# a real test that must exist AND pass; an absent test is UNBUILT. Exit 0 only when every
# node is real + tested AND the prover/verifier boundary holds. The live EmergentDB round-trip
# is verified on staging, outside this in-process gate (reported separately).
set -uo pipefail
cd "$(dirname "$0")/.."

NODES=(
  "per-endpoint-store:tests/graph-perkey.test.ts"
  "emergentdb-primary-routing:tests/graph-emergentdb-routing.test.ts"
  "per-endpoint-merge:tests/graph-perkey-route.test.ts"
)

todo=0; done=0; pending_tests=()
echo "=== zk-delta EmergentDB-primary: $(date -u +%Y-%m-%dT%H:%MZ) ==="
for entry in "${NODES[@]}"; do
  name="${entry%%:*}"; test="${entry#*:}"
  if [ -f "$test" ]; then
    echo "  built  [$name] -> $test"; done=$((done+1)); pending_tests+=("$test")
  else
    echo "  TODO   [$name] -> $test (build it next)"; todo=$((todo+1))
  fi
done
echo "  nodes: $done built / $todo unbuilt (target: 3/0)"

if [ "${#pending_tests[@]}" -gt 0 ]; then
  echo "=== running ${#pending_tests[@]} built-node test(s) ==="
  if ! bun test "${pending_tests[@]}"; then
    echo "[zk-delta-emergent] FAIL — a built node's test is red"; exit 1
  fi
fi

# Boundary: the client (src/) must not import the SERVER-ONLY graph store/merge/route.
bad=$(git grep -lE "(from|import\()\s*['\"][^'\"]*backend/src/(services/graph-store|services/graph-merge|services/graph-checkpoint|routes/contribution)" -- src 2>/dev/null || true)
if [ -n "$bad" ]; then
  echo "[zk-delta-emergent] FAIL — client (src/) imports a SERVER-ONLY service:"
  echo "$bad" | sed 's/^/    /'
  exit 1
fi

if [ "$todo" -gt 0 ]; then
  echo "[zk-delta-emergent] NOT YET — $todo node(s) unbuilt; built nodes + boundary are green. Keep walking."
  exit 1
fi
echo "[zk-delta-emergent] PASS — EmergentDB-primary per-endpoint store is real + tested + boundary-honest"
