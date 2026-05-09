#!/usr/bin/env bash
# Falsifier for plan-v12 Phase B — guards the no-progress soft-deadline
# wiring from rebase drift. Structural assertions cover constant, watchdog
# timer, typed throw, cleanup pairing, and SSR rescue handler.

set -u
PASS=0
FAIL=0
TESTS_FILE="$(basename "$0")"

assert() {
  local label="$1" cmd="$2" expected="$3"
  local actual
  actual=$(eval "$cmd" 2>&1) || true
  if [[ "$actual" == "$expected" ]]; then
    PASS=$((PASS+1))
    echo "  ok    $label"
  else
    FAIL=$((FAIL+1))
    echo "  FAIL  $label"
    echo "        expected: $expected"
    echo "        actual:   $actual"
  fi
}

repo_root="$(cd "$(dirname "$0")/.." && pwd)"
cap="$repo_root/src/capture/index.ts"
exe="$repo_root/src/execution/index.ts"

# 1. CAPTURE_NO_PROGRESS_MS constant present at module scope (30s default)
assert "constant-present" \
  "grep -c '^const CAPTURE_NO_PROGRESS_MS = 30_000;' '$cap'" \
  "1"

# 2. Constant strictly less than CAPTURE_TIMEOUT_MS so the watchdog fires
#    BEFORE the overall timeout — otherwise the bail is dead code.
assert "no-progress-less-than-overall" \
  "python3 -c 'import re; s=open(\"$cap\").read(); n=int(re.search(r\"CAPTURE_NO_PROGRESS_MS = ([0-9_]+)\", s).group(1).replace(\"_\",\"\")); o=int(re.search(r\"CAPTURE_TIMEOUT_MS = ([0-9_]+)\", s).group(1).replace(\"_\",\"\")); print(\"ok\" if n<o else \"bad\")'" \
  "ok"

# 3. Constant strictly less than 60s so it fires before bench shell SIGTERM.
assert "no-progress-less-than-60s" \
  "python3 -c 'import re; s=open(\"$cap\").read(); n=int(re.search(r\"CAPTURE_NO_PROGRESS_MS = ([0-9_]+)\", s).group(1).replace(\"_\",\"\")); print(\"ok\" if n<60000 else \"bad\")'" \
  "ok"

# 4. noProgressBail flag declared inside captureSession.
assert "noProgressBail-flag-declared" \
  "grep -c 'let noProgressBail = false;' '$cap'" \
  "1"

# 5. Watchdog reads cdpRequestMap.size at fire time. The pattern appears 2x
#    in the file (pre-existing browse-checkpoint at ~L1637 + new watchdog at
#    ~L1400) — assert both exist as a dual regression guard.
assert "watchdog-checks-cdpRequestMap-size" \
  "grep -E -c 'cdpRequestMap\\.size === 0' '$cap'" \
  "2"

# 6. Constant referenced by name (not hardcoded literal). Decl + log message
#    + setTimeout call + throw template literal = 4 occurrences.
assert "named-constant-used-not-hardcoded" \
  "grep -F -c CAPTURE_NO_PROGRESS_MS '$cap'" \
  "4"

# 7. Specialized throw with code: "no_progress_bail".
assert "throw-with-typed-code" \
  "grep -E -c 'code: \"no_progress_bail\"' '$cap'" \
  "1"

# 8. Cleanup pairing: clearTimeout(noProgressHandle) sits next to clearTimeout(timeoutHandle).
assert "cleanup-pair-present" \
  "awk '/clearTimeout\\(timeoutHandle\\)/{a=NR} /clearTimeout\\(noProgressHandle\\)/{b=NR} END{ if (a>0 && b>0 && (b==a+1 || b==a-1)) print \"ok\"; else print \"bad (timeoutHandle=\" a \" noProgressHandle=\" b \")\" }' '$cap'" \
  "ok"

# 9. executeBrowserCapture catch routes err.code === "no_progress_bail" to SSR.
assert "executor-routes-no_progress_bail" \
  "grep -E -c 'err\\.code === \"no_progress_bail\"' '$exe'" \
  "1"

# 10. Catch handler imports trySsrFastPathOnBlock dynamically.
assert "catch-imports-ssr-helper" \
  "awk '/err\\.code === \"no_progress_bail\"/{f=1} f && /trySsrFastPathOnBlock/{print \"ok\"; exit}' '$exe'" \
  "ok"

# 11. Catch handler returns success on SSR rescue (not just logs).
assert "catch-returns-on-ssr-rescue-success" \
  "awk '/no_progress_bail_ssr_fastpath_success/{f=1; next} f && /return.*trace.*result.*ssrArtifact/{print \"ok\"; exit}' '$exe'" \
  "ok"

# 12. Compile check — modified files import cleanly.
assert "capture-compiles" \
  "cd '$repo_root' && bun -e 'import(\"./src/capture/index.ts\").then(()=>console.log(\"ok\")).catch(e=>console.error(e.message))' 2>&1" \
  "ok"
assert "execution-compiles" \
  "cd '$repo_root' && bun -e 'import(\"./src/execution/index.ts\").then(()=>console.log(\"ok\")).catch(e=>console.error(e.message))' 2>&1" \
  "ok"

echo ""
echo "$TESTS_FILE: PASS=$PASS FAIL=$FAIL"
[[ $FAIL -eq 0 ]]
