#!/usr/bin/env bash
# Falsifiable signal for --judge-inline emit (bench-two-phase.sh).
#
# Asserts that when JUDGE_INLINE=1 a synthetic row JSON triggers a
# `### URL` markdown block to stderr containing the intent, bucket,
# phase1 status, phase2 shape (when present), and excerpt.
#
# Lost-sheep edge: excerpts containing quotes, backslashes, and
# unicode must not crash the embedded python f-string.
#
# Run: bash tests/judge-inline.test.sh
set -uo pipefail

PASS=0
FAIL=0
log()  { printf "%s\n" "$*" >&2; }
ok()   { PASS=$((PASS+1)); log "  ok    $1"; }
err()  { FAIL=$((FAIL+1)); log "  FAIL  $1"; }

# Reproduce the bench's inline-emit fragment in isolation. Same code as
# scripts/bench-two-phase.sh's per-row emit, but reading a row from
# stdin and emitting only when JUDGE_INLINE=1.
emit_row() {
  local row="$1"; local mode="$2"
  printf '%s' "$row" | JUDGE_INLINE="$mode" python3 -c "
import sys, json, os
d = json.loads(sys.stdin.read())
if os.environ.get('JUDGE_INLINE') == '1':
    excerpt = (d.get('phase2_response_excerpt') or '')[:800]
    block = []
    block.append(f\"### {d.get('url','?')}\")
    block.append(f'  intent:   {d.get(\"goal\",\"\")}')
    block.append(f\"  bucket:   {d.get('triage_bucket','?')}\")
    block.append(f'  phase1:   status={d[\"phase1_status\"]} eps={d[\"phase1_endpoints_discovered\"]} skill={d.get(\"phase1_skill_id\",\"\")[:12]}')
    if d.get('phase2_ran'):
        block.append(f'  phase2:   sc={d.get(\"phase2_status_code\",\"\") or \"-\"} shape={d.get(\"phase2_result_shape\",\"\") or \"-\"} bytes={d.get(\"phase2_response_bytes\",0)}')
    err = d.get('phase2_error','')
    if err:
        block.append(f'  err:      {err[:200]}')
    if excerpt:
        block.append(f'  excerpt:  {excerpt}')
    block.append('')
    print('\\n'.join(block), file=sys.stderr)
" 2>&1
}

# ── Test 1: golden row with phase2 ran ────────────────────────────
ROW1='{"url":"https://example.com/x","goal":"get example data","triage_bucket":"a_inspect_response_body","phase1_status":"indexed","phase1_endpoints_discovered":3,"phase1_skill_id":"abc12345xyz","phase2_ran":true,"phase2_status_code":"200","phase2_result_shape":"array[5]","phase2_response_bytes":1234,"phase2_response_excerpt":"[{\"title\":\"first\"},{\"title\":\"second\"}]"}'
OUT1=$(emit_row "$ROW1" 1)
echo "$OUT1" | grep -q '### https://example.com/x' && ok "T1: ### URL header" || err "T1: missing ### URL header"
echo "$OUT1" | grep -q 'intent:.*get example data'  && ok "T1: intent line"      || err "T1: missing intent line"
echo "$OUT1" | grep -q 'bucket:.*a_inspect_response_body' && ok "T1: bucket line" || err "T1: missing bucket line"
echo "$OUT1" | grep -q 'phase1:.*indexed.*eps=3'    && ok "T1: phase1 line"      || err "T1: missing phase1"
echo "$OUT1" | grep -q 'phase2:.*sc=200.*shape=array\[5\]' && ok "T1: phase2 line" || err "T1: missing phase2"
echo "$OUT1" | grep -q 'excerpt:.*first.*second'    && ok "T1: excerpt line"     || err "T1: missing excerpt"

# ── Test 2: JUDGE_INLINE=0 → no emit ──────────────────────────────
OUT2=$(emit_row "$ROW1" 0)
if [ -z "$OUT2" ]; then
  ok "T2: silent when JUDGE_INLINE=0"
else
  err "T2: emitted output when JUDGE_INLINE=0 (expected silence)"
fi

# ── Test 3: phase2 skipped row ────────────────────────────────────
ROW3='{"url":"https://blocked.example/","goal":"search","triage_bucket":"y_phase2_skipped","phase1_status":"vendor_blocked","phase1_endpoints_discovered":0,"phase1_skill_id":"","phase2_ran":false,"phase2_response_excerpt":""}'
OUT3=$(emit_row "$ROW3" 1)
echo "$OUT3" | grep -q '### https://blocked.example' && ok "T3: header on phase2-skipped row" || err "T3: header missing"
echo "$OUT3" | grep -q 'phase2:' && err "T3: phase2 line should NOT appear when phase2_ran=false" || ok "T3: phase2 line correctly absent"

# ── Test 4 (LOST SHEEP): excerpt with quotes, backslashes, unicode ───
ROW4='{"url":"https://unicode.example/","goal":"get listings","triage_bucket":"a_inspect_response_body","phase1_status":"indexed","phase1_endpoints_discovered":1,"phase1_skill_id":"u","phase2_ran":true,"phase2_status_code":"200","phase2_result_shape":"object{title}","phase2_response_bytes":99,"phase2_response_excerpt":"{\"title\":\"hello \\\"world\\\" — Türk café 中文 \\\\ tail\"}"}'
OUT4=$(emit_row "$ROW4" 1)
echo "$OUT4" | grep -q '### https://unicode.example' && ok "T4: lost-sheep header" || err "T4: lost-sheep header"
echo "$OUT4" | grep -q 'Türk café' && ok "T4: unicode preserved" || err "T4: unicode dropped"
echo "$OUT4" | grep -q 'Traceback' && err "T4: python crashed on quoted/unicode excerpt" || ok "T4: no python traceback on adversarial excerpt"

# ── Summary ───────────────────────────────────────────────────────
log ""
log "Ran $((PASS+FAIL)) tests: $PASS pass, $FAIL fail"
[ "$FAIL" -eq 0 ] || exit 1
exit 0
