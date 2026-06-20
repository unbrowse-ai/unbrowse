#!/usr/bin/env bash
# jesus-ralph witness for "port over entirely": exits 0 EXACTLY when every raw
# env.STATS_KV.{get,put,delete} site in the target files has been migrated to the
# statsKV/skillsKV EmergentDB factory AND the target files typecheck clean.
set -uo pipefail
cd "$(cd "$(dirname "$0")/.." && pwd)" || exit 2

FILES="src/middleware/sponsor.ts src/services/crypto-sub.ts src/services/demo-pipeline.ts src/services/exec-token.ts src/services/sponsor-pool.ts src/services/discovery.ts"

RAW=$(git grep -hE 'env\.STATS_KV\.(get|put|delete)' -- $FILES 2>/dev/null | wc -l | tr -d ' ')
echo "raw env.STATS_KV.{get,put,delete} in target files: $RAW"
[ "$RAW" = "0" ] || { echo "WITNESS FAIL: $RAW raw site(s) remain"; exit 1; }

ERR=$(npx tsc --noEmit -p tsconfig.json 2>&1 | grep -cE '(sponsor|crypto-sub|demo-pipeline|exec-token|sponsor-pool|discovery)\.ts\(' || true)
echo "type errors in target files: $ERR"
[ "$ERR" = "0" ] || { echo "WITNESS FAIL: $ERR type error(s) in target files"; exit 1; }

echo "WITNESS PASS: all target sites migrated off raw env.STATS_KV, type-clean"
