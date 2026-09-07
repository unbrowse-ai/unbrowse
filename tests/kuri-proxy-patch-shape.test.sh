#!/usr/bin/env bash
# Falsifier for plan-v10 Phase A / plan-v11 Kuri Zig PR — confirms the
# CURLOPT_PROXY patches are present in submodules/kuri/src/sandbox/curl_lib.zig
# and that the file still compiles via `zig build`.
#
# Lives in unbrowse so a kuri rebase doesn't silently drop the patches.
# Pre-release CI should run this; if it fails, the kuri submodule pin needs
# to be updated to a SHA that has the proxy patches.
#
# Run: bash tests/kuri-proxy-patch-shape.test.sh
set -uo pipefail

SUT="submodules/kuri/src/sandbox/curl_lib.zig"
PASS=0; FAIL=0
log() { printf "%s\n" "$*" >&2; }
ok()  { PASS=$((PASS+1)); log "  ok    $1"; }
err() { FAIL=$((FAIL+1)); log "  FAIL  $1: $2"; }

# Falsifier 1: source file exists
if [ -f "$SUT" ]; then
  ok "source-exists: $SUT present"
else
  err "source-exists" "$SUT missing — kuri submodule may be unsynced"
  exit 1
fi

# Falsifier 2: CURLOPT_PROXY constant declared with correct value (10004 from curl/curl.h)
if grep -F "CURLOPT_PROXY: CURLoption = 10004" "$SUT" >/dev/null 2>&1; then
  ok "constant: CURLOPT_PROXY = 10004 declared"
else
  err "constant" "CURLOPT_PROXY constant missing or wrong value (must be 10004)"
fi

# Falsifier 3: Request struct has optional proxy field
if grep -E "proxy: \?\[\]const u8 = null" "$SUT" >/dev/null 2>&1; then
  ok "request-field: Request.proxy optional field present"
else
  err "request-field" "Request struct missing proxy field"
fi

# Falsifier 4: perform() actually calls setopt with CURLOPT_PROXY
if grep -F "setoptCheck(easy, c.CURLOPT_PROXY" "$SUT" >/dev/null 2>&1; then
  ok "setopt-call: perform() calls setoptCheck(c.CURLOPT_PROXY, ...)"
else
  err "setopt-call" "no setopt call for CURLOPT_PROXY in perform()"
fi

# Falsifier 5: setopt call is gated on req.proxy != null (no segfault on null)
if grep -F "if (req.proxy)" "$SUT" >/dev/null 2>&1; then
  ok "null-gate: setopt only fires when req.proxy is provided"
else
  err "null-gate" "missing 'if (req.proxy)' gate — could segfault when no proxy passed"
fi

# Falsifier 6: proxy_z is z-terminated (libcurl needs C string)
if grep -F "proxy_z = try allocator.dupeZ" "$SUT" >/dev/null 2>&1; then
  ok "z-terminated: proxy URL is dupeZ'd (libcurl C string)"
else
  err "z-terminated" "proxy URL not dupeZ'd; libcurl will see garbage past the slice"
fi

# Falsifier 7: defer free of proxy_z to avoid leak
if grep -F "defer if (proxy_z)" "$SUT" >/dev/null 2>&1; then
  ok "memory-safety: proxy_z freed via defer"
else
  err "memory-safety" "proxy_z allocation not freed; will leak per request"
fi

# Falsifier 8: zig build still works (compiles after patches)
if [ -d submodules/kuri ]; then
  build_log=$(mktemp)
  if (cd submodules/kuri && zig build 2>&1) > "$build_log"; then
    ok "build: zig build succeeds"
  else
    err "build" "zig build failed — see $build_log"
  fi
  rm -f "$build_log"
fi

# Falsifier 9: built binary exists
if [ -x submodules/kuri/zig-out/bin/kuri ]; then
  ok "binary-exists: zig-out/bin/kuri produced"
else
  err "binary-exists" "kuri binary not built — zig-out/bin/kuri missing"
fi

log ""
log "kuri-proxy-patch-shape.test.sh: PASS=$PASS FAIL=$FAIL"
[ "$FAIL" -eq 0 ] || exit 1
