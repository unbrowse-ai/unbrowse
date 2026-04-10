#!/usr/bin/env bash
# benchmark-over-time.sh — track agent experience performance across releases
#
# Runs the dogfood-loop against a stable corpus (derived from live trace
# history, not a curated list) and records results keyed by version +
# git sha + timestamp. Appends to a JSONL history file so we can plot
# regression/improvement across releases.
#
# The "same corpus" comes from the current live trace history — we sample
# the top N unique (goal, domain) pairs by frequency. Each run uses the
# same sampling seed so the corpus is stable across invocations but still
# grounded in real usage (not a hand-curated test set).
#
# Usage:
#   bash scripts/benchmark-over-time.sh                    # run + append
#   bash scripts/benchmark-over-time.sh --remote HOST      # run on remote
#   bash scripts/benchmark-over-time.sh --show             # show history
#   bash scripts/benchmark-over-time.sh --show --domain X  # filter by domain
#
set -uo pipefail

REMOTE=""
SHOW=false
N=20
for arg in "$@"; do
  case "$arg" in
    --remote) shift; REMOTE="${1:-}"; shift || true ;;
    --show) SHOW=true ;;
    --n) shift; N="${1:-20}"; shift || true ;;
  esac
done

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
HISTORY_FILE="${UNBROWSE_BENCHMARK_HISTORY:-$HOME/.unbrowse/benchmark-history.jsonl}"

if [ "$SHOW" = "true" ]; then
  if [ ! -f "$HISTORY_FILE" ]; then
    echo "No history yet at $HISTORY_FILE"
    exit 0
  fi
  python3 -c "
import json, sys
print(f'{'version':20} {'sha':12} {'date':20} {'ok':5} {'fail':5} {'block':6} {'rate':6}')
print('-' * 78)
for line in open('$HISTORY_FILE'):
    try:
        r = json.loads(line)
        v = r.get('version', '?')[:18]
        sha = r.get('git_sha', '?')[:10]
        ts = r.get('timestamp', '?')[:19]
        p = r.get('pass', 0)
        f = r.get('product_fail', 0)
        b = r.get('browser_block', 0)
        total = p + f + b
        rate = f'{100*p/(p+f):.1f}%' if (p+f) > 0 else 'n/a'
        print(f'{v:20} {sha:12} {ts:20} {p:5} {f:5} {b:6} {rate:6}')
    except: pass
"
  exit 0
fi

# ── Run a benchmark and append to history ──
if [ -n "$REMOTE" ]; then
  echo "[benchmark] running dogfood on $REMOTE..." >&2
  bash "$ROOT_DIR/scripts/dogfood-loop.sh" --remote "$REMOTE" --n "$N" --source traces > /tmp/bm-run.json 2>/tmp/bm-err.log
else
  bash "$ROOT_DIR/scripts/dogfood-loop.sh" --n "$N" --source traces > /tmp/bm-run.json 2>/tmp/bm-err.log
fi

# Extract version + sha from the target (remote or local)
if [ -n "$REMOTE" ]; then
  VERSION=$(ssh "$REMOTE" 'PATH=$HOME/.npm-global/bin:$PATH unbrowse --version 2>/dev/null' || echo "unknown")
  GIT_SHA=$(ssh "$REMOTE" 'PATH=$HOME/.npm-global/bin:$PATH UNBROWSE_NON_INTERACTIVE=1 UNBROWSE_TOS_ACCEPTED=1 unbrowse health 2>/dev/null' | python3 -c "
import sys, json
try: print(json.load(sys.stdin).get('git_sha','')[:12])
except: print('')
" 2>/dev/null || echo "")
else
  VERSION=$(unbrowse --version 2>/dev/null || echo "unknown")
  GIT_SHA=$(unbrowse health 2>/dev/null | python3 -c "
import sys, json
try: print(json.load(sys.stdin).get('git_sha','')[:12])
except: print('')
" 2>/dev/null || echo "")
fi

# Parse dogfood results + write benchmark record
python3 -c "
import json, os, sys, datetime
try:
    d = json.load(open('/tmp/bm-run.json'))
except Exception as e:
    print(f'benchmark parse error: {e}', file=sys.stderr)
    sys.exit(1)
s = d.get('summary', {})
record = {
    'version': '$VERSION',
    'git_sha': '$GIT_SHA',
    'timestamp': datetime.datetime.utcnow().isoformat() + 'Z',
    'host': '${REMOTE:-local}',
    'corpus_size': s.get('total', 0),
    'pass': s.get('pass', 0),
    'product_fail': s.get('product_fail', 0),
    'browser_block': s.get('browser_block', 0),
    'upstream_kuri': s.get('upstream_kuri', 0),
    'product_success_rate': s.get('product_success_rate', 0),
    'per_attempt': [
        {'url': a['url'], 'intent': a['intent'], 'verdict': a['verdict'], 'reason': a.get('reason','')}
        for a in d.get('attempts', [])
    ],
}
os.makedirs(os.path.dirname('$HISTORY_FILE'), exist_ok=True)
with open('$HISTORY_FILE', 'a') as f:
    f.write(json.dumps(record) + '\n')
print(json.dumps({k:v for k,v in record.items() if k != 'per_attempt'}, indent=2))
"
