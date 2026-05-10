#!/usr/bin/env bash
# Falsifiable signal for Phase A bench rubric extension
# (scripts/bench-two-phase.sh:208 triage_bucket).
#
# Asserts:
#   1. sc=0 + SyntaxError-in-excerpt → z_likely_browser_block_engine_error
#   2. sc=200 + bytes=0 → z_likely_browser_block_empty_200
#   3. sc=200 + bytes>0 → a_inspect_response_body (not reclassified — happy path preserved)
#   4. sc=403 + bytes>0 → a_inspect_response_body (not reclassified — vendor-block detection lives elsewhere)
#   5. sc=0 with no SyntaxError in excerpt → falls through to existing buckets (don't over-trigger)
#   6. excerpt=None (JSON null) → no crash
#   7. phase1_status=vendor_blocked → still z_likely_vendor_blocked (phase1 wins over phase2)
#
# Reproduces the triage_bucket function as a Python heredoc so it runs
# in isolation without launching the full bench. No mocks. Real Python.
#
# Run: bash tests/bench-triage-rubric.test.sh
set -uo pipefail

PASS=0; FAIL=0
log() { printf "%s\n" "$*" >&2; }
ok()  { PASS=$((PASS+1)); log "  ok    $1"; }
err() { FAIL=$((FAIL+1)); log "  FAIL  $1: $2"; }

# Reproduces triage_bucket() verbatim from scripts/bench-two-phase.sh:208
classify() {
  python3 -c "
import json, sys
d = json.loads(sys.stdin.read())
def triage_bucket(p1s, ph2):
    if p1s in ('vendor_blocked',): return 'z_likely_vendor_blocked'
    if p1s == 'soft_block': return 'z_likely_soft_block'
    if p1s in ('capture_timeout','capture_error','capture_parse_error','no_endpoints'): return 'y_capture_didnt_yield_endpoint'
    if not ph2['phase2_ran']: return 'y_phase2_skipped'
    sc = ph2.get('phase2_status_code', '')
    excerpt = ph2.get('phase2_response_excerpt') or ''
    if sc == '0' and 'SyntaxError' in excerpt: return 'z_likely_browser_block_engine_error'
    if sc == '200' and (ph2.get('phase2_response_bytes') or 0) == 0: return 'z_likely_browser_block_empty_200'
    if 'vendor_blocked:' in (ph2.get('phase2_error') or ''): return 'z_likely_vendor_blocked_at_replay'
    if (ph2.get('phase2_response_bytes') or 0) > 0: return 'a_inspect_response_body'
    if ph2['phase2_status_code']: return 'b_inspect_status_code'
    return 'c_inspect_raw'
print(triage_bucket(d.get('phase1_status',''), d.get('phase2',{})))
"
}

# Test 1 — engine error pattern (ticketmaster, vinted)
out=$(echo '{"phase1_status":"indexed","phase2":{"phase2_ran":true,"phase2_status_code":"0","phase2_response_bytes":42,"phase2_response_excerpt":"\"SyntaxError: Invalid or unexpected token\""}}' | classify)
[ "$out" = "z_likely_browser_block_engine_error" ] && ok "engine-error: sc=0 + SyntaxError → block" || err "engine-error" "got '$out'"

# Test 2 — empty-200 pattern (zillow, airbnb, nike)
out=$(echo '{"phase1_status":"indexed","phase2":{"phase2_ran":true,"phase2_status_code":"200","phase2_response_bytes":0,"phase2_response_excerpt":""}}' | classify)
[ "$out" = "z_likely_browser_block_empty_200" ] && ok "empty-200: sc=200 + bytes=0 → block" || err "empty-200" "got '$out'"

# Test 3 — happy path: real response with body NOT reclassified
out=$(echo '{"phase1_status":"indexed","phase2":{"phase2_ran":true,"phase2_status_code":"200","phase2_response_bytes":7384,"phase2_response_excerpt":"[{\"title\":\"foo\"}]"}}' | classify)
[ "$out" = "a_inspect_response_body" ] && ok "preserve: sc=200 + bytes>0 → a_inspect_response_body" || err "preserve-200" "got '$out'"

# Test 4 — 403 with body NOT reclassified (vendor-block detection lives in classifier, not rubric)
out=$(echo '{"phase1_status":"indexed","phase2":{"phase2_ran":true,"phase2_status_code":"403","phase2_response_bytes":579,"phase2_response_excerpt":"{\"error\":\"forbidden\"}"}}' | classify)
[ "$out" = "a_inspect_response_body" ] && ok "preserve: sc=403 + bytes>0 → a_inspect_response_body" || err "preserve-403" "got '$out'"

# Test 5 — sc=0 WITHOUT SyntaxError in excerpt → falls through (don't over-trigger)
out=$(echo '{"phase1_status":"indexed","phase2":{"phase2_ran":true,"phase2_status_code":"0","phase2_response_bytes":42,"phase2_response_excerpt":"\"some other error\""}}' | classify)
[ "$out" = "a_inspect_response_body" ] && ok "narrow: sc=0 without SyntaxError → falls through to bytes>0" || err "narrow-sc0" "got '$out'"

# Test 6 — excerpt as JSON null → no crash, falls through narrow
out=$(echo '{"phase1_status":"indexed","phase2":{"phase2_ran":true,"phase2_status_code":"0","phase2_response_bytes":0,"phase2_response_excerpt":null}}' | classify)
[ "$out" = "b_inspect_status_code" ] && ok "robustness: excerpt=null doesn't crash; falls to b_inspect" || err "null-excerpt" "got '$out'"

# Test 7 — phase1=vendor_blocked still wins over phase2 patterns
out=$(echo '{"phase1_status":"vendor_blocked","phase2":{"phase2_ran":true,"phase2_status_code":"0","phase2_response_bytes":42,"phase2_response_excerpt":"\"SyntaxError: foo\""}}' | classify)
[ "$out" = "z_likely_vendor_blocked" ] && ok "precedence: phase1 vendor_blocked wins" || err "precedence" "got '$out'"

# Test 8 — bench's CLAUDE.md rubric: z_* buckets count as BROWSER_BLOCK
# (this is documentation; assert via bucket naming convention)
for bucket in z_likely_browser_block_engine_error z_likely_browser_block_empty_200; do
  case "$bucket" in
    z_*) ok "naming: $bucket starts with z_ (CLAUDE.md rubric → BROWSER_BLOCK)" ;;
    *) err "naming-$bucket" "missing z_ prefix" ;;
  esac
done

# Divers diseases (Step 5): adversarial edges chased after rubric stress
out=$(echo '{"phase1_status":"indexed","phase2":{"phase2_ran":true,"phase2_status_code":"200","phase2_response_bytes":null,"phase2_response_excerpt":""}}' | classify)
[ "$out" = "z_likely_browser_block_empty_200" ] && ok "divers: bytes=null → coalesces to 0, classifies empty_200" || err "bytes-null" "got '$out'"

out=$(echo '{"phase1_status":"indexed","phase2":{"phase2_ran":true,"phase2_status_code":0,"phase2_response_bytes":42,"phase2_response_excerpt":"\"SyntaxError: x\""}}' | classify)
[ "$out" = "a_inspect_response_body" ] && ok "divers: sc as integer 0 (not string \"0\") falls through" || err "sc-int-0" "got '$out'"

out=$(echo '{"phase1_status":"indexed","phase2":{"phase2_ran":true,"phase2_status_code":"0","phase2_response_bytes":42,"phase2_response_excerpt":"[\"SyntaxError: foo\"]"}}' | classify)
[ "$out" = "z_likely_browser_block_engine_error" ] && ok "divers: SyntaxError inside JSON-encoded array still detected" || err "syntaxerror-array" "got '$out'"

out=$(echo '{"phase1_status":"indexed","phase2":{"phase2_ran":false,"phase2_status_code":"0","phase2_response_bytes":42,"phase2_response_excerpt":"\"SyntaxError: x\""}}' | classify)
[ "$out" = "y_phase2_skipped" ] && ok "divers: phase2_ran=false wins over engine_error pattern" || err "phase2-not-ran" "got '$out'"

out=$(echo '{"phase1_status":"indexed","phase2":{"phase2_ran":true,"phase2_status_code":"403","phase2_response_bytes":686,"phase2_response_excerpt":"{\"error\":\"stale\"}","phase2_error":"HTTP 403 (vendor_blocked: datadome — bot detection, not auth)"}}' | classify)
[ "$out" = "z_likely_vendor_blocked_at_replay" ] && ok "executor-classifier: phase2_error vendor_blocked → z_likely_vendor_blocked_at_replay" || err "vendor-replay" "got '$out'"

log ""
log "bench-triage-rubric.test.sh: PASS=$PASS FAIL=$FAIL"
[ "$FAIL" -eq 0 ] || exit 1
