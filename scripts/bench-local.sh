#!/usr/bin/env bash
# bench-local.sh — fast iteration harness for the corpus, run locally.
#
# Each URL runs against the installed unbrowse binary. Per-URL result is saved
# to .bench-local/URL.json; final summary written to .bench-local/summary.json.
# Classifier runs as an external Python script so stdin plumbing is simple.
#
# Usage:
#   bash scripts/bench-local.sh                      # full baseline corpus
#   bash scripts/bench-local.sh --offset 5 --size 5  # rows 6-10
#   bash scripts/bench-local.sh --corpus-file F      # override
set -uo pipefail

CORPUS="scripts/corpus/benchmark-baseline.txt"
OFFSET=0
SIZE=0
TIMEOUT=90
CLI_CMD="unbrowse"
for arg in "$@"; do
  case "$arg" in
    --corpus-file) shift; CORPUS="${1:-}"; shift || true ;;
    --offset) shift; OFFSET="${1:-0}"; shift || true ;;
    --size) shift; SIZE="${1:-0}"; shift || true ;;
    --timeout) shift; TIMEOUT="${1:-90}"; shift || true ;;
    --use-source) shift; CLI_CMD="bun src/cli.ts" ;;
  esac
done

OUT_DIR=".bench-local"
rm -rf "$OUT_DIR"
mkdir -p "$OUT_DIR"

# Classifier + per-URL record builder in one script
cat > "$OUT_DIR/classify.py" <<'PY'
import sys, json, re
out_path = sys.argv[1]
goal = sys.argv[2]
url = sys.argv[3]
raw = open(out_path).read()
d = {}
for m in re.finditer(r'\{"(?:trace|result|error|skill_id)"', raw):
    try:
        d, _ = json.JSONDecoder(strict=False).raw_decode(raw[m.start():])
        break
    except Exception:
        continue
r = d.get('result', {}) if isinstance(d, dict) else {}
trace = d.get('trace', {}) if isinstance(d, dict) else {}
source = d.get('source', '') if isinstance(d, dict) else ''
verdict = 'fail'
error_code = ''
error_message = ''
# PASS signals:
#   a) resolve returned available_operations/available_endpoints for agent to pick
#   b) direct-fetch short-circuit: trace.success == true with source == "direct-fetch"
#      and a non-error result (raw data, no explicit error field)
if isinstance(r, dict) and (r.get('available_operations') or r.get('available_endpoints')):
    verdict = 'pass'
elif (source == 'direct-fetch' or trace.get('skill_id') == 'direct-fetch') and trace.get('success') is True and not (isinstance(r, dict) and r.get('error')):
    verdict = 'pass'
else:
    # Extract error for classification
    error_code = r.get('error','') if isinstance(r, dict) else (d.get('error','') if isinstance(d, dict) else '')
    error_message = r.get('message','') if isinstance(r, dict) else ''
    BLOCK_ERRORS = {'auth_required','capture_failed','kuri_crash','connection_failed','browser_block'}
    if error_code in BLOCK_ERRORS:
        verdict = 'block'
    elif re.search(r'kuri failed to start|capture failed|cloudflare|challenge|just a moment', error_message, re.I):
        verdict = 'block'
    # Strong auth-wall signals only — not the generic weasel-word fallback
    # "may require authentication" which unbrowse uses for ANY no_endpoints case
    elif error_code == 'no_endpoints' and re.search(r'please sign in|please log in|login required|authentication required|401 unauthorized|403 forbidden', error_message, re.I):
        verdict = 'block'
    # low_quality_dom_extraction with 'confidence too low' = browser-level
    # degradation (anti-bot serving a weak page, progressive JS not executed).
    # Distinct from 'message_only' which means our extractor came up empty on a
    # page that should have had API data (that's a product fail).
    elif error_code == 'low_quality_dom_extraction' and re.search(r'confidence too low', error_message, re.I):
        verdict = 'block'
print(json.dumps({
    'goal': goal,
    'url': url,
    'verdict': verdict,
    'error_code': error_code,
    'error_message': error_message[:500],
}))
PY

if [ ! -f "$CORPUS" ]; then
  echo "[bench-local] no corpus at $CORPUS" >&2
  exit 1
fi

SLICE=$(mktemp)
if [ "$SIZE" -gt 0 ]; then
  tail -n "+$((OFFSET+1))" "$CORPUS" | head -n "$SIZE" > "$SLICE"
else
  tail -n "+$((OFFSET+1))" "$CORPUS" > "$SLICE"
fi

N=$(wc -l < "$SLICE" | tr -d ' ')
echo "[bench-local] running $N URLs, timeout=${TIMEOUT}s" >&2

pkill -9 -f 'unbrowse|kuri' 2>/dev/null || true
sleep 0.3

i=0
> "$OUT_DIR/results.jsonl"
while IFS='|' read -r goal url; do
  [ -z "$url" ] && continue
  i=$((i+1))
  slug=$(printf '%s' "$url" | tr '/:?&=.' '_')
  out_file="$OUT_DIR/${i}_${slug:0:60}.out"
  echo "[bench-local] ($i/$N) $url" >&2
  timeout "$TIMEOUT" $CLI_CMD resolve --intent "$goal" --url "$url" </dev/null > "$out_file" 2>&1 || true
  record=$(python3 "$OUT_DIR/classify.py" "$out_file" "$goal" "$url")
  verdict=$(printf '%s' "$record" | python3 -c "import sys,json; print(json.loads(sys.stdin.read())['verdict'])")
  echo "[bench-local]   → $verdict" >&2
  echo "$record" >> "$OUT_DIR/results.jsonl"
  pkill -9 -f 'unbrowse|kuri' 2>/dev/null || true
  sleep 0.3
done < "$SLICE"

rm -f "$SLICE"

# Aggregate
python3 - "$OUT_DIR/results.jsonl" <<'PY'
import sys, json
rows = [json.loads(l) for l in open(sys.argv[1]) if l.strip()]
p = sum(1 for r in rows if r['verdict']=='pass')
f = sum(1 for r in rows if r['verdict']=='fail')
b = sum(1 for r in rows if r['verdict']=='block')
u = sum(1 for r in rows if r['verdict']=='upstream')
rate = round(100*p/(p+f), 1) if (p+f) > 0 else 0
summary = {
    'total': len(rows),
    'pass': p,
    'fail': f,
    'block': b,
    'upstream': u,
    'product_success_rate': rate,
    'per_url': rows,
}
json.dump(summary, open('.bench-local/summary.json', 'w'), indent=2)
print(json.dumps(summary, indent=2))
print(f"\n[bench-local] pass={p} fail={f} block={b} upstream={u} rate={rate}%", file=sys.stderr)
if f > 0:
    print("[bench-local] PRODUCT FAILS:", file=sys.stderr)
    for r in rows:
        if r['verdict'] == 'fail':
            print(f"  ✗ {r['url']}  {r['error_code']} — {r['error_message'][:80]}", file=sys.stderr)
PY
