#!/usr/bin/env bash
# Falsifier seed for plan-v15 Tier 2C (Kasada sensor solver).
# Mirrors tests/px-bundle-replay-shape.test.sh.
# Pins structural correctness of src/execution/kasada-challenge.ts.
set -u

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
KS="$ROOT/src/execution/kasada-challenge.ts"
FAILED=0

pass() { printf "PASS %s\n" "$1"; }
fail() { printf "FAIL %s — %s\n" "$1" "$2"; FAILED=1; }

# 1. File exists and >2KB
if [ -f "$KS" ]; then
  size=$(wc -c < "$KS" | tr -d ' ')
  if [ "$size" -gt 2048 ]; then
    pass "kasada_file_exists_and_gt_2kb"
  else
    fail "kasada_file_exists_and_gt_2kb" "size=$size <= 2048"
  fi
else
  fail "kasada_file_exists_and_gt_2kb" "$KS missing"
  exit 1
fi

# 2. Exports extractKasadaBundleUrl
if grep -qE '^export[[:space:]]+(async[[:space:]]+)?function[[:space:]]+extractKasadaBundleUrl\b' "$KS"; then
  pass "exports_extractKasadaBundleUrl"
else
  fail "exports_extractKasadaBundleUrl" "no 'export function extractKasadaBundleUrl'"
fi

# 3. Exports solveKasadaAndRetry
if grep -qE '^export[[:space:]]+(async[[:space:]]+)?function[[:space:]]+solveKasadaAndRetry\b' "$KS"; then
  pass "exports_solveKasadaAndRetry"
else
  fail "exports_solveKasadaAndRetry" "no 'export function solveKasadaAndRetry'"
fi

# 4. Exports interfaces SolveKasadaRetryInput + SolveKasadaRetryResult
if grep -qE '^export[[:space:]]+interface[[:space:]]+SolveKasadaRetryInput\b' "$KS"; then
  pass "exports_interface_SolveKasadaRetryInput"
else
  fail "exports_interface_SolveKasadaRetryInput" "no 'export interface SolveKasadaRetryInput'"
fi
if grep -qE '^export[[:space:]]+interface[[:space:]]+SolveKasadaRetryResult\b' "$KS"; then
  pass "exports_interface_SolveKasadaRetryResult"
else
  fail "exports_interface_SolveKasadaRetryResult" "no 'export interface SolveKasadaRetryResult'"
fi

# 5. 1024-byte minimum bundle gate
if grep -qE '\.length[[:space:]]*<[[:space:]]*1024\b' "$KS"; then
  pass "bundle_min_1024_gate"
else
  fail "bundle_min_1024_gate" "no '.length < 1024' bundle gate"
fi

# 6. 30_000ms default timeout
if grep -qE '30_000\b' "$KS"; then
  pass "default_timeout_30000ms"
else
  fail "default_timeout_30000ms" "no 30_000 default timeout literal"
fi

# 7. Cookie gate on x-kpsdk-cd
if grep -q 'x-kpsdk-cd' "$KS"; then
  pass "cookie_gate_x_kpsdk_cd"
else
  fail "cookie_gate_x_kpsdk_cd" "no x-kpsdk-cd cookie reference"
fi

# 8. References runBundleReplay
if grep -q 'runBundleReplay' "$KS"; then
  pass "references_runBundleReplay"
else
  fail "references_runBundleReplay" "no runBundleReplay reference"
fi

# 9. Self-verify pre-gate (selfVerify or x-kpsdk-block detection)
if grep -qE 'selfVerify|x-kpsdk-block' "$KS"; then
  pass "self_verify_pre_gate"
else
  fail "self_verify_pre_gate" "no selfVerify or x-kpsdk-block detection"
fi

# 10. >=3 known Kasada path patterns in extractor regex
HITS=0
grep -q 'kasada' "$KS" && HITS=$((HITS+1))
grep -q 'ips\.js' "$KS" && HITS=$((HITS+1))
grep -q '/x/' "$KS" && HITS=$((HITS+1))
if [ "$HITS" -ge 3 ]; then
  pass "kasada_path_patterns_ge_3"
else
  fail "kasada_path_patterns_ge_3" "only $HITS/3 path patterns found"
fi

# 11. At least one TODO marker
if grep -q 'TODO' "$KS"; then
  pass "has_todo_marker"
else
  fail "has_todo_marker" "no TODO marker (stub status)"
fi

# 12. References kuri.evaluateInPage OR comment naming JS-sensor fallback
if grep -qE 'kuri\.evaluateInPage|JS sensor|live JS sensor|evaluateInPage' "$KS"; then
  pass "kuri_evaluateInPage_or_js_sensor_note"
else
  fail "kuri_evaluateInPage_or_js_sensor_note" "no kuri.evaluateInPage or JS-sensor fallback note"
fi

# 13. Typecheck clean
if (cd "$ROOT" && bunx tsc --noEmit src/execution/kasada-challenge.ts) >/dev/null 2>&1; then
  pass "typecheck_clean"
else
  fail "typecheck_clean" "bunx tsc --noEmit failed"
fi

# Step 5 fix pin: hasKpsdkHeaderToken (header-shaped token gate, in addition to cookie-shaped)
if grep -q 'hasKpsdkHeaderToken' "$KS"; then pass "step5_header_token_gate"
else fail "step5_header_token_gate" "hasKpsdkHeaderToken removed/renamed"; fi
if [ "$FAILED" -ne 0 ]; then
  printf "\nFAILED — kasada-challenge.ts shape regressed\n"
  exit 1
fi
printf "\nALL PASS\n"
exit 0
