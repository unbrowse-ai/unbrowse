#!/usr/bin/env bash
# Falsifier for plan-v9 Phase A — SSR fast-path wired into capture pipeline.
#
# The patched insertion at src/execution/index.ts ~L1254-1283 mutates
# domArtifactEndpoint/domArtifactResult upstream so both downstream returns
# (quality_note + no_endpoints) honor the SSR override. Test asserts the
# structural shape exists; a future edit that removes/regresses it bites.
#
# Run: bash tests/phase-a-ssr-fastpath-wired.test.sh
set -uo pipefail

PASS=0; FAIL=0
log() { printf "%s\n" "$*" >&2; }
ok()  { PASS=$((PASS+1)); log "  ok    $1"; }
err() { FAIL=$((FAIL+1)); log "  FAIL  $1: $2"; }

SUT="src/execution/index.ts"

# Falsifier 1: dom-artifact locals are `let` (mutable) so SSR override works
if zigrep "let domArtifactEndpoint" "$SUT" >/dev/null 2>&1; then
  ok "let-binding[domArtifactEndpoint]: mutable for SSR override"
else
  err "let-binding[domArtifactEndpoint]" "expected 'let domArtifactEndpoint' for SSR mutation; revert risk"
fi

if zigrep "let domArtifactResult" "$SUT" >/dev/null 2>&1; then
  ok "let-binding[domArtifactResult]: mutable for SSR override"
else
  err "let-binding[domArtifactResult]" "expected 'let domArtifactResult' for SSR mutation; revert risk"
fi

# Falsifier 2: the SSR fast-path gate condition is present
# Must check: cleanEndpoints.length === 0 + (no endpoint OR no result OR quality_note)
if zigrep "cleanEndpoints.length === 0 && " "$SUT" | zigrep "domArtifactEndpoint" >/dev/null 2>&1; then
  ok "ssr-gate-condition: cleanEndpoints empty + missing-artifact gate present"
else
  err "ssr-gate-condition" "SSR insertion gate condition missing; Phase A regressed"
fi

# Falsifier 3: helper is called with the right call shape
if zigrep "trySsrFastPathOnBlock" "$SUT" >/dev/null 2>&1; then
  ok "helper-call: trySsrFastPathOnBlock invoked from execution/index.ts"
else
  err "helper-call" "trySsrFastPathOnBlock not invoked; Phase A wire-up gone"
fi

# Falsifier 4: must have at least 2 callers (Phase D 5xx + Phase A capture-fallback)
n_callers=$(zigrep -c "trySsrFastPathOnBlock" "$SUT" 2>&1 | tail -1)
# zigrep -c returns "<file>:<count>" or just "<count>"; extract last number
n_callers=$(printf '%s' "$n_callers" | sed -E 's/.*[: ]([0-9]+)$/\1/')
if [ "${n_callers:-0}" -ge 3 ]; then
  # 1 import + 1 (Phase D 5xx) + 1 (Phase A capture) = 3 minimum
  ok "caller-count: $n_callers references (import + 2 call sites)"
else
  err "caller-count" "expected >=3 references (import + 2 callers); got $n_callers"
fi

# Falsifier 5: the success path mutates BOTH local and pageArtifact
# (so both downstream returns at L1343 quality_note and L1383 no_endpoints honor it)
if zigrep "pageArtifact.endpoint = ssrArtifact.endpoint" "$SUT" >/dev/null 2>&1; then
  ok "mutation[pageArtifact.endpoint]: SSR override propagates to pageArtifact"
else
  err "mutation[pageArtifact.endpoint]" "missing pageArtifact mutation; downstream returns won't honor SSR"
fi

if zigrep "delete pageArtifact.quality_note" "$SUT" >/dev/null 2>&1; then
  ok "clear[quality_note]: SSR success clears quality_note marker"
else
  err "clear[quality_note]" "quality_note not cleared; quality_note return at L1343 still fires after SSR success"
fi

# Falsifier 6: try-catch wraps the helper call (helper failure must be non-fatal)
if zigrep "ssr_fastpath_capture_fallback_error\|ssr_fastpath_capture_fallback_success" "$SUT" >/dev/null 2>&1; then
  ok "decision-trace: ssr_fastpath_capture_fallback_* log signals present (CLAUDE.md naming convention)"
else
  err "decision-trace" "ssr_fastpath_capture_fallback_* log signals missing (CLAUDE.md naming convention)"
fi

# Falsifier 7: file still compiles (sanity check via bun -c)
if bun -e 'import("./src/execution/index.ts").then(() => process.exit(0)).catch(() => process.exit(1))' >/dev/null 2>&1; then
  ok "compile: src/execution/index.ts imports cleanly"
else
  err "compile" "src/execution/index.ts has compile/import errors"
fi

# --- Adversarial defenses (Step 5) ---
# What stops a CF challenge HTML / empty stub from being published as a real skill?

# Defense 1: byte-length threshold rejects sub-1KB stubs
if zigrep "ssr.html.length > 1024" "$SUT" >/dev/null 2>&1; then
  ok "adversarial[byte-threshold]: SSR HTML must clear 1024-byte floor"
else
  err "adversarial[byte-threshold]" "missing 'ssr.html.length > 1024' guard"
fi

# Defense 2: ssrArtifact.endpoint AND ssrArtifact.result both required
if zigrep "ssrArtifact.endpoint && ssrArtifact.result" "$SUT" >/dev/null 2>&1; then
  ok "adversarial[double-gate]: both endpoint AND result required for SSR override"
else
  err "adversarial[double-gate]" "missing 'ssrArtifact.endpoint && ssrArtifact.result' double-gate"
fi

# Defense 3: SSR HTML routes through buildPageArtifactCapture (which calls validateExtractionQuality)
if zigrep "buildPageArtifactCapture(url, intent, ssr.html" "$SUT" >/dev/null 2>&1; then
  ok "adversarial[quality-gate-routing]: SSR HTML routes through buildPageArtifactCapture (calls validateExtractionQuality)"
else
  err "adversarial[quality-gate-routing]" "manual artifact construction would bypass validateExtractionQuality"
fi

# Defense 4: try-catch present + error decision-trace marker
if zigrep "ssr_fastpath_capture_fallback_error" "$SUT" >/dev/null 2>&1; then
  ok "adversarial[exception-safety]: error decision-trace marker implies catch is present"
else
  err "adversarial[exception-safety]" "no error decision-trace marker — catch may not exist"
fi

# Edge: SSR fires only when cleanEndpoints.length === 0 AND artifact missing/poor
if zigrep "Plan-v9 Phase A" "$SUT" -A 2 2>&1 | zigrep "cleanEndpoints.length === 0 && " >/dev/null 2>&1; then
  ok "edge[gate-precondition]: SSR fires only when cleanEndpoints empty AND artifact missing/poor"
else
  err "edge[gate-precondition]" "gate precondition shape regressed — SSR may waste calls or never fire"
fi

log ""
log "phase-a-ssr-fastpath-wired.test.sh: PASS=$PASS FAIL=$FAIL"
[ "$FAIL" -eq 0 ] || exit 1
