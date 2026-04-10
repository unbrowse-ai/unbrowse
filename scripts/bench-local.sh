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

# Ensure unbrowse is on PATH — non-login SSH shells don't source .zshrc/.bashrc
# so the npm-global bin is missing. Without this the whole bench is a no-op.
export PATH="$HOME/.npm-global/bin:/opt/nanobrew/prefix/bin:/usr/local/bin:/opt/homebrew/bin:$PATH"

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

# Per-URL evidence extractor. No verdict column — agent-in-thread judges
# by reading the CSV. The harness only extracts and presents signals that
# would inform the judgment.
cat > "$OUT_DIR/extract.py" <<'PY'
import sys, json, re
out_path = sys.argv[1]
goal = sys.argv[2]
url = sys.argv[3]
raw = open(out_path).read()

# Find the TOP-LEVEL response object. Previous version took the first
# {"trace"...} match which matched nested trace objects inside a larger
# response (e.g. the skill.endpoints[].trace nested entry) and returned
# the wrong shape. The top-level response always has BOTH trace and
# result/skill at depth 0 and is usually the biggest decoded object.
# Strategy: try every candidate match, keep the LARGEST successfully
# decoded object that has a top-level 'result' or 'available_operations'
# key — that's always the one the agent cares about.
candidates = []
for m in re.finditer(r'\{"(?:trace|result|error|skill_id)"', raw):
    try:
        obj, _ = json.JSONDecoder(strict=False).raw_decode(raw[m.start():])
        if isinstance(obj, dict):
            candidates.append((len(json.dumps(obj)), obj))
    except Exception:
        continue
# Prefer the largest candidate that has a meaningful top-level shape
candidates.sort(key=lambda x: x[0], reverse=True)
d = {}
for _, obj in candidates:
    r0 = obj.get('result') if isinstance(obj.get('result'), dict) else None
    if obj.get('available_operations') or obj.get('available_endpoints'):
        d = obj
        break
    if r0 and (r0.get('available_operations') or r0.get('available_endpoints') or r0.get('error')):
        d = obj
        break
if not d and candidates:
    d = candidates[0][1]  # fall back to the biggest

r = d.get('result', {}) if isinstance(d, dict) else {}
# Some responses (direct-fetch) put the data at top level with trace, not under "result".
# In that case, r is empty but d has trace/source/success at top.
trace = d.get('trace', {}) if isinstance(d, dict) else {}
source = d.get('source', '') if isinstance(d, dict) else ''
meta = r.get('captured_meta') if isinstance(r, dict) else None
# If the response has available_operations at top level (some shapes do), use that
top_ops = d.get('available_operations') or d.get('available_endpoints') or []
if top_ops and not r.get('available_operations') and not r.get('available_endpoints'):
    r['available_operations'] = top_ops

# Pure evidence extraction — every field the agent needs to judge in-thread.
# No classification, no verdict, no threshold checks.
row = {
    'goal': goal,
    'url': url,
    'source': source,                              # '', 'direct-fetch', 'live-capture', 'marketplace', 'cache'
    'trace_success': trace.get('success') if isinstance(trace, dict) else None,
    'trace_skill_id': trace.get('skill_id') if isinstance(trace, dict) else '',
    'has_available_operations': bool(isinstance(r, dict) and (r.get('available_operations') or r.get('available_endpoints'))),
    'n_operations': len(r.get('available_operations') or r.get('available_endpoints') or []) if isinstance(r, dict) else 0,
    'error_code': r.get('error','') if isinstance(r, dict) else (d.get('error','') if isinstance(d, dict) else ''),
    'error_message': (r.get('message','') if isinstance(r, dict) else '')[:300],
    'captured_html_bytes': (meta or {}).get('html_bytes','') if isinstance(meta, dict) else '',
    'captured_text_bytes': (meta or {}).get('text_bytes','') if isinstance(meta, dict) else '',
    'captured_title': ((meta or {}).get('title','') if isinstance(meta, dict) else '')[:100],
    'captured_api_calls': (meta or {}).get('observed_api_calls','') if isinstance(meta, dict) else '',
    'captured_intent_verdict': (meta or {}).get('intent_verdict','') if isinstance(meta, dict) else '',
    'captured_intent_reason': (meta or {}).get('intent_reason','') if isinstance(meta, dict) else '',
    'filter_rejections': json.dumps((meta or {}).get('filter_rejections', {}), sort_keys=True) if isinstance(meta, dict) else '',
    'browser_block_signals': json.dumps((meta or {}).get('browser_block_signals', []), sort_keys=True) if isinstance(meta, dict) else '',
}
print(json.dumps(row))
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
  timeout "$TIMEOUT" $CLI_CMD resolve --intent "$goal" --url "$url" </dev/null > "$out_file" 2>&1
  cli_exit=$?
  # Log exit codes so process-level failures (timeout=124, SIGKILL=137,
  # CLI crash=non-zero) are visible in the stream instead of getting
  # swallowed as "empty output → source=none".
  if [ "$cli_exit" -ne 0 ]; then
    echo "  [bench-local] cli exit=$cli_exit (timeout=124, killed=137)" >&2
  fi
  record=$(python3 "$OUT_DIR/extract.py" "$out_file" "$goal" "$url")
  echo "$record" >> "$OUT_DIR/results.jsonl"
  # Show a compact one-line evidence summary for the agent watching the run.
  # No pass/fail/block verdict — the agent reads results.jsonl / .csv at the end.
  printf '%s' "$record" | python3 -c "
import sys, json
d = json.loads(sys.stdin.read())
parts = []
if d.get('has_available_operations'): parts.append(f\"ops={d['n_operations']}\")
if d.get('source'): parts.append(f\"src={d['source']}\")
if d.get('error_code'): parts.append(f\"err={d['error_code']}\")
if d.get('captured_html_bytes') != '': parts.append(f\"html={d['captured_html_bytes']}\")
if d.get('captured_text_bytes') != '': parts.append(f\"text={d['captured_text_bytes']}\")
if d.get('captured_api_calls') != '': parts.append(f\"apis={d['captured_api_calls']}\")
if d.get('captured_title'): parts.append(f\"title={d['captured_title'][:40]!r}\")
print('  ' + ' | '.join(parts), file=sys.stderr)
"
  pkill -9 -f 'unbrowse|kuri' 2>/dev/null || true
  sleep 0.3
done < "$SLICE"

rm -f "$SLICE"

# Render the evidence CSV the agent will read. No verdict, no rate, no gate.
python3 - "$OUT_DIR/results.jsonl" <<'PY'
import sys, json, csv
rows = [json.loads(l) for l in open(sys.argv[1]) if l.strip()]
if not rows:
    print("[bench-local] no rows collected", file=sys.stderr)
    sys.exit(0)
fieldnames = list(rows[0].keys())
with open('.bench-local/evidence.csv', 'w', newline='') as f:
    w = csv.DictWriter(f, fieldnames=fieldnames)
    w.writeheader()
    for r in rows:
        w.writerow(r)
# Dump the JSONL back out as the agent-consumable artifact.
print(json.dumps({'rows': rows, 'count': len(rows)}, indent=2))
# Group rows by category using the structured signals. This is NOT a
# verdict — it's a deterministic grouping from the signals the product
# already emitted, so the agent sees a consistent denominator across runs.
# The agent still reviews each row in-thread for anything non-obvious.
from collections import defaultdict
buckets = defaultdict(list)
for r in rows:
    bs = r.get('browser_block_signals') or ''
    src = r.get('source') or ''
    has_ops = r.get('has_available_operations')
    n_ops = r.get('n_operations', 0) or 0
    trace_ok = r.get('trace_success')
    err = r.get('error_code') or ''
    # Browser-block takes precedence — the product never had a chance.
    if bs and bs != '[]' and ('vendor:' in bs or 'challenge_title' in bs):
        buckets['BROWSER_BLOCK'].append(r['url'])
    elif err == 'auth_required':
        buckets['AUTH_GATED'].append(r['url'])
    elif has_ops and n_ops > 0:
        buckets['PASS'].append(r['url'])
    elif trace_ok and src == 'dom-fallback':
        buckets['PASS'].append(r['url'])
    elif bs and 'sparse_capture_mostly_noise' in bs:
        # Ambiguous — could be browser-level, could be product. Agent decides.
        buckets['SPARSE_REVIEW'].append(r['url'])
    else:
        buckets['PRODUCT_FAIL'].append(r['url'])

total = len(rows)
passes = len(buckets['PASS'])
blocked = len(buckets['BROWSER_BLOCK']) + len(buckets['AUTH_GATED'])
reachable = total - blocked
print(f"\n[bench-local] rubric tally (agent still judges in-thread):", file=sys.stderr)
for k in ('PASS', 'PRODUCT_FAIL', 'SPARSE_REVIEW', 'BROWSER_BLOCK', 'AUTH_GATED'):
    urls = buckets.get(k, [])
    if not urls:
        continue
    print(f"  {k:<15} {len(urls):>3}", file=sys.stderr)
    for u in urls:
        print(f"    - {u}", file=sys.stderr)
if reachable > 0:
    print(f"\n[bench-local] product-reachable pass: {passes}/{reachable} ({100*passes/reachable:.0f}%)", file=sys.stderr)
print(f"[bench-local] raw pass: {passes}/{total} ({100*passes/total:.0f}%)", file=sys.stderr)
print(f"\n[bench-local] wrote {len(rows)} rows to .bench-local/evidence.csv", file=sys.stderr)
print("[bench-local] per-URL raw outputs in .bench-local/*.out", file=sys.stderr)
print("[bench-local] results.jsonl has the same rows in JSON Lines format", file=sys.stderr)
print("[bench-local] — agent reads the artifacts and judges in-thread. buckets above are a signal grouping, not a verdict.", file=sys.stderr)
PY
