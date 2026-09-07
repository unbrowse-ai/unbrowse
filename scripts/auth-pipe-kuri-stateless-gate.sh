#!/usr/bin/env bash
# auth-pipe-kuri-stateless-gate — runnable witness for "auth via piping works AND
# kuri is stateless in the submodule." Exit 0 iff BOTH hold, with the load-bearing
# tests actually RUNNING (not skipped):
#   - kuri stateless: the in-process FFI lib builds and the real kuri-ffi tests
#     (fetch+render in-process, no daemon, no globals) execute and pass.
#   - auth via piping: the stateless auth-proxy + sealed-fill + the W5/W6-gated
#     end-to-end auth-capture cases run and pass (cookie->keychain only, pointer-only,
#     canary never leaks, sealed inventory ref).
set -uo pipefail
cd "$(dirname "$0")/.."
fail=0

echo "=== build the stateless kuri FFI lib so the real in-process tests RUN (not skip) ==="
SUFFIX=dylib; [ "$(uname)" = Linux ] && SUFFIX=so
LIB="submodules/kuri/zig-out/lib/libkuri_ffi.$SUFFIX"
if [ ! -f "$LIB" ]; then
  ( cd submodules/kuri && zig build ffi ) >/tmp/kuri-ffi-build.log 2>&1 || { echo "  FAIL — kuri ffi build failed:"; tail -5 /tmp/kuri-ffi-build.log | sed 's/^/    /'; fail=1; }
fi
if [ -f "$LIB" ]; then echo "  ok — stateless lib present: $LIB"; else echo "  FAIL — stateless lib missing (kuri-ffi tests would skip = unverified)"; fail=1; fi

echo "=== run auth-pipe + stateless + kuri-ffi tests end-to-end (W5/W6 gated cases ON) ==="
TESTS=(
  tests/kuri-ffi.test.ts
  tests/stateless-mode.test.ts
  tests/sealed-fill.test.ts
  tests/v7-stateless-execute-auth-proxy.test.ts
  tests/v7-cli-breath-execute-auth-proxy.test.ts
)
UNBROWSE_W5W6_READY=1 bun test "${TESTS[@]}" >/tmp/auth-kuri-test.log 2>&1 || fail=1
tail -6 /tmp/auth-kuri-test.log | sed 's/^/    /'
# A pass with the kuri lib present means the 2 skipIf(!haveLib) in-process tests ran.
if grep -qE '[1-9][0-9]* fail' /tmp/auth-kuri-test.log; then echo "  FAIL — test failures above"; fail=1; fi

echo
if [ "$fail" -ne 0 ]; then echo "[auth-pipe-kuri-stateless-gate] NOT YET — auth-piping or kuri-stateless not verified."; exit 1; fi
echo "[auth-pipe-kuri-stateless-gate] PASS — auth via piping works AND kuri is stateless (real in-process + e2e tests green)."
