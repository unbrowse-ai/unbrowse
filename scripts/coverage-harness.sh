#!/usr/bin/env bash
# coverage-harness.sh — run unbrowse against many sites, collect raw artifacts
#
# Collects resolve → execute evidence across a curated case list.
# The agent judges each case: pass / fail-product / fail-browser-block.
#
# Usage:
#   bash scripts/coverage-harness.sh                    # local
#   bash scripts/coverage-harness.sh --remote HOST      # via SSH
#   bash scripts/coverage-harness.sh --cases FILE       # custom cases (default: product-success)
#
set -uo pipefail

REMOTE=""
CASES="evals/codex-cases.product-success.json"
for arg in "$@"; do
  case "$arg" in
    --remote) shift; REMOTE="${1:-}"; shift || true ;;
    --cases) shift; CASES="${1:-}"; shift || true ;;
  esac
done

if [ -n "$REMOTE" ]; then
  # Bundle the cases file into the script via heredoc
  CASES_CONTENT="$(cat "$CASES" 2>/dev/null || echo '{"cases":[]}')"
  exec ssh -o ConnectTimeout=10 -o ServerAliveInterval=30 "$REMOTE" \
    "CASES_JSON='$CASES_CONTENT' bash -s" < "$0"
fi

# ── Running on target host ──
export PATH="$HOME/.npm-global/bin:/usr/local/bin:$PATH"
export UNBROWSE_NON_INTERACTIVE=1
export UNBROWSE_TOS_ACCEPTED=1

RESULTS_FILE="/tmp/coverage-results.json"
echo '{"runs":[]}' > "$RESULTS_FILE"

# Load cases from env var (remote mode) or file (local mode)
if [ -n "${CASES_JSON:-}" ]; then
  echo "$CASES_JSON" > /tmp/cases.json
else
  cp "$CASES" /tmp/cases.json
fi

# Strip unbrowse logs, return only JSON
strip_logs() {
  python3 -c "
import sys, json
raw = sys.stdin.read()
decoder = json.JSONDecoder()
for i, ch in enumerate(raw):
    if ch in '{[':
        try:
            obj, _ = decoder.raw_decode(raw[i:])
            print(json.dumps(obj))
            sys.exit(0)
        except json.JSONDecodeError:
            continue
" 2>/dev/null
}

# Call unbrowse, return only JSON from stdout
call() {
  "$@" 2>/dev/null | strip_logs
}

# Iterate cases
python3 -c "
import json
d = json.load(open('/tmp/cases.json'))
cases = d.get('cases', d) if isinstance(d, dict) else d
for c in cases:
    print(f\"{c.get('id','?')}|{c.get('intent','')}|{c.get('url','')}\")
" > /tmp/case-list.txt

while IFS='|' read -r case_id intent url; do
  [ -z "$case_id" ] && continue
  echo "[cov] $case_id" >&2

  # Resolve
  resolve_out=$(call unbrowse resolve --intent "$intent" --url "$url")
  skill=$(echo "$resolve_out" | python3 -c "import sys,json; d=json.loads(sys.stdin.read() or '{}'); print(d.get('trace',{}).get('skill_id',''))" 2>/dev/null)
  ep=$(echo "$resolve_out" | python3 -c "import sys,json; d=json.loads(sys.stdin.read() or '{}'); ops=d.get('result',{}).get('available_operations',[]); print(ops[0]['endpoint_id'] if ops else '')" 2>/dev/null)
  source_tag=$(echo "$resolve_out" | python3 -c "import sys,json; d=json.loads(sys.stdin.read() or '{}'); print(d.get('source',''))" 2>/dev/null)

  # Execute
  exec_out=""
  if [ -n "$skill" ] && [ -n "$ep" ]; then
    exec_out=$(call unbrowse execute --skill "$skill" --endpoint "$ep" --url "$url" --raw --pretty)
  fi

  # Record
  tmpf=$(mktemp)
  python3 -c "
import json
with open('$RESULTS_FILE') as f: results = json.load(f)
resolve_data = None
exec_data = None
try: resolve_data = json.loads('''$(echo "$resolve_out" | python3 -c "import sys; print(sys.stdin.read().replace(chr(39), chr(39)+chr(92)+chr(39)+chr(39)))" 2>/dev/null)''')
except: pass
try: exec_data = json.loads('''$(echo "$exec_out" | python3 -c "import sys; print(sys.stdin.read().replace(chr(39), chr(39)+chr(92)+chr(39)+chr(39)))" 2>/dev/null)''')
except: pass
results['runs'].append({
    'case_id': '$case_id',
    'intent': '$intent',
    'url': '$url',
    'skill_id': '$skill',
    'endpoint_id': '$ep',
    'source': '$source_tag',
    'resolve_summary': {
        'has_ops': bool(resolve_data and resolve_data.get('result',{}).get('available_operations')),
        'num_ops': len(resolve_data.get('result',{}).get('available_operations',[])) if resolve_data else 0,
        'error': resolve_data.get('result',{}).get('error') if resolve_data else None,
    },
    'execute_summary': {
        'success': exec_data.get('trace',{}).get('success') if exec_data else None,
        'status_code': exec_data.get('trace',{}).get('status_code') if exec_data else None,
        'error': exec_data.get('result',{}).get('error') if exec_data else None,
        'has_data': bool(exec_data and exec_data.get('result') and not exec_data.get('result',{}).get('error')) if exec_data else False,
        'result_keys': list(exec_data.get('result',{}).keys())[:8] if exec_data and isinstance(exec_data.get('result'),dict) else [],
    },
})
with open('$RESULTS_FILE','w') as f: json.dump(results, f)
" 2>/dev/null
  rm -f "$tmpf"
done < /tmp/case-list.txt

pkill -9 -f 'unbrowse|kuri' 2>/dev/null || true
cat "$RESULTS_FILE"
