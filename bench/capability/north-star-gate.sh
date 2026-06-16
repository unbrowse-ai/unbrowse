#!/usr/bin/env bash
# north-star-gate: the BINDING witness for the capability north star. Runs each named axis against
# the npm-installed CLI / its real witnesses and aggregates a coverage %. Exits 0 only at >=95%.
set -uo pipefail
cd "$(dirname "$0")/../.." || exit 2
export UNBROWSE_BIN="${UNBROWSE_BIN:-$(command -v unbrowse)}"
pass=0; total=0
axis() { local name="$1"; shift; total=$((total+1)); if timeout 150 "$@" >/tmp/ns_axis.log 2>&1; then echo "  PASS  $name"; pass=$((pass+1)); else echo "  FAIL  $name"; fi; }

echo "── north-star axes (npm CLI: $UNBROWSE_BIN @ $($UNBROWSE_BIN --version 2>/dev/null)) ──"
axis "cache-key (method+body, idempotency)"      bun bench/capability/test_cache_key.ts
axis "cache cascade persist+replay"              bun bench/capability/test_persistent_cascade_walk.ts
axis "graphql (cli-flag-and-graphql)"            bun test tests/cli-flag-and-graphql.test.ts
axis "graphql drift envelope"                    bun test tests/drift-recovery-graphql-envelope-also.test.ts
axis "grpc (holes)"                              bun bench/capability/test_grpc_holes.ts
axis "x402 signer"                               bun test tests/base-x402-signer.test.ts
axis "x402 client-search"                        bun test tests/client-search-x402.test.ts
axis "storage seal (disk e2e)"                   bun bench/capability/test_seal_snapshot_disk_e2e.ts
axis "storage seal (ac3)"                        bun bench/capability/test_ac3_seal_e2e.ts
axis "indexing (browse-index)"                   bun test tests/browse-index.test.ts
axis "indexing (proof-of-indexing)"             bun test tests/proof-of-indexing.test.ts
axis "auth cookie-principal"                     bun bench/capability/test_cookie_principal.ts
axis "{param} url-hole guard"                    bun bench/capability/test_param_leak_guard.ts
axis "de-hatching residuals"                     bash bench/capability/residuals-gate.sh

pct=$(awk -v p="$pass" -v t="$total" 'BEGIN{printf "%.1f", t? p/t*100 : 0}')
echo "── coverage: $pass/$total = ${pct}% (threshold 95%) ──"
awk -v p="$pass" -v t="$total" 'BEGIN{exit !(t && p/t>=0.95)}' && { echo "NORTH-STAR-GATE: PASS"; exit 0; } || { echo "NORTH-STAR-GATE: FAIL"; exit 1; }
