#!/usr/bin/env bash
# benchmark-turbobox-parallel.sh — benchmark many unbrowse versions in parallel sandboxes
#
# Spins up one turbobox sandbox per version. Each box runs the full
# corpus (all unique domains from live trace history) against that
# specific unbrowse version. Results aggregate back via KV or direct
# exec output.
#
# This is Lewis's ask: 'benchmark against the corpus we were growing
# and evaluating against... spin up sandboxes within the turbobox so
# we can parallelise them in tiny environments.'
#
# Usage:
#   bash scripts/benchmark-turbobox-parallel.sh --versions "3.5.4 3.6.0 3.7.0 3.7.1"
#   bash scripts/benchmark-turbobox-parallel.sh --last-n 5 --corpus-size 30
#
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Register with the Aiko job-state primitive so `peek` can see live progress
# even when this script is running in the background. job-state lives in the
# agent-factory primitives so it's available to every project, not unbrowse.
JOB_STATE_LIB="$HOME/agent-factory/bin/job-state/job-state"
if [ -f "$JOB_STATE_LIB" ]; then
  # shellcheck disable=SC1090
  source "$JOB_STATE_LIB"
  JOB_ID=$(job_register "benchmark-turbobox-parallel" "$*")
  trap 'job_done "$JOB_ID" "interrupted" ""' INT TERM
  echo "[turbobox-parallel] job_id=$JOB_ID  (peek: $HOME/agent-factory/bin/peek/peek $JOB_ID)"
else
  JOB_ID=""
  job_register() { :; }
  job_update() { :; }
  job_done() { :; }
fi

TURBOBOX_URL="${TURBOBOX_URL:-https://sandbox.trilok.ai}"
VERSIONS=""
LAST_N=0
CORPUS_SIZE=30
CORPUS_OFFSET=0
CORPUS_FILE_OVERRIDE=""
IMAGE="ubuntu"
for arg in "$@"; do
  case "$arg" in
    --versions) shift; VERSIONS="${1:-}"; shift || true ;;
    --last-n) shift; LAST_N="${1:-5}"; shift || true ;;
    --corpus-size) shift; CORPUS_SIZE="${1:-30}"; shift || true ;;
    --corpus-offset) shift; CORPUS_OFFSET="${1:-0}"; shift || true ;;
    --corpus-file) shift; CORPUS_FILE_OVERRIDE="${1:-}"; shift || true ;;
    --image) shift; IMAGE="${1:-dev}"; shift || true ;;
  esac
done

HISTORY_FILE="${UNBROWSE_BENCHMARK_HISTORY:-$HOME/.unbrowse/benchmark-history.jsonl}"

# ── Step 1: Resolve versions to test ──
if [ -z "$VERSIONS" ] && [ "$LAST_N" -gt 0 ]; then
  VERSIONS=$(npm view unbrowse versions --json 2>/dev/null | python3 -c "
import sys, json
vs = json.loads(sys.stdin.read())
stable = [v for v in vs if '-' not in v and v.startswith('3.')]
print(' '.join(stable[-$LAST_N:]))
")
fi

if [ -z "$VERSIONS" ]; then
  echo "usage: --versions 'v1 v2 ...' or --last-n N" >&2
  exit 1
fi

# ── Step 2: Build corpus ──
# Prefer the baseline corpus file (reproducible across runs) unless the
# --from-traces flag is passed. The baseline is the stable multi-version
# comparison surface — adding new rows means adding new probe coverage,
# per the "features extend the benchmark" principle.
CORPUS_FILE=$(mktemp)
BASELINE_CORPUS="$SCRIPT_DIR/corpus/benchmark-baseline.txt"

USE_TRACES=false
for arg in "$@"; do
  case "$arg" in
    --from-traces) USE_TRACES=true ;;
  esac
done

if [ -n "$CORPUS_FILE_OVERRIDE" ] && [ -f "$CORPUS_FILE_OVERRIDE" ]; then
  # Explicit override wins — agent passes a specific file (e.g. a failure slice)
  tail -n "+$((CORPUS_OFFSET+1))" "$CORPUS_FILE_OVERRIDE" | head -n "$CORPUS_SIZE" > "$CORPUS_FILE"
elif [ "$USE_TRACES" = "true" ]; then
  python3 << PYEOF > "$CORPUS_FILE"
import glob, json, os
from collections import Counter
traces = sorted(glob.glob(os.path.expanduser('~/.unbrowse/traces/*-success-*.json')))[-1000:]
pairs = Counter()
for f in traces:
    try:
        d = json.load(open(f))
        if d.get('trace_id') == 'test-nanoid': continue
        goal = d.get('goal','').strip()
        dom = d.get('domain','').strip()
        if goal and dom:
            pairs[(goal, dom)] += 1
    except: pass
for (goal, dom), _ in pairs.most_common($CORPUS_SIZE):
    url = f'https://{dom}'
    print(f'{goal}|{url}')
PYEOF
elif [ -f "$BASELINE_CORPUS" ]; then
  # Support --corpus-offset so we can chunk the baseline into kill-safe batches
  tail -n "+$((CORPUS_OFFSET+1))" "$BASELINE_CORPUS" | head -n "$CORPUS_SIZE" > "$CORPUS_FILE"
fi

if [ ! -s "$CORPUS_FILE" ]; then
  echo "[turbobox-parallel] ✗ corpus is empty (no baseline and no traces)" >&2
  job_done "$JOB_ID" "failed" "corpus_empty"
  exit 1
fi

CORPUS_N=$(wc -l < "$CORPUS_FILE" | tr -d ' ')
echo "[turbobox-parallel] corpus: $CORPUS_N (goal, url) pairs from live traces"
echo "[turbobox-parallel] versions: $VERSIONS"
echo "[turbobox-parallel] turbobox: $TURBOBOX_URL"
echo ""

# ── Step 3: Health check turbobox ──
if ! curl -sf "$TURBOBOX_URL/v1/boxes" --max-time 5 >/dev/null 2>&1; then
  echo "[turbobox-parallel] ✗ turbobox at $TURBOBOX_URL not reachable"
  exit 1
fi
echo "[turbobox-parallel] ✓ turbobox reachable"
job_update "$JOB_ID" "spawning sandboxes" 10 "curl -s $TURBOBOX_URL/v1/boxes"

# ── Step 4: Spawn a sandbox per version, run corpus inside, collect results ──
RESULTS_DIR=$(mktemp -d)
declare -a BOX_IDS
declare -a BOX_VERSIONS

spawn_box() {
  local ver="$1"
  echo "[spawn] creating box for $ver..."
  local resp
  resp=$(curl -sf -X POST "$TURBOBOX_URL/v1/boxes" \
    -H "Content-Type: application/json" \
    -d "{\"image\":\"$IMAGE\",\"cpu\":2000,\"memory\":2048,\"ttl\":1800}" 2>&1)
  local box_id
  box_id=$(echo "$resp" | python3 -c "import sys,json; d=json.loads(sys.stdin.read()); print(d.get('id',d.get('box_id','')))" 2>/dev/null)
  if [ -z "$box_id" ]; then
    echo "[spawn] ✗ failed to spawn box for $ver: $resp"
    return 1
  fi
  echo "[spawn] ✓ $ver → box $box_id"
  BOX_IDS+=("$box_id")
  BOX_VERSIONS+=("$ver")
}

exec_in_box() {
  # Background exec + poll. Cloudflare edge cuts sync exec at ~100s so we must
  # use /exec/background and poll the job until it finishes.
  # Retries the /exec/background POST up to 3 times on 502/empty body.
  local box_id="$1" cmd="$2"
  local start_resp job_id attempt=0
  while [ "$attempt" -lt 3 ]; do
    attempt=$((attempt+1))
    start_resp=$(curl -s -X POST "$TURBOBOX_URL/v1/boxes/$box_id/exec/background" \
      -H "Content-Type: text/plain" \
      --data-binary "$cmd" --max-time 30 2>&1)
    job_id=$(echo "$start_resp" | python3 -c "import sys,json; print(json.loads(sys.stdin.read(), strict=False).get('job_id',''))" 2>/dev/null)
    if [ -n "$job_id" ]; then
      break
    fi
    echo "[exec_in_box] attempt $attempt: no job_id (resp head: $(echo "$start_resp" | head -c 120))" >&2
    sleep 1
  done
  if [ -z "$job_id" ]; then
    echo "$start_resp"
    return 1
  fi
  # Poll up to 15 minutes. Exit early on 404/BoxNotFound so an externally
  # destroyed box doesn't leave the script stuck.
  local waited=0 max=900 poll=5 notfound_count=0
  while [ "$waited" -lt "$max" ]; do
    sleep "$poll"
    waited=$((waited + poll))
    local poll_resp status
    poll_resp=$(curl -s "$TURBOBOX_URL/v1/boxes/$box_id/exec/background/$job_id" --max-time 20 2>&1)
    # Detect a destroyed box: turbobox returns {"error":"BoxNotFound"} or 403
    if printf '%s' "$poll_resp" | grep -qE 'BoxNotFound|not found|Forbidden'; then
      notfound_count=$((notfound_count + 1))
      if [ "$notfound_count" -ge 3 ]; then
        echo "$poll_resp"
        return 1
      fi
      continue
    fi
    status=$(echo "$poll_resp" | python3 -c "import sys,json; print(json.loads(sys.stdin.read(), strict=False).get('status',''))" 2>/dev/null)
    case "$status" in
      completed|failed|killed|stopped)
        echo "$poll_resp"
        return 0
        ;;
    esac
  done
  echo "$poll_resp"
  return 1
}

destroy_box() {
  local box_id="$1"
  curl -sf -X DELETE "$TURBOBOX_URL/v1/boxes/$box_id" --max-time 10 2>&1 >/dev/null
}

# Spawn all boxes first (parallel provisioning)
for VER in $VERSIONS; do
  spawn_box "$VER"
done

if [ "${#BOX_IDS[@]}" -eq 0 ]; then
  echo "[turbobox-parallel] ✗ no boxes spawned"
  rm -rf "$RESULTS_DIR" "$CORPUS_FILE"
  exit 1
fi

# Run benchmarks in parallel (background per box)
echo ""
echo "[turbobox-parallel] running benchmarks in parallel..."
# Build a peek command that shows what every active box is currently running.
# Lewis can run `bash scripts/peek.sh $JOB_ID` at any time to see this.
PEEK_PAYLOAD="for b in ${BOX_IDS[*]}; do echo === \$b ===; curl -s -X POST $TURBOBOX_URL/v1/boxes/\$b/exec -H 'Content-Type: text/plain' --data-binary 'ps -eaf 2>/dev/null | grep -E \"unbrowse resolve|timeout\" | grep -v grep | head -5' --max-time 10; echo; done"
job_update "$JOB_ID" "running benchmarks" 30 "$PEEK_PAYLOAD"

run_benchmark_in_box() {
  local box_id="$1" ver="$2"
  local result_file="$RESULTS_DIR/$ver.json"

  # Install unbrowse version + run dogfood-like corpus
  # Corpus is passed as a heredoc of (goal, url) lines
  local corpus_content
  corpus_content=$(cat "$CORPUS_FILE" | base64 | tr -d '\n')

  local script
  # Classifier script — written to /tmp/classify.py in the box then invoked per URL.
  # Base64-encoded to avoid shell-escaping hell.
  local classifier_py
  classifier_py=$(cat <<'PYEOF' | base64 | tr -d '\n'
import sys, json, re
raw = sys.stdin.read()
# Find the first JSON object that contains "trace" or "result" — the unbrowse
# resolve payload. Plain [unbrowse] log lines and shell output are skipped.
d = {}
for m in re.finditer(r'\{"(?:trace|result|error|skill_id)"', raw):
    candidate = raw[m.start():]
    try:
        d = json.JSONDecoder(strict=False).raw_decode(candidate)[0]
        break
    except Exception:
        continue
r = d.get('result', {}) if isinstance(d, dict) else {}
trace = d.get('trace', {}) if isinstance(d, dict) else {}
source = d.get('source', '') if isinstance(d, dict) else ''
# PASS signals:
#   a) resolve returned available_operations/available_endpoints — agent can pick and execute
if isinstance(r, dict) and (r.get('available_operations') or r.get('available_endpoints')):
    print('pass')
    sys.exit(0)
#   b) direct-fetch/direct-document short-circuit: unbrowse returned the data directly.
#      Without this, direct wins were wrongly classified as fails because the output
#      doesn't include an available_operations array.
if (source in ('direct-fetch', 'direct-document') or trace.get('skill_id') in ('direct-fetch', 'direct-document')) and trace.get('success') is True and not (isinstance(r, dict) and r.get('error')):
    print('pass')
    sys.exit(0)
# Block: browser/environment couldn't complete (not a product fault).
# Matches Lewis's goal framing: "100% coverage unless browser-level blocked."
BLOCK_ERRORS = {
    'auth_required',      # site needs login — agent can't proceed without creds
    'capture_failed',     # Kuri failed to launch / browser couldn't run
    'kuri_crash',         # Kuri crashed mid-capture
    'connection_failed',  # can't reach the browser broker
    'browser_block',      # Cloudflare / anti-bot page
}
# NOT in BLOCK_ERRORS (these are PRODUCT failures we must fix):
#   no_endpoints — the site has APIs we failed to discover (pypi/github/etc.)
#   timeout      — our pipeline exceeded budget; could be product perf or browser,
#                  expose as fail so the agent judges which and fixes the product
#                  path when relevant
err = ''
if isinstance(r, dict):
    err = r.get('error','')
elif isinstance(d, dict):
    err = d.get('error','')
msg = (r.get('message','') if isinstance(r, dict) else '') or ''
if err in BLOCK_ERRORS:
    print('block')
    sys.exit(0)
# String-match fallback: Kuri failure messages show up even when the error
# code is generic or the JSON shape is slightly different.
if re.search(r'kuri failed to start|capture failed|cloudflare|challenge|just a moment', msg, re.I):
    print('block')
    sys.exit(0)
# Everything else is a real product fail (bad resolve, empty result, parser
# issue, etc.). If tests surface new browser-level error codes, add them to
# BLOCK_ERRORS above — don't silently reclassify.
print('fail')
PYEOF
)

  script="set +e; export HOME=/root; export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:/root/.npm-global/bin; export UNBROWSE_NON_INTERACTIVE=1; export UNBROWSE_TOS_ACCEPTED=1; npm config set prefix /root/.npm-global >/dev/null 2>&1; npm install -g unbrowse@$ver 2>&1 | tail -1; unbrowse --version; echo '$corpus_content' | base64 -d > /tmp/corpus.txt; echo '$classifier_py' | base64 -d > /tmp/classify.py; pass=0; fail=0; block=0; total=0; while IFS='|' read -r goal url <&3; do [ -z \"\$url\" ] && continue; total=\$((total+1)); out=\$(timeout 120 unbrowse resolve --intent \"\$goal\" --url \"\$url\" </dev/null 2>/dev/null); ok=\$(printf '%s' \"\$out\" | python3 /tmp/classify.py 2>/dev/null); [ -z \"\$ok\" ] && ok=fail; case \"\$ok\" in pass) pass=\$((pass+1));; block) block=\$((block+1));; *) fail=\$((fail+1));; esac; echo \"PROGRESS [$ver] \$url -> \$ok (total=\$total pass=\$pass fail=\$fail block=\$block)\"; if [ \"\$ok\" = \"fail\" ]; then echo \"FAIL_DETAIL_BEGIN [$ver] \$url\"; printf '%s' \"\$out\" | tail -c 2000; echo; echo \"FAIL_DETAIL_END\"; fi; done 3< /tmp/corpus.txt; printf '{\"version\":\"$ver\",\"pass\":%d,\"fail\":%d,\"block\":%d,\"total\":%d}\n' \$pass \$fail \$block \$total"

  exec_in_box "$box_id" "$script" > "$result_file" 2>&1
  echo "[bench] $ver done"
}

for i in "${!BOX_IDS[@]}"; do
  run_benchmark_in_box "${BOX_IDS[$i]}" "${BOX_VERSIONS[$i]}" &
done
wait

# ── Step 5: Aggregate + record ──
echo ""
echo "[turbobox-parallel] aggregated results:"
echo ""
printf "%-20s %-8s %-8s %-8s %-8s %-8s\n" "version" "pass" "fail" "block" "total" "rate"
echo "-----------------------------------------------------------------------"

for i in "${!BOX_VERSIONS[@]}"; do
  VER="${BOX_VERSIONS[$i]}"
  RESULT_FILE="$RESULTS_DIR/$VER.json"
  if [ -f "$RESULT_FILE" ]; then
    python3 -c "
import json, re, sys
raw = open('$RESULT_FILE').read()
# Decode outer turbobox exec envelope {\"output\":\"...\"} first
# strict=False: turbobox returns raw newlines inside string values (technically invalid JSON)
try:
    env = json.loads(raw, strict=False)
    text = env.get('output', raw) if isinstance(env, dict) else raw
except Exception:
    text = raw
# Extract the last JSON object containing \"version\" from the exec output
m = list(re.finditer(r'\{[^{}]*\"version\"[^{}]*\}', text))
if m:
    try:
        d = json.loads(m[-1].group(0))
        p, f, b, t = d.get('pass',0), d.get('fail',0), d.get('block',0), d.get('total',0)
        rate = f'{100*p/(p+f):.0f}%' if (p+f) > 0 else 'n/a'
        print(f'{d[\"version\"]:20} {p:<8} {f:<8} {b:<8} {t:<8} {rate:<8}')
        # Append to history
        import os, datetime
        rec = {'version': d['version'], 'git_sha': 'turbobox', 'timestamp': datetime.datetime.utcnow().isoformat()+'Z', 'host': 'turbobox-parallel', 'corpus_size': t, 'pass': p, 'product_fail': f, 'browser_block': b, 'upstream_kuri': 0, 'product_success_rate': (100.0*p/(p+f) if (p+f)>0 else 0.0)}
        os.makedirs(os.path.dirname('$HISTORY_FILE'), exist_ok=True)
        with open('$HISTORY_FILE', 'a') as fh:
            fh.write(json.dumps(rec) + '\\n')
    except Exception as e:
        print(f'$VER parse error: {e}')
else:
    print(f'$VER no result')
"
  else
    echo "$VER: no result file"
  fi
done

# ── Step 6: Cleanup boxes ──
echo ""
echo "[turbobox-parallel] destroying boxes..."
for box_id in "${BOX_IDS[@]}"; do
  destroy_box "$box_id" &
done
wait

echo "[turbobox-parallel] results dir: $RESULTS_DIR (not cleaned)"
rm -rf "$CORPUS_FILE"

# Build a short result summary from the aggregated results for job_done.
SUMMARY=$(python3 - "$RESULTS_DIR" <<'PYEOF'
import json, os, re, sys
d = sys.argv[1]
rows = []
for f in sorted(os.listdir(d)):
    if not f.endswith('.json'): continue
    try:
        env = json.load(open(os.path.join(d, f)))
        text = env.get('output', '') if isinstance(env, dict) else ''
        m = list(re.finditer(r'\{[^{}]*"version"[^{}]*\}', text))
        if m:
            r = json.loads(m[-1].group(0))
            rows.append(f"{r.get('version','?')}:{r.get('pass',0)}/{r.get('total',0)}")
    except Exception: pass
print(' '.join(rows) if rows else 'no_results')
PYEOF
)
job_done "$JOB_ID" "completed" "$SUMMARY"
echo "[turbobox-parallel] ✓ done. History at $HISTORY_FILE"
