#!/usr/bin/env bash
# Falsifiable signal for the bench wrapper's executable-endpoint picker
# (scripts/bench-two-phase.sh:298-326).
#
# Reproduces the picker as a function and asserts:
#   1. Lost-sheep — empty-id eps[0] + real eps[1] picks eps[1].
#   2. Verified > unverified.
#   3. Real XHR > page_fetch synthetic at equal verification.
#   4. Empty shortlist → skip_reason="phase1_zero_shortlist".
#   5. All eps empty/null id → skip_reason="no_executable_endpoint_in_shortlist".
#   6. Reliability_score tiebreak.
#
# Run: bash tests/bench-picker.test.sh
set -uo pipefail

PASS=0; FAIL=0
log() { printf "%s\n" "$*" >&2; }
ok()  { PASS=$((PASS+1)); log "  ok    $1"; }
err() { FAIL=$((FAIL+1)); log "  FAIL  $1: $2"; }

pick() {
  printf '%s' "$1" | python3 -c "
import json, sys
sl = json.loads(sys.stdin.read()) if sys.stdin else []
def score(ep):
    if not isinstance(ep, dict): return -1
    eid = ep.get('endpoint_id')
    if not isinstance(eid, str) or not eid.strip(): return -1
    s = 0
    if ep.get('verification_status') == 'verified': s += 100
    dom = ep.get('dom_extraction') or {}
    if (dom.get('extraction_method') or '') != 'page_fetch': s += 50
    try: s += float(ep.get('reliability_score') or 0) * 10
    except: pass
    return s
candidates = [(score(ep), i, ep) for i, ep in enumerate(sl) if isinstance(ep, dict)]
candidates = [c for c in candidates if c[0] >= 0]
candidates.sort(key=lambda c: (-c[0], c[1]))
if candidates:
    print(candidates[0][2].get('endpoint_id') or '')
    print('')
else:
    print('')
    print('phase1_zero_shortlist' if not sl else 'no_executable_endpoint_in_shortlist')
"
}

out=$(pick '[{"endpoint_id":"","verification_status":"verified","dom_extraction":{"extraction_method":"page_fetch"}},{"endpoint_id":"ep_real","verification_status":"verified","reliability_score":0.8}]')
ep=$(printf '%s' "$out" | sed -n '1p'); rsn=$(printf '%s' "$out" | sed -n '2p')
[ "$ep" = "ep_real" ] && ok "lost-sheep: skip empty-id, pick real" || err "lost-sheep" "expected ep_real got '$ep'"
[ -z "$rsn" ] && ok "lost-sheep: no skip_reason when picked" || err "lost-sheep reason" "expected empty got '$rsn'"

out=$(pick '[{"endpoint_id":"ep_unv","verification_status":"unknown"},{"endpoint_id":"ep_ver","verification_status":"verified"}]')
ep=$(printf '%s' "$out" | sed -n '1p')
[ "$ep" = "ep_ver" ] && ok "precedence: verified > unverified" || err "verified-precedence" "got '$ep'"

out=$(pick '[{"endpoint_id":"ep_pf","verification_status":"verified","dom_extraction":{"extraction_method":"page_fetch"}},{"endpoint_id":"ep_xhr","verification_status":"verified","dom_extraction":{"extraction_method":"json"}}]')
ep=$(printf '%s' "$out" | sed -n '1p')
[ "$ep" = "ep_xhr" ] && ok "precedence: real-XHR > page_fetch synthetic" || err "extraction-precedence" "got '$ep'"

out=$(pick '[]')
ep=$(printf '%s' "$out" | sed -n '1p'); rsn=$(printf '%s' "$out" | sed -n '2p')
[ -z "$ep" ] && ok "empty: returns empty endpoint" || err "empty-ep" "got '$ep'"
[ "$rsn" = "phase1_zero_shortlist" ] && ok "empty: phase1_zero_shortlist reason" || err "empty-reason" "got '$rsn'"

out=$(pick '[{"endpoint_id":"","verification_status":"verified"},{"endpoint_id":null,"verification_status":"verified"}]')
ep=$(printf '%s' "$out" | sed -n '1p'); rsn=$(printf '%s' "$out" | sed -n '2p')
[ -z "$ep" ] && ok "no-ids: empty endpoint" || err "no-ids-ep" "got '$ep'"
[ "$rsn" = "no_executable_endpoint_in_shortlist" ] && ok "no-ids: skip_reason" || err "no-ids-reason" "got '$rsn'"

out=$(pick '[{"endpoint_id":"ep_low","verification_status":"verified","reliability_score":0.2},{"endpoint_id":"ep_high","verification_status":"verified","reliability_score":0.9}]')
ep=$(printf '%s' "$out" | sed -n '1p')
[ "$ep" = "ep_high" ] && ok "tiebreak: higher reliability wins" || err "reliability-tiebreak" "got '$ep'"

# Divers-diseases (Step 5): adversarial / non-string id / malformed input
out=$(pick '[{"endpoint_id":12345,"verification_status":"verified"}]')
ep=$(printf '%s' "$out" | sed -n '1p'); rsn=$(printf '%s' "$out" | sed -n '2p')
[ -z "$ep" ] && [ "$rsn" = "no_executable_endpoint_in_shortlist" ] && ok "adversarial: numeric endpoint_id rejected" || err "numeric-eid" "ep=$ep rsn=$rsn"

out=$(pick '[{"endpoint_id":"   ","verification_status":"verified"}]')
ep=$(printf '%s' "$out" | sed -n '1p'); rsn=$(printf '%s' "$out" | sed -n '2p')
[ -z "$ep" ] && [ "$rsn" = "no_executable_endpoint_in_shortlist" ] && ok "adversarial: whitespace-only id rejected" || err "whitespace-eid" "ep='$ep' rsn=$rsn"

out=$(pick '[null,{"endpoint_id":"ok","verification_status":"verified"}]')
ep=$(printf '%s' "$out" | sed -n '1p')
[ "$ep" = "ok" ] && ok "edge: null entries in shortlist tolerated" || err "null-entry" "got '$ep'"

out=$(pick '[{"endpoint_id":"unicode_é","verification_status":"verified"}]')
ep=$(printf '%s' "$out" | sed -n '1p')
[ "$ep" = "unicode_é" ] && ok "edge: unicode endpoint_id round-trips" || err "unicode-eid" "got '$ep'"

log ""
log "bench-picker.test.sh: PASS=$PASS FAIL=$FAIL"
[ "$FAIL" -eq 0 ] || exit 1
