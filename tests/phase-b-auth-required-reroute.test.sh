#!/usr/bin/env bash
# Falsifier for plan-v10 Phase B — auth_required SSR-reroute when capture
# saw an anti-bot vendor marker. The patched insertion at
# src/execution/index.ts:1033-1093 wraps the existing auth_required return
# with a vendor-detection gate + libcurl-impersonate fallback.
#
# This test grep-asserts every structural element the patch must carry.
# A future edit that removes any of them gets caught here.
#
# Run: bash tests/phase-b-auth-required-reroute.test.sh
set -uo pipefail

SUT="src/execution/index.ts"
PASS=0; FAIL=0
log() { printf "%s\n" "$*" >&2; }
ok()  { PASS=$((PASS+1)); log "  ok    $1"; }
err() { FAIL=$((FAIL+1)); log "  FAIL  $1: $2"; }

# Falsifier 1: vendor-marker regex covers the 6 documented vendor families
for vendor in "captcha-delivery" "cdn-cgi" "datadome" "perimeterx" "kasada" "akamai-bot"; do
  if zigrep "$vendor" "$SUT" >/dev/null 2>&1; then
    ok "vendor-marker[$vendor]: present in B.2 heuristic"
  else
    err "vendor-marker[$vendor]" "missing — vendor-detection gate weakened"
  fi
done

# Falsifier 2: the gate variable name is preserved so future readers can grep it
if zigrep "hasVendorChallenge" "$SUT" >/dev/null 2>&1; then
  ok "gate-variable: hasVendorChallenge present"
else
  err "gate-variable" "hasVendorChallenge identifier removed; B.2 gate erased"
fi

# Falsifier 3: helper call routes through trySsrFastPathOnBlock (3rd caller)
n_callers=$(zigrep -c "trySsrFastPathOnBlock" "$SUT" 2>&1 | sed -E 's/.*[: ]([0-9]+)$/\1/')
if [ "${n_callers:-0}" -ge 4 ]; then
  ok "caller-count: $n_callers references (import + 3 callers minimum)"
else
  err "caller-count" "expected >=4 references (import + Phase A + Phase B + Phase D-5xx); got $n_callers"
fi

# Falsifier 4: SSR success path mutates captured.html (so downstream sees the libcurl HTML)
if zigrep '(captured as { html?: string }).html = ssr.html' "$SUT" >/dev/null 2>&1; then
  ok "captured-html-override: SSR success rewrites captured.html for downstream extractEndpoints"
else
  err "captured-html-override" "missing captured.html override on SSR success — downstream won't see libcurl HTML"
fi

# Falsifier 5: decision-trace step name follows CLAUDE.md naming convention (plan-v5 #5)
for marker in "auth_required_ssr_reroute_success" "auth_required_ssr_reroute_failed_extraction_quality" "auth_required_ssr_reroute_failed_no_html" "auth_required_ssr_reroute_skipped_no_vendor_signal" "auth_required_ssr_reroute_error"; do
  if zigrep "$marker" "$SUT" >/dev/null 2>&1; then
    ok "decision-trace[$marker]: present"
  else
    err "decision-trace[$marker]" "marker missing — naming convention violated or path silenced"
  fi
done

# Falsifier 6: fall-through preserves auth_required when SSR fails / no vendor signal
# (the inner if-guard checks captured.html actually got overridden)
if zigrep "If SSR didn't unlock OR no vendor signal" "$SUT" >/dev/null 2>&1; then
  ok "fallthrough-comment: explicit comment marks fall-through path"
else
  err "fallthrough-comment" "fall-through comment missing; future readers may miss this path"
fi

# Falsifier 7: existing auth_required result shape preserved (provider, login_url, message)
if zigrep "provider: getRegistrableDomain(finalDomain)" "$SUT" >/dev/null 2>&1; then
  ok "auth-result-shape: provider/login_url/message preserved on real-auth path"
else
  err "auth-result-shape" "auth_required result shape changed — agent contract broken"
fi

# Falsifier 8: 1024-byte threshold (matches plan-v9 Phase A defense)
if zigrep "ssr.html.length > 1024" "$SUT" >/dev/null 2>&1; then
  ok "byte-threshold: SSR HTML >1024 bytes required (consistent with Phase A)"
else
  err "byte-threshold" "missing 1024-byte threshold; CF challenge stubs could leak through"
fi

# Falsifier 9: routes through buildPageArtifactCapture (calls validateExtractionQuality)
if zigrep "buildPageArtifactCapture(url, intent, ssr.html, false)" "$SUT" >/dev/null 2>&1; then
  ok "quality-gate-routing: SSR HTML routes through buildPageArtifactCapture (calls validateExtractionQuality)"
else
  err "quality-gate-routing" "manual artifact construction would bypass validateExtractionQuality"
fi

# Falsifier 10: compile check
if bun -e 'import("./src/execution/index.ts").then(() => process.exit(0)).catch(() => process.exit(1))' >/dev/null 2>&1; then
  ok "compile: src/execution/index.ts imports cleanly"
else
  err "compile" "src/execution/index.ts has compile/import errors"
fi

log ""
log "phase-b-auth-required-reroute.test.sh: PASS=$PASS FAIL=$FAIL"
[ "$FAIL" -eq 0 ] || exit 1
