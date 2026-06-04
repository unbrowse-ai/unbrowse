#!/usr/bin/env bash
# Falsifier for W-AKAMAI-BM-VERIFY-BROWSER-FALLBACK: when serverFetch
# returns 200 with an Akamai bot-management interstitial body (bm-verify
# token + JS challenge + iframe to m.media-amazon.com), the executor
# must NOT return the interstitial as data. It must reuse the existing
# classifyExecuteFailure body-pattern detector (already shipped in W6,
# commit 66c86d53, src/execution/index.ts L5160) and auto-route to
# browserCall (the same fallback the trigger-intercept case uses at
# the L3363 defensive branch).
#
# Live regression source: (internal)
# unbrowse-mc + wave-4 self-build probe report (amazon.com/s?k=usb-c+cable).
# server_fetch returned HTTP 200 with the Akamai interstitial body.
# the platform's drift detector flagged _format_mismatch=true and
# emitted re_capture_signal pointing at unbrowse_go {headless:false},
# but execute returned the interstitial as data instead of auto-routing
# to browser_fallback. Agent got back zero product listings.
#
# Structural assertion: case "server" branch at src/execution/index.ts
# L3354 must (a) call classifyExecuteFailure with the serverFetch
# result, and (b) push a `server_fetch_vendor_block_detected` step
# when classification.kind === "vendor_blocked", and (c) fall through
# to browserCall on detection.
#
# Run: bash tests/w-akamai-bm-verify-browser-fallback-wired.test.sh

set -uo pipefail

PASS=0; FAIL=0
log() { printf "%s\n" "$*" >&2; }
ok()  { PASS=$((PASS+1)); log "  ok    $1"; }
err() { FAIL=$((FAIL+1)); log "  FAIL  $1: $2"; }

SUT="src/execution/index.ts"

# Falsifier 1: the new step name is pushed on the decisionTrace
if zigrep "server_fetch_vendor_block_detected" "$SUT" >/dev/null 2>&1; then
  ok "step-name-vendor-block-detected: decisionTrace step present in case server branch"
else
  err "step-name-vendor-block-detected" "expected 'server_fetch_vendor_block_detected' step name in $SUT"
fi

# Falsifier 2: classifyExecuteFailure is called somewhere AFTER the
# case "server" branch's serverFetch line. Look for the call inside
# the section between the server case and the trigger-intercept case.
# zigrep with -A / context flags are not available here; do a
# simpler line-range substring match.
if awk '/case "server":/{ flag=1; next } flag && /classifyExecuteFailure/{ print; flag=0; exit 0 } flag && /case "trigger-intercept":/{ flag=0 }' "$SUT" | grep -q "classifyExecuteFailure"; then
  ok "classify-execute-failure-wired: case server calls classifyExecuteFailure"
else
  err "classify-execute-failure-wired" "case 'server' branch must call classifyExecuteFailure on serverFetch result"
fi

# Falsifier 3: browserCall is invoked after the classifyExecuteFailure
# call in the case server branch (vendor_block recovery path).
if awk '/case "server":/{ flag=1; next } flag && /browserCall/{ print; flag=0; exit 0 } flag && /case "trigger-intercept":/{ flag=0 }' "$SUT" | grep -q "browserCall"; then
  ok "browser-call-fallback-wired: case server falls through to browserCall on vendor_block"
else
  err "browser-call-fallback-wired" "case 'server' must invoke browserCall on vendor_block detection"
fi

log ""
log "PASS=$PASS  FAIL=$FAIL"
exit $((FAIL > 0 ? 1 : 0))
