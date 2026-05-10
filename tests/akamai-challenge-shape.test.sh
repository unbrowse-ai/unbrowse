#!/usr/bin/env bash
# Falsifier for plan-v15 Tier 2A Akamai stub (src/execution/akamai-challenge.ts).
# Pins structural correctness of the Land-step stub so a future "real impl"
# refactor can't silently drop required exports, gates, or the TODO marker.
set -u

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
AK="$ROOT/src/execution/akamai-challenge.ts"
CF="$ROOT/src/execution/cf-challenge.ts"
FAILED=0

pass() { printf "PASS %s\n" "$1"; }
fail() { printf "FAIL %s — %s\n" "$1" "$2"; FAILED=1; }

# 1. File exists and >2KB
if [ -f "$AK" ]; then
  size=$(wc -c < "$AK" | tr -d ' ')
  if [ "$size" -gt 2048 ]; then pass "file_exists_and_min_size:$size"
  else fail "file_exists_and_min_size" "size=$size <= 2048"; fi
else
  fail "file_exists_and_min_size" "$AK missing"; exit 1
fi

# 2. exports extractAkamaiBundleUrl
if grep -qE '^export[[:space:]]+function[[:space:]]+extractAkamaiBundleUrl\b' "$AK"; then
  pass "exports_extractAkamaiBundleUrl"
else fail "exports_extractAkamaiBundleUrl" "no 'export function extractAkamaiBundleUrl' in $AK"; fi

# 3. exports solveAkamaiAndRetry (async)
if grep -qE '^export[[:space:]]+async[[:space:]]+function[[:space:]]+solveAkamaiAndRetry\b' "$AK"; then
  pass "exports_solveAkamaiAndRetry"
else fail "exports_solveAkamaiAndRetry" "no 'export async function solveAkamaiAndRetry' in $AK"; fi

# 4. exports interfaces SolveAkamaiRetryInput + SolveAkamaiRetryResult
if grep -qE '^export[[:space:]]+interface[[:space:]]+SolveAkamaiRetryInput\b' "$AK" \
  && grep -qE '^export[[:space:]]+interface[[:space:]]+SolveAkamaiRetryResult\b' "$AK"; then
  pass "exports_interfaces"
else fail "exports_interfaces" "missing SolveAkamaiRetryInput or SolveAkamaiRetryResult export"; fi

# 5. 1024-byte minimum bundle gate
if grep -q '1024' "$AK"; then pass "min_bundle_size_gate_1024"
else fail "min_bundle_size_gate_1024" "no '1024' literal in $AK"; fi

# 6. 15_000ms default timeout
if grep -qE '15_000|15000' "$AK"; then pass "default_timeout_15000"
else fail "default_timeout_15000" "no 15_000 / 15000 literal in $AK"; fi

# 7. Cookie gate on _abck
if grep -q '_abck' "$AK"; then pass "cookie_gate_abck"
else fail "cookie_gate_abck" "no '_abck' reference in $AK"; fi

# 8. References runBundleReplay
if grep -q 'runBundleReplay' "$AK"; then pass "references_runBundleReplay"
else fail "references_runBundleReplay" "no runBundleReplay reference in $AK"; fi

# 9. Imports from same module CF imports from (sandbox/bundle-replay-client.js)
CF_IMPORT=$(grep -oE 'from[[:space:]]+"[^"]*bundle-replay-client[^"]*"' "$CF" | head -1)
AK_IMPORT=$(grep -oE 'from[[:space:]]+"[^"]*bundle-replay-client[^"]*"' "$AK" | head -1)
if [ -n "$CF_IMPORT" ] && [ "$CF_IMPORT" = "$AK_IMPORT" ]; then
  pass "import_parity_with_cf"
else fail "import_parity_with_cf" "cf=$CF_IMPORT akamai=$AK_IMPORT"; fi

# 10. At least one TODO comment (proves stub status)
if grep -q 'TODO' "$AK"; then pass "has_todo_marker"
else fail "has_todo_marker" "no TODO comment — stub may have silently become 'real'"; fi

# 11. Regex matches a synthetic Akamai bundle URL — Step 8 fix: source uses widened token class [a-z0-9._-] not hex-only
PROBE_HTML='<script src="/akam-abc123.js">'
if grep -qE '\\/akam-\[a-z0-9\._-\]\+\\\.js' "$AK" && \
   printf '%s' "$PROBE_HTML" | grep -qE '/akam-[a-z0-9._-]+\.js'; then
  pass "regex_matches_synthetic_bundle_url"
else fail "regex_matches_synthetic_bundle_url" "akam-<token>.js widened regex not present or doesn't match probe"; fi

# 12. Typecheck clean
if (cd "$ROOT" && bunx tsc --noEmit src/execution/akamai-challenge.ts) >/dev/null 2>&1; then
  pass "typecheck_clean"
else fail "typecheck_clean" "bunx tsc --noEmit src/execution/akamai-challenge.ts failed"; fi

if [ "$FAILED" -ne 0 ]; then printf "\nFAILED\n"; exit 1; fi
printf "\nALL PASS\n"
exit 0
