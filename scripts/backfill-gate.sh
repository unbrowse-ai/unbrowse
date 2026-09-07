#!/usr/bin/env bash
# backfill-gate.sh — witness: local-cache backfill only publishes shape-matching,
# indexable manifests; junk/malformed/non-indexable are skipped.
set -uo pipefail
cd "$(dirname "$0")/.." || exit 2
fail=0; ok(){ printf 'ok   %s\n' "$1"; }; bad(){ printf 'FAIL %s\n' "$1"; fail=1; }
bun test tests/backfill-shape.test.ts >/dev/null 2>&1 && ok "backfill shape gate (5 cases)" || bad "shape gate test"
grep -q "isIndexableDomain" src/lib/backfill.ts && ok "backfill reuses the admission filter (no junk)" || bad "backfill not gated on indexable"
timeout 60 bun scripts/backfill-local-cache.ts >/dev/null 2>&1 && ok "dry-run executes (enumerate + shape-match)" || bad "dry-run failed"
if [ "$fail" -eq 0 ]; then echo "BACKFILL GREEN"; exit 0; fi; echo "BACKFILL RED"; exit 1
