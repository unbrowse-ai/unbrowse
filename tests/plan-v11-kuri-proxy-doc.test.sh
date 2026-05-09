#!/usr/bin/env bash
# Falsifier for plan-v11-kuri-proxy.md — the spec doc for the Kuri Zig PR
# that wires CURLOPT_PROXY into sandbox/curl_lib.zig.
#
# This is a SPEC doc, not code. The actual implementation lives in a
# separate repo (`submodules/kuri/`). Falsifier asserts the spec carries
# every required structural element so a future edit can't silently
# delete or weaken the spec.
#
# Run: bash tests/plan-v11-kuri-proxy-doc.test.sh
set -uo pipefail

DOC="plan-v11-kuri-proxy.md"
PASS=0; FAIL=0
log() { printf "%s\n" "$*" >&2; }
ok()  { PASS=$((PASS+1)); log "  ok    $1"; }
err() { FAIL=$((FAIL+1)); log "  FAIL  $1: $2"; }

# Falsifier 1: doc exists
if [ -f "$DOC" ]; then
  ok "doc-exists: $DOC present"
else
  err "doc-exists" "$DOC missing — spec was deleted"
  exit 1
fi

# Falsifier 2: cross-repo boundary called out
if grep -E "submodules/kuri" "$DOC" >/dev/null 2>&1 && grep -E "separate Zig PR|Lives in the Kuri repo|not unbrowse" "$DOC" >/dev/null 2>&1; then
  ok "cross-repo-boundary: explicitly states Kuri-side work, not unbrowse"
else
  err "cross-repo-boundary" "spec doesn't make the cross-repo nature obvious; future readers may assume it's an unbrowse change"
fi

# Falsifier 3: 3 Kuri files named as targets
for target in "curl_lib.zig" "handler.zig" "network.zig"; do
  if grep -E "$target" "$DOC" >/dev/null 2>&1; then
    ok "file-target[$target]: named in surface section"
  else
    err "file-target[$target]" "Kuri file target missing from spec"
  fi
done

# Falsifier 4: CURLOPT constants documented
if grep -E "CURLOPT_PROXY" "$DOC" >/dev/null 2>&1; then
  ok "curl-opt-name: CURLOPT_PROXY (10004) named"
else
  err "curl-opt-name" "core libcurl option name missing"
fi

# Falsifier 5: 5 Zig test fixtures specified
if grep -E "passthrough|env fallback|per-request override|invalid proxy" "$DOC" >/dev/null 2>&1; then
  ok "test-fixtures: 5 Zig test fixtures named"
else
  err "test-fixtures" "test section incomplete — fixtures missing"
fi

# Falsifier 6: smoke section with 3 outcomes
if grep -E "Three outcomes|3 outcomes|three possible outcomes" "$DOC" >/dev/null 2>&1; then
  ok "smoke-outcomes: 3-outcome decision rule documented"
else
  err "smoke-outcomes" "smoke decision rule missing — readers won't know how to interpret smoke result"
fi

# Falsifier 7: cost estimate present
if grep -E "120 LoC|2-3 hr|~120" "$DOC" >/dev/null 2>&1; then
  ok "cost-estimate: 2-3hr / ~120 LoC budget cited"
else
  err "cost-estimate" "cost estimate missing — readers can't size the work"
fi

# Falsifier 8: predicted unlock numbers cited
if grep -E "6-8 sites|combined unlock|Predicted" "$DOC" >/dev/null 2>&1; then
  ok "predicted-unlock: bench-impact estimate cited"
else
  err "predicted-unlock" "no bench-impact estimate; ROI invisible"
fi

# Falsifier 9: cross-reference to plan-v10 Phase B already shipped
if grep -E "e5aabdaf|already shipped|plan-v10 Phase B" "$DOC" >/dev/null 2>&1; then
  ok "phase-b-cross-ref: plan-v10 Phase B reactivation documented"
else
  err "phase-b-cross-ref" "doesn't link to existing plan-v10 Phase B; future loops may forget the dependency"
fi

# Falsifier 10: IProyal creds source named (memory file)
if grep -E "iproyal|IProyal|reference_iproyal_proxy" "$DOC" >/dev/null 2>&1; then
  ok "creds-source: IProyal residential proxy creds source named"
else
  err "creds-source" "smoke test can't run without creds; source must be cited"
fi

# Falsifier 11: re-trigger conditions documented
if grep -E "Re-trigger conditions|This plan revives" "$DOC" >/dev/null 2>&1; then
  ok "re-trigger-conditions: revival path documented"
else
  err "re-trigger-conditions" "no documented path to revive this plan; future loops may not know when to act"
fi

# Falsifier 12: what-if-not-done section (zero-regression claim)
if grep -E "What if Kuri PR doesn't happen|harmless|No regression" "$DOC" >/dev/null 2>&1; then
  ok "graceful-degradation: zero-regression-without-Kuri claim documented"
else
  err "graceful-degradation" "doesn't address what happens if Kuri PR never lands"
fi

log ""
log "plan-v11-kuri-proxy-doc.test.sh: PASS=$PASS FAIL=$FAIL"
[ "$FAIL" -eq 0 ] || exit 1
