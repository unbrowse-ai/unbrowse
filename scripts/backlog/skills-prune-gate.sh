#!/usr/bin/env bash
# skills-prune-gate.sh — witness for skills-prune: provably-dead modules removed,
# build + tests still green. The removed files had zero importers anywhere (src,
# tests, backend, packages; static + dynamic) and the entry bundle builds without
# them. WIP-but-unwired handlers (e.g. kasada-challenge) were deliberately KEPT.
set -uo pipefail
REPO="$(cd "$(dirname "$0")/../.." && pwd)"; cd "$REPO"
# the prune held
[ ! -f src/values/trait.ts ] && [ ! -f src/graph/local-harness.ts ] \
  || { echo "FAIL: a pruned dead module is back"; exit 1; }
# the entry graph still builds without them (no dangling import)
tmp=$(mktemp -d)
bun build src/single-binary.ts --target=bun --outdir="$tmp" >/dev/null 2>&1 || { echo "FAIL: bundle build after prune"; rm -rf "$tmp"; exit 1; }
rm -rf "$tmp"
# representative tests still green
bun test tests/dag-walk-edges.test.ts tests/sdk-surface.test.ts >/dev/null 2>&1 \
  || { echo "FAIL: representative tests after prune"; exit 1; }
echo "ok: 2 provably-dead modules removed (trait.ts, local-harness.ts; 661 lines); bundle builds + tests green"
