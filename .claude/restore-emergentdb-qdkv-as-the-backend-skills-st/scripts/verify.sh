#!/bin/bash
# verify.sh - http-curl matrix for restore-emergentdb-qdkv harness.
#
# Collects RAW evidence from the deployed backend. Agent judges in-thread
# whether the responses reflect EdbKV-primary work (not PgKV). No PASS/FAIL
# regex on response bodies.
#
# Lanes:
#   L1 typecheck        - structural validity (preflight, fails closed on tsc errors)
#   L2 tests            - bun test on the touched services (preflight)
#   L3 stats summary    - /v1/stats/summary returns plausible non-zero counts
#   L4 graph direct     - api.emergentdb.com/graph/search returns vectors
#   L5 backend search   - /v1/search (anonymous global) returns content
#   L6 kv backend probe - /v1/ops/kv-backend (if it exists) reports backend type

set -uo pipefail
cd "$(dirname "$0")/../../.."
export PLAN=restore-emergentdb-qdkv-as-the-backend-skills-st
export SCAFFOLD="$(cd "$(dirname "$0")/.." && pwd)"
TS=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
EVIDENCE="$SCAFFOLD/ledgers/verify-evidence.jsonl"
mkdir -p "$SCAFFOLD/ledgers"

BASE_URL="${UNBROWSE_API_URL:-https://beta-api.unbrowse.ai}"
EDB_KEY="${EMERGENTDB_API_KEY:-$(zigrep -E '^EMERGENTDB_API_KEY' .env 2>/dev/null | head -1 | cut -d= -f2 | tr -d '"')}"

emit() {
  local lane="$1"; local payload="$2"
  echo "$payload" | python3 -c "import sys,json; d=json.loads(sys.stdin.read()); d['lane']='$lane'; d['ts']='$TS'; d['plan']='$PLAN'; print(json.dumps(d))" >> "$EVIDENCE"
  echo "  [$lane] $payload" | head -c 500; echo
}

FAILED=0

# L1: typecheck backend
echo "[verify:$PLAN] L1 typecheck backend"
bun --bun tsc --noEmit -p backend/tsconfig.json 2>&1 | tee "$SCAFFOLD/ledgers/L1-tsc.log" | tail -5
TSC_RC=${PIPESTATUS[0]}
emit L1-tsc "{\"exit_code\":$TSC_RC,\"check\":\"backend tsc noEmit\"}"
[[ $TSC_RC -ne 0 ]] && FAILED=1

# L2: targeted bun tests
echo "[verify:$PLAN] L2 targeted bun tests"
TEST_OUT="$SCAFFOLD/ledgers/L2-tests.log"
( cd backend && bun test ./tests/skills-trust-promotion.test.ts ./tests/skills-publish-proofs.test.ts ./tests/proof-verifier.test.ts ./tests/x402-skill-route.test.ts ./tests/protected-routes-auth.test.ts 2>&1 | tail -40 ) | tee "$TEST_OUT"
TEST_RC=${PIPESTATUS[0]}
emit L2-tests "{\"exit_code\":$TEST_RC,\"check\":\"backend targeted tests\"}"
[[ $TEST_RC -ne 0 ]] && FAILED=1

# L3: stats summary
echo "[verify:$PLAN] L3 GET $BASE_URL/v1/stats/summary"
STATS=$(curl -s --max-time 15 "$BASE_URL/v1/stats/summary" || echo '{"error":"curl_failed"}')
emit L3-stats "{\"check\":\"stats summary\",\"response_excerpt\":$(echo "$STATS" | python3 -c 'import json,sys; print(json.dumps(sys.stdin.read()[:400]))')}"

# L4: direct EmergentDB graph probe
if [[ -n "$EDB_KEY" ]]; then
  echo "[verify:$PLAN] L4 POST api.emergentdb.com/graph/search"
  EDB=$(curl -s --max-time 15 -X POST https://api.emergentdb.com/graph/search \
    -H "Authorization: Bearer $EDB_KEY" -H "Content-Type: application/json" \
    -d '{"namespace":"v2-news.ycombinator.com","domain":"news.ycombinator.com","query":"top stories","limit":3}' \
    || echo '{"error":"curl_failed"}')
  emit L4-edb-graph "{\"check\":\"emergentdb v2 namespace probe\",\"response_excerpt\":$(echo "$EDB" | python3 -c 'import json,sys; print(json.dumps(sys.stdin.read()[:400]))')}"
else
  emit L4-edb-graph '{"check":"skipped","reason":"no EMERGENTDB_API_KEY"}'
fi

# L5: backend search (anonymous global path)
echo "[verify:$PLAN] L5 POST $BASE_URL/v1/search"
SEARCH=$(curl -s --max-time 15 -X POST "$BASE_URL/v1/search" \
  -H "Content-Type: application/json" \
  -d '{"intent":"top stories","k":5}' || echo '{"error":"curl_failed"}')
emit L5-search "{\"check\":\"backend global search anonymous\",\"response_excerpt\":$(echo "$SEARCH" | python3 -c 'import json,sys; print(json.dumps(sys.stdin.read()[:400]))')}"

# L6: kv-backend probe
echo "[verify:$PLAN] L6 GET $BASE_URL/v1/ops/kv-backend"
ADMIN=$(zigrep -E '^UNBROWSE_ADMIN_KEY' .env 2>/dev/null | head -1 | cut -d= -f2 | tr -d '"')
if [[ -n "$ADMIN" ]]; then
  KV=$(curl -s --max-time 10 -H "Authorization: Bearer $ADMIN" "$BASE_URL/v1/ops/kv-backend" || echo '{"error":"curl_failed"}')
else
  KV='{"check":"skipped","reason":"no UNBROWSE_ADMIN_KEY"}'
fi
emit L6-kv-backend "{\"check\":\"kvBackend() reported backend\",\"response_excerpt\":$(echo "$KV" | python3 -c 'import json,sys; print(json.dumps(sys.stdin.read()[:400]))')}"

echo ""
echo "[verify:$PLAN] evidence -> $EVIDENCE"
echo "[verify:$PLAN] last 6 evidence rows for agent in-thread judgment:"
tail -6 "$EVIDENCE"

# Exit code reflects ONLY structural preflight (L1+L2). L3-L6 are evidence
# the agent judges in-thread per substrate principle; they never auto-decide.
exit $FAILED
