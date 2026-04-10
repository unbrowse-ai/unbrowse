#!/usr/bin/env bash
# dogfood-loop.sh — autonomous unbrowse self-test
#
# Picks URLs from live trace history + system-provided random sites,
# runs resolve/execute through unbrowse, categorizes failures into:
#   - product-bug (fix required)
#   - browser-block (HTTP 4xx/5xx, anti-bot, auth required, dead upstream)
#   - upstream-kuri (SIGSEGV, transport errors recovering via retry)
#
# Output: JSON artifact for agent review + summary to stderr.
#
# Usage:
#   bash scripts/dogfood-loop.sh                    # local, 20 random attempts
#   bash scripts/dogfood-loop.sh --remote HOST      # remote via SSH
#   bash scripts/dogfood-loop.sh --n 50             # 50 attempts
#   bash scripts/dogfood-loop.sh --source traces    # pick from live traces
#
set -uo pipefail

REMOTE=""
N=20
SOURCE="mixed"  # mixed, traces, random
for arg in "$@"; do
  case "$arg" in
    --remote) shift; REMOTE="${1:-}"; shift || true ;;
    --n) shift; N="${1:-20}"; shift || true ;;
    --source) shift; SOURCE="${1:-mixed}"; shift || true ;;
  esac
done

if [ -n "$REMOTE" ]; then
  exec ssh -o ConnectTimeout=10 -o ServerAliveInterval=30 "$REMOTE" \
    "N=$N SOURCE=$SOURCE bash -s" < "$0"
fi

# ── Running on target host ──
export PATH="$HOME/.npm-global/bin:/usr/local/bin:$PATH"
export UNBROWSE_NON_INTERACTIVE=1
export UNBROWSE_TOS_ACCEPTED=1

N="${N:-20}"
SOURCE="${SOURCE:-mixed}"

# Ensure unbrowse server is running — self-prompting primitive
if ! curl -s -o /dev/null -w "%{http_code}" http://localhost:6969/health --max-time 2 2>/dev/null | grep -q 200; then
  echo "[dogfood] starting unbrowse server..." >&2
  if command -v unbrowse >/dev/null 2>&1; then
    unbrowse health >/dev/null 2>&1 || true
  fi
  # Wait up to 15s for server to come up
  for i in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15; do
    if curl -s -o /dev/null -w "%{http_code}" http://localhost:6969/health --max-time 1 2>/dev/null | grep -q 200; then
      break
    fi
    sleep 1
  done
  if ! curl -s -o /dev/null -w "%{http_code}" http://localhost:6969/health --max-time 2 2>/dev/null | grep -q 200; then
    echo '{"error":"server_not_running","message":"unbrowse server failed to start on port 6969"}'
    exit 1
  fi
fi

# Build URL pool from traces + a curated random list
TRACES_DIR="$HOME/.unbrowse/traces"
URL_POOL=$(mktemp)

# Pool source 1: real (goal, domain) pairs from successful past traces
# PLUS server-fetch URL templates from logs for known-good reproduction.
# This samples ACTUAL agent tasks that were solved before — real usage.
if [ "$SOURCE" != "random" ] && [ -d "$TRACES_DIR" ]; then
  python3 << 'PYEOF' >> "$URL_POOL" 2>/dev/null
import os, json, glob, re
from collections import defaultdict

home = os.environ.get('HOME', '')
traces_dir = f'{home}/.unbrowse/traces'
logs_dir = f'{home}/.unbrowse/logs'

# 1. Get (goal, domain) pairs from recent successful traces
traces = sorted(glob.glob(f'{traces_dir}/*-success-*.json'))[-500:]
pairs = set()
for f in traces:
    try:
        d = json.load(open(f))
        goal = d.get('goal','').strip()
        dom = d.get('domain','').strip()
        if goal and dom:
            pairs.add((goal, dom))
    except: pass

# 2. Try to find full execute URLs for each domain from logs
url_templates = {}
for log in sorted(glob.glob(f'{logs_dir}/unbrowse-*.log'))[-5:]:
    try:
        with open(log) as f:
            for line in f:
                m = re.search(r'server-fetch: GET (https?://[^\s]+)', line)
                if m:
                    url = m.group(1)
                    if 'localhost' in url or '127.0.0.1' in url or 'example.com' in url:
                        continue
                    # Extract domain
                    dm = re.match(r'https?://([^/]+)', url)
                    if dm:
                        dom = dm.group(1).removeprefix('www.')
                        if dom not in url_templates:
                            url_templates[dom] = url
    except: pass

# 3. Emit (goal, url) — prefer real URL from logs if known, else domain root
for goal, dom in pairs:
    key = dom.removeprefix('www.')
    if key in url_templates:
        print(f'{goal}|{url_templates[key]}')
    else:
        print(f'{goal}|https://{dom}')
PYEOF
fi

# Pool source 2: curated random sites (hit real diversity)
if [ "$SOURCE" != "traces" ]; then
  cat >> "$URL_POOL" <<'URLS'
get package info|https://pypi.org/project/requests/
get package info|https://pypi.org/project/django/
get repository info|https://api.github.com/repos/rust-lang/rust
search packages|https://registry.npmjs.org/-/v1/search?text=react
get data|https://httpbin.org/ip
get data|https://catfact.ninja/fact
get data|https://dog.ceo/api/breeds/image/random
get data|https://api.spacexdata.com/v4/launches/latest
get data|https://randomuser.me/api/
get data|https://pokeapi.co/api/v2/pokemon/pikachu
get data|https://restcountries.com/v3.1/name/japan
get data|https://jsonplaceholder.typicode.com/users/1
read page|https://en.wikipedia.org/wiki/Python_(programming_language)
read page|https://news.ycombinator.com/
read page|https://www.bbc.com/news
read page|https://github.com/anthropics/claude-code
get weather|https://wttr.in/Tokyo?format=j1
get ip|https://api.ipify.org?format=json
get jokes|https://api.chucknorris.io/jokes/random
get data|https://openlibrary.org/api/books?bibkeys=ISBN:9780140328721&format=json
URLS
fi

# Sample N URLs
python3 -c "
import random
lines = open('$URL_POOL').read().strip().split('\n')
lines = [l for l in lines if l.strip() and '|' in l]
random.shuffle(lines)
for l in lines[:int('$N')]:
    print(l)
" > "$URL_POOL.sample"

# Run attempts
RESULTS_FILE="/tmp/dogfood-results.json"
echo '{"attempts":[]}' > "$RESULTS_FILE"

PASS=0; FAIL_PRODUCT=0; FAIL_BROWSER=0; FAIL_UPSTREAM=0

while IFS='|' read -r intent url; do
  [ -z "$url" ] && continue
  echo "[dogfood] $url" >&2

  START=$(python3 -c 'import time;print(int(time.time()*1000))')
  raw=$(curl -s -X POST http://localhost:6969/v1/intent/resolve \
    -H 'Content-Type: application/json' \
    -d "{\"intent\":\"$intent\",\"context\":{\"url\":\"$url\"}}" \
    --max-time 60 2>/dev/null)
  END=$(python3 -c 'import time;print(int(time.time()*1000))')
  elapsed=$((END - START))

  # Write raw to temp file to avoid bash escaping
  TMPF=$(mktemp)
  printf '%s' "$raw" > "$TMPF"

  verdict=$(RAW_FILE="$TMPF" URL="$url" INTENT="$intent" ELAPSED="$elapsed" python3 -c "
import json, os, sys
try:
    d = json.load(open(os.environ['RAW_FILE']))
except:
    print('PARSE_ERR')
    sys.exit(0)
src = d.get('source', '?')
tr = d.get('trace', {})
r = d.get('result', {})
# Classification
verdict = 'UNKNOWN'
reason = ''
if isinstance(r, list) and r:
    verdict = 'PASS'; reason = f'list[{len(r)}]'
elif isinstance(r, dict):
    err = r.get('error')
    if 'available_operations' in r:
        verdict = 'PASS'; reason = f'{len(r[\"available_operations\"])} ops'
    elif err == 'auth_required':
        verdict = 'BROWSER_BLOCK'; reason = 'auth_required'
    elif err == 'no_endpoints':
        # Could be product bug OR browser-level anti-bot
        msg = r.get('message', '').lower()
        if 'authentication' in msg or 'blocked' in msg:
            verdict = 'BROWSER_BLOCK'; reason = 'auth/blocked'
        else:
            verdict = 'PRODUCT_FAIL'; reason = 'no_endpoints'
    elif err == 'connection_failed':
        verdict = 'UPSTREAM_KURI'; reason = 'connection_failed'
    elif err == 'capture_failed':
        verdict = 'UPSTREAM_KURI'; reason = 'capture_failed'
    elif err == 'capture_timeout':
        verdict = 'BROWSER_BLOCK'; reason = 'timeout'
    elif err == 'payment_required':
        verdict = 'BROWSER_BLOCK'; reason = 'payment_required'
    elif err:
        verdict = 'PRODUCT_FAIL'; reason = err[:40]
    elif r:
        # Check for Cloudflare/anti-bot garbage that looks like a pass but isn't.
        # Heuristics: title == 'Just a moment...', description mentions 'cloudflare',
        # only extracted fields are CF challenge metadata, or data empty.
        flat = json.dumps(r).lower()
        cf_markers = ['just a moment', 'cloudflare', 'enable javascript', 'ray id', 'attention required', 'blocked | ripley']
        if any(m in flat for m in cf_markers):
            verdict = 'BROWSER_BLOCK'; reason = 'cloudflare_challenge_page'
        else:
            # Also check: does the result have any domain-specific content,
            # or just the shell of a challenge page (title/desc/h1 only)?
            keys = list(r.keys()) if isinstance(r, dict) else []
            if keys == ['title', 'heading_1', 'heading_2', 'description']:
                # Pure metadata extraction — very likely a block page
                verdict = 'BROWSER_BLOCK'; reason = 'metadata_only_extraction'
            else:
                verdict = 'PASS'; reason = f'keys={keys[:3]}'
# Write record
with open('$RESULTS_FILE') as f: results = json.load(f)
results['attempts'].append({
    'url': os.environ['URL'],
    'intent': os.environ['INTENT'],
    'verdict': verdict,
    'reason': reason,
    'source': src,
    'elapsed_ms': int(os.environ['ELAPSED']),
})
with open('$RESULTS_FILE', 'w') as f: json.dump(results, f)
print(verdict)
" 2>/dev/null)
  rm -f "$TMPF"

  case "$verdict" in
    PASS) PASS=$((PASS+1)); echo "  PASS" >&2 ;;
    PRODUCT_FAIL) FAIL_PRODUCT=$((FAIL_PRODUCT+1)); echo "  PRODUCT_FAIL" >&2 ;;
    BROWSER_BLOCK) FAIL_BROWSER=$((FAIL_BROWSER+1)); echo "  BROWSER_BLOCK" >&2 ;;
    UPSTREAM_KURI) FAIL_UPSTREAM=$((FAIL_UPSTREAM+1)); echo "  UPSTREAM_KURI" >&2 ;;
    *) echo "  UNKNOWN: $verdict" >&2 ;;
  esac
done < "$URL_POOL.sample"

rm -f "$URL_POOL" "$URL_POOL.sample"
pkill -9 -f 'unbrowse|kuri' 2>/dev/null || true

# Attach summary
python3 -c "
import json
with open('$RESULTS_FILE') as f: d = json.load(f)
total = len(d['attempts'])
pass_count = sum(1 for a in d['attempts'] if a['verdict'] == 'PASS')
product_fail = sum(1 for a in d['attempts'] if a['verdict'] == 'PRODUCT_FAIL')
browser_block = sum(1 for a in d['attempts'] if a['verdict'] == 'BROWSER_BLOCK')
upstream = sum(1 for a in d['attempts'] if a['verdict'] == 'UPSTREAM_KURI')
d['summary'] = {
    'total': total,
    'pass': pass_count,
    'product_fail': product_fail,
    'browser_block': browser_block,
    'upstream_kuri': upstream,
    'product_success_rate': round(100 * pass_count / max(1, total - browser_block), 1),
    'raw_success_rate': round(100 * pass_count / max(1, total), 1),
}
with open('$RESULTS_FILE', 'w') as f: json.dump(d, f)
print(json.dumps(d, indent=2))
"
