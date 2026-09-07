#!/usr/bin/env bash
# Falsifier for W-STALE-ENDPOINT-PAGE-FALLBACK: the 401/403 path must
# reach the SSR fast-path (libcurl-impersonate via Kuri sandbox)
# BEFORE returning the staleEndpointResult envelope to the agent.
#
# Live regression source: .bench-gate/20260520T025154Z probes 012/013
# (reddit r/programming, r/singularity) returned RETRIEVE_FAIL_ERROR_BODY
# with `{"error":"stale_endpoint","status_code":403}` after
# auth_recovery_retry. The existing 5xx ssr-fastpath path at
# src/execution/index.ts L3787 covered 404/429/5xx but NOT 401/403,
# so the same page-fetch recovery wasn't tried.
#
# Structural assertion: a step name `4xx_ssr_fastpath_fallback` (or
# the `_success`/`_kuri_unavailable`/`_extract_empty`/`_error`
# sub-states from CLAUDE.md decision-trace convention) is pushed on
# the decisionTrace when the recovery path runs for 401/403.
#
# Run: bash tests/w-stale-endpoint-page-fallback-wired.test.sh
set -uo pipefail

PASS=0; FAIL=0
log() { printf "%s\n" "$*" >&2; }
ok()  { PASS=$((PASS+1)); log "  ok    $1"; }
err() { FAIL=$((FAIL+1)); log "  FAIL  $1: $2"; }

SUT="src/execution/index.ts"

# Falsifier: a 4xx step name appears in decisionTrace pushes
if zigrep "4xx_ssr_fastpath_fallback" "$SUT" >/dev/null 2>&1; then
  ok "step-name-4xx-ssr-fastpath: decisionTrace step present for 401/403 path"
else
  err "step-name-4xx-ssr-fastpath" "no '4xx_ssr_fastpath_fallback' step; W-STALE-ENDPOINT-PAGE-FALLBACK not wired"
fi


log ""
log "PASS=$PASS FAIL=$FAIL"
exit $((FAIL > 0 ? 1 : 0))
