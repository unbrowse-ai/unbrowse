#!/usr/bin/env bash
# cold-start-bench — harness for measuring cold-start agent experience.
#
# This is a HARNESS + AGENT primitive, not a solo script. Each sub-command
# does one thing, writes one JSON artifact to the run directory, and exits.
# The AGENT (me) reads each artifact, reasons about it, and decides what
# sub-command to call next — including which endpoint to execute, whether
# the run is done, and what the final verdict is.
#
# Run directory layout: ~/.unbrowse/cold-start/<run-id>/
#   box.json              — sandbox id + target url + intent + version
#   install.json          — npm install result, version
#   setup.json            — setup state, health snapshot
#   resolve.json          — force-capture resolve output, available endpoints
#   skill.json            — indexed skill detail for the captured skill
#   execute-<epid>.json   — one per agent-initiated execute call
#   rerun.json            — second resolve, measuring cache hit speed
#   verdict.json          — agent-written verdict, NOT auto-computed
#
# Sub-commands:
#   cold-start-bench new [--version V] [--intent I] [--url U]
#     Create a new run directory, spawn a sandbox. Prints the run id.
#
#   cold-start-bench install --run R
#     Install unbrowse@<version> inside the run's sandbox. Writes install.json.
#
#   cold-start-bench setup --run R
#     Run unbrowse setup (tos, key registration).
#     Writes setup.json with health snapshot.
#
#   cold-start-bench resolve --run R
#     Run unbrowse resolve --force-capture against the run's intent/url.
#     Writes resolve.json with the full resolve payload and available
#     endpoints. AGENT reviews this to pick an endpoint.
#
#   cold-start-bench inspect --run R
#     Run unbrowse skill <skill_id> to get the indexed contract detail.
#     Writes skill.json. AGENT reviews this for RE quality.
#
#   cold-start-bench execute --run R --endpoint EPID
#     Run unbrowse execute with the AGENT-chosen endpoint id. Writes
#     execute-<epid>.json with the raw response. AGENT judges the response.
#
#   cold-start-bench rerun-resolve --run R
#     Second resolve (no force-capture) to measure cache hit latency.
#     Writes rerun.json. AGENT compares to first resolve timing.
#
#   cold-start-bench verdict --run R --step STEP --state STATE [--note ...]
#     AGENT writes its judgment for a step into verdict.json. STEP in
#     {install, setup, capture, re_extracted, semantic_meta, execute,
#      cache_hit}, STATE in {pass, partial, fail, block}. Appended, not
#     overwritten — multiple verdicts per step build the full picture.
#
#   cold-start-bench finalize --run R
#     AGENT-triggered. Reads verdict.json, computes the overall run
#     verdict, appends one row to ~/.unbrowse/cold-start-history.jsonl.
#
#   cold-start-bench destroy --run R
#     Destroy the sandbox. Keeps the run directory for later review.
#
#   cold-start-bench show --run R
#     Dump all artifacts from the run for agent review.
#
#   cold-start-bench list
#     List all runs with their finalized verdicts.
#
#   cold-start-bench history
#     Print ~/.unbrowse/cold-start-history.jsonl as a compact table.
#
# No sub-command auto-picks the next step. No sub-command auto-selects an
# endpoint from a list. No sub-command auto-judges a response. Everything
# semantic crosses back to the agent.

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
JOB_STATE_LIB="$HOME/agent-factory/bin/job-state/job-state"
if [ -f "$JOB_STATE_LIB" ]; then
  # shellcheck disable=SC1090
  source "$JOB_STATE_LIB"
else
  job_register() { :; }
  job_update() { :; }
  job_done() { :; }
fi

TURBOBOX_URL="${TURBOBOX_URL:-https://sandbox.trilok.ai}"
RUNS_DIR="${UNBROWSE_COLD_START_RUNS:-$HOME/.unbrowse/cold-start}"
HISTORY_FILE="${UNBROWSE_COLD_START_HISTORY:-$HOME/.unbrowse/cold-start-history.jsonl}"
mkdir -p "$RUNS_DIR"

# Parse --run R and stash the directory. Usage: `parse_run "$@"`
RUN_ID=""
RUN_DIR=""
parse_run() {
  for ((i=1; i<=$#; i++)); do
    if [ "${!i}" = "--run" ]; then
      j=$((i+1))
      RUN_ID="${!j}"
      RUN_DIR="$RUNS_DIR/$RUN_ID"
      [ -d "$RUN_DIR" ] || { echo "[cold-start] no such run: $RUN_ID" >&2; exit 2; }
      return 0
    fi
  done
  echo "[cold-start] missing --run <id>" >&2
  exit 2
}

# Turbobox helpers
tb_exec_sync() {
  # Short sync exec (< 80s). Writes the plain `output` string to stdout.
  # Sync exec does NOT truncate output the way /exec/background does,
  # so use this for short commands (file fetches, quick probes).
  local box_id="$1" cmd="$2"
  local tmp
  tmp=$(mktemp)
  curl -s -X POST "$TURBOBOX_URL/v1/boxes/$box_id/exec" \
    -H "Content-Type: text/plain" \
    --data-binary "$cmd" --max-time 90 > "$tmp" 2>&1
  python3 -c "import json; print(json.load(open('$tmp'), strict=False).get('output','') if isinstance(json.load(open('$tmp'), strict=False), dict) else '')" 2>/dev/null
  rm -f "$tmp"
}

tb_fetch_file() {
  # Read a file from inside the box via sync exec. Used to bypass the 8KB
  # truncation limit on /exec/background output.
  local box_id="$1" path="$2"
  tb_exec_sync "$box_id" "cat '$path' 2>/dev/null"
}

tb_exec_bg() {
  # Background exec + poll for longer-running commands. Writes the inner
  # `output` field directly to stdout without ever holding the full response
  # in a shell variable (bash command substitution truncates/corrupts large
  # bodies in some environments).
  local box_id="$1" cmd="$2" max_wait="${3:-900}"
  local tmp="$(mktemp)"
  local start_resp job_id attempt=0
  while [ "$attempt" -lt 3 ]; do
    attempt=$((attempt+1))
    curl -s -X POST "$TURBOBOX_URL/v1/boxes/$box_id/exec/background" \
      -H "Content-Type: text/plain" \
      --data-binary "$cmd" --max-time 30 > "$tmp" 2>&1
    job_id=$(python3 -c "import json; print(json.load(open('$tmp'), strict=False).get('job_id',''))" 2>/dev/null)
    [ -n "$job_id" ] && break
    sleep 1
  done
  if [ -z "$job_id" ]; then
    cat "$tmp" >&2
    rm -f "$tmp"
    return 1
  fi
  local waited=0 poll=5 notfound=0 status
  while [ "$waited" -lt "$max_wait" ]; do
    sleep "$poll"
    waited=$((waited + poll))
    curl -s "$TURBOBOX_URL/v1/boxes/$box_id/exec/background/$job_id" --max-time 30 > "$tmp" 2>&1
    if grep -qE 'BoxNotFound|not found|Forbidden' "$tmp"; then
      notfound=$((notfound+1))
      [ "$notfound" -ge 3 ] && { rm -f "$tmp"; return 1; }
      continue
    fi
    status=$(python3 -c "import json; print(json.load(open('$tmp'), strict=False).get('status',''))" 2>/dev/null)
    case "$status" in
      completed|failed|killed|stopped)
        python3 -c "import json; print(json.load(open('$tmp'), strict=False).get('output',''))"
        rm -f "$tmp"
        return 0
        ;;
    esac
  done
  rm -f "$tmp"
  return 1
}

box_id_for_run() {
  python3 -c "import json; print(json.load(open('$RUN_DIR/box.json'))['box_id'])"
}

cmd_new() {
  local version="latest" intent="get latest posts" url="https://news.ycombinator.com"
  while [ "$#" -gt 0 ]; do
    case "$1" in
      --version) version="$2"; shift 2 ;;
      --intent)  intent="$2"; shift 2 ;;
      --url)     url="$2"; shift 2 ;;
      *) shift ;;
    esac
  done
  local run_id
  run_id="$(date -u +%Y%m%dT%H%M%SZ)-$(printf '%04x' $((RANDOM % 65536)))"
  local run_dir="$RUNS_DIR/$run_id"
  mkdir -p "$run_dir"

  echo "[new] spawning sandbox for run $run_id..."
  local spawn_resp box_id
  # ttl=3600 (hard kill deadline), idle_timeout=3600 (bypass the 15-min
  # default idle stop — agents are slow reviewers and boxes must outlive
  # the whole review cycle).
  spawn_resp=$(curl -s -X POST "$TURBOBOX_URL/v1/boxes" \
    -H "Content-Type: application/json" \
    -d '{"image":"ubuntu","cpu":2000,"memory":2048,"ttl":3600,"idle_timeout":3600}')
  box_id=$(echo "$spawn_resp" | python3 -c "import sys,json; print(json.load(sys.stdin).get('id',''))" 2>/dev/null)
  if [ -z "$box_id" ]; then
    echo "[new] ✗ spawn failed: $spawn_resp" >&2
    rm -rf "$run_dir"
    exit 1
  fi
  python3 -c "
import json
json.dump({
  'run_id': '$run_id',
  'box_id': '$box_id',
  'version': '$version',
  'intent': '$intent',
  'url': '$url',
  'created_at': '$(date -u +%Y-%m-%dT%H:%M:%SZ)',
}, open('$run_dir/box.json','w'), indent=2)
"
  echo "[new] run_id=$run_id"
  echo "[new] box_id=$box_id"
  echo "[new] version=$version intent=\"$intent\" url=$url"
  echo ""
  echo "next: bash scripts/cold-start-bench.sh install --run $run_id"
}

cmd_install() {
  parse_run "$@"
  local box_id version
  box_id=$(box_id_for_run)
  version=$(python3 -c "import json; print(json.load(open('$RUN_DIR/box.json'))['version'])")
  echo "[install] installing unbrowse@$version in $box_id..."

  local script
  script=$(cat <<BOXEOF
export HOME=/root
export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:/root/.npm-global/bin
export UNBROWSE_NON_INTERACTIVE=1
export UNBROWSE_TOS_ACCEPTED=1
npm config set prefix /root/.npm-global >/dev/null 2>&1
npm install -g unbrowse@$version 2>&1 | tail -5
echo "INSTALL_RC=\$?"
echo "INSTALLED_VERSION=\$(unbrowse --version 2>/dev/null)"
echo "UNBROWSE_BIN=\$(which unbrowse 2>/dev/null)"
ls /root/.npm-global/lib/node_modules/unbrowse/bin/ 2>/dev/null
BOXEOF
)
  local out_file="$RUN_DIR/.install.raw"
  tb_exec_bg "$box_id" "$script" 300 > "$out_file"
  RUN_DIR_ARG="$RUN_DIR" python3 <<'PYEOF'
import json, os, re
out = open(os.environ['RUN_DIR_ARG'] + '/.install.raw').read()
rc = 1
m = re.search(r'INSTALL_RC=(\d+)', out)
if m: rc = int(m.group(1))
ver = ''
m = re.search(r'INSTALLED_VERSION=(\S+)', out)
if m: ver = m.group(1)
binp = ''
m = re.search(r'UNBROWSE_BIN=(\S+)', out)
if m: binp = m.group(1)
json.dump({
  'install_rc': rc,
  'installed_version': ver,
  'unbrowse_bin': binp,
  'tail': out[-1000:],
}, open(os.environ['RUN_DIR_ARG'] + '/install.json','w'), indent=2)
print(f'[install] rc={rc} version={ver}')
PYEOF
  echo ""
  echo "review: cat $RUN_DIR/install.json"
  echo "next:   bash scripts/cold-start-bench.sh setup --run $RUN_ID"
}

cmd_setup() {
  parse_run "$@"
  local box_id
  box_id=$(box_id_for_run)
  echo "[setup] running unbrowse setup in $box_id..."

  local script
  script=$(cat <<'BOXEOF'
export HOME=/root
export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:/root/.npm-global/bin
export UNBROWSE_NON_INTERACTIVE=1
export UNBROWSE_TOS_ACCEPTED=1
unbrowse setup --no-start > /tmp/setup-out.log 2>&1
echo SETUP_RC=$?
echo === HEALTH ===
unbrowse health 2>&1 | head -20
echo === CONFIG_FILE ===
# unbrowse saves its API key + agent profile here
ls -la /root/.unbrowse/config.json 2>&1
python3 -c "
import json, os
p = '/root/.unbrowse/config.json'
if os.path.exists(p):
    d = json.load(open(p))
    redacted = {k: (v if k != 'api_key' else '<redacted>') for k,v in d.items()}
    print('config_keys:', sorted(d.keys()))
    print(json.dumps(redacted, indent=2))
else:
    print('MISSING')
" 2>&1
BOXEOF
)
  local out_file="$RUN_DIR/.setup.raw"
  tb_exec_bg "$box_id" "$script" 180 > "$out_file"
  RUN_DIR_ARG="$RUN_DIR" python3 <<'PYEOF'
import json, os, re
out = open(os.environ['RUN_DIR_ARG'] + '/.setup.raw').read()
rc = 1
m = re.search(r'SETUP_RC=(\d+)', out)
if m: rc = int(m.group(1))
health = ''
hm = re.search(r'=== HEALTH ===\n(.+?)\n===', out, re.S)
if hm: health = hm.group(1).strip()
config_present = 'config_keys' in out and "api_key'" in out
api_key_saved = "'api_key'" in out
agent_id_saved = "'agent_id'" in out
json.dump({
  'setup_rc': rc,
  'health_excerpt': health[:2000],
  'config_present': config_present,
  'api_key_saved': api_key_saved,
  'agent_id_saved': agent_id_saved,
  'tail': out[-2500:],
}, open(os.environ['RUN_DIR_ARG'] + '/setup.json','w'), indent=2)
print(f'[setup] rc={rc} config_present={config_present} api_key_saved={api_key_saved} agent_id_saved={agent_id_saved}')
PYEOF
  echo ""
  echo "review: cat $RUN_DIR/setup.json"
  echo "agent: decide if setup looks healthy before proceeding"
  echo "next:  bash scripts/cold-start-bench.sh resolve --run $RUN_ID"
}

cmd_resolve() {
  parse_run "$@"
  local box_id intent url
  box_id=$(box_id_for_run)
  intent=$(python3 -c "import json; print(json.load(open('$RUN_DIR/box.json'))['intent'])")
  url=$(python3 -c "import json; print(json.load(open('$RUN_DIR/box.json'))['url'])")
  echo "[resolve] force-capture on $url in $box_id..."

  local script
  script=$(cat <<BOXEOF
export HOME=/root
export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:/root/.npm-global/bin
export UNBROWSE_NON_INTERACTIVE=1
export UNBROWSE_TOS_ACCEPTED=1
START=\$(date +%s%3N)
timeout 180 unbrowse resolve --intent "$intent" --url "$url" --force-capture > /tmp/resolve.log 2>&1
END=\$(date +%s%3N)
echo RESOLVE_MS=\$((END-START))
echo RESOLVE_LOG_SIZE=\$(wc -c < /tmp/resolve.log)
BOXEOF
)
  local out_file="$RUN_DIR/.resolve.raw"
  # Background exec for the bg-job wall-clock, stdout just carries the summary
  local summary_file="$RUN_DIR/.resolve.summary"
  tb_exec_bg "$box_id" "$script" 300 > "$summary_file"
  # Fetch the full resolve log via sync exec (bypasses 8KB bg truncation)
  tb_fetch_file "$box_id" "/tmp/resolve.log" > "$out_file"
  RUN_DIR_ARG="$RUN_DIR" python3 <<'PYEOF'
import json, os, re
out = open(os.environ['RUN_DIR_ARG'] + '/.resolve.raw').read()
summary = open(os.environ['RUN_DIR_ARG'] + '/.resolve.summary').read() if os.path.exists(os.environ['RUN_DIR_ARG'] + '/.resolve.summary') else ''
ms = 0
m = re.search(r'RESOLVE_MS=(\d+)', summary)
if m: ms = int(m.group(1))
# Find the resolve JSON payload — look for the top-level object containing
# both "trace" and "result" keys (that's the resolve response shape)
d = {}
for m in re.finditer(r'\{"trace"\s*:', out):
    try:
        d = json.JSONDecoder(strict=False).raw_decode(out[m.start():])[0]
        break
    except Exception:
        continue
result = d.get('result', {}) if isinstance(d, dict) else {}
ops = []
if isinstance(result, dict):
    ops = result.get('available_operations') or result.get('available_endpoints') or []
# Extract skill id from multiple possible locations
skill_id = ''
if isinstance(result, dict):
    skill_id = result.get('skill_id','')
if not skill_id and isinstance(d.get('skill'), dict):
    skill_id = d['skill'].get('skill_id','')
if not skill_id and isinstance(d.get('trace'), dict):
    skill_id = d['trace'].get('skill_id','')
json.dump({
  'elapsed_ms': ms,
  'skill_id': skill_id,
  'error': result.get('error','') if isinstance(result, dict) else '',
  'error_message': result.get('message','') if isinstance(result, dict) else '',
  'endpoint_count': len(ops),
  'available_endpoints': ops,
  'raw_tail': out[-2000:],
}, open(os.environ['RUN_DIR_ARG'] + '/resolve.json','w'), indent=2)
print(f'[resolve] ms={ms} skill_id={skill_id} endpoints={len(ops)}')
if isinstance(result, dict) and result.get('error'):
    err = result.get('error','')
    msg = result.get('message','')[:100]
    print(f'[resolve] error: {err} / {msg}')
PYEOF
  echo ""
  echo "review: cat $RUN_DIR/resolve.json"
  echo "agent: look at available_endpoints, pick the one whose description matches the intent"
  echo "next:  bash scripts/cold-start-bench.sh inspect --run $RUN_ID"
  echo "       bash scripts/cold-start-bench.sh execute --run $RUN_ID --endpoint <agent-chosen-id>"
}

cmd_inspect() {
  parse_run "$@"
  local box_id skill_id
  box_id=$(box_id_for_run)
  skill_id=$(python3 -c "
import json
try: print(json.load(open('$RUN_DIR/resolve.json')).get('skill_id',''))
except: print('')
")
  if [ -z "$skill_id" ]; then
    echo "[inspect] no skill_id in resolve.json — run resolve first" >&2
    exit 2
  fi
  echo "[inspect] reading skill $skill_id..."

  local script
  script=$(cat <<BOXEOF
export HOME=/root
export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:/root/.npm-global/bin
export UNBROWSE_NON_INTERACTIVE=1
unbrowse skill $skill_id > /tmp/skill.log 2>&1
echo SKILL_RC=\$?
BOXEOF
)
  local out_file="$RUN_DIR/.skill.raw"
  tb_exec_bg "$box_id" "$script" 60 > "$RUN_DIR/.skill.summary"
  tb_fetch_file "$box_id" "/tmp/skill.log" > "$out_file"
  RUN_DIR_ARG="$RUN_DIR" SKILL_ID_ARG="$skill_id" python3 <<'PYEOF'
import json, os, re
out = open(os.environ['RUN_DIR_ARG'] + '/.skill.raw').read()
d = {}
for m in re.finditer(r'\{', out):
    try:
        d = json.JSONDecoder(strict=False).raw_decode(out[m.start():])[0]
        if isinstance(d, dict) and (d.get('endpoints') or d.get('skill_id')):
            break
    except Exception:
        continue
json.dump({
  'skill_id': os.environ['SKILL_ID_ARG'],
  'skill_detail': d,
  'raw_tail': out[-1500:],
}, open(os.environ['RUN_DIR_ARG'] + '/skill.json','w'), indent=2)
ep_count = len(d.get('endpoints',[])) if isinstance(d, dict) else 0
print(f'[inspect] captured skill detail ({ep_count} endpoints)')
PYEOF
  echo ""
  echo "review: cat $RUN_DIR/skill.json  (read semantic.description_out, action_kind, response_schema per endpoint)"
  echo "agent: judge reverse-engineer quality — is each endpoint semantically populated?"
}

cmd_execute() {
  parse_run "$@"
  local endpoint=""
  for ((i=1; i<=$#; i++)); do
    if [ "${!i}" = "--endpoint" ]; then j=$((i+1)); endpoint="${!j}"; fi
  done
  if [ -z "$endpoint" ]; then
    echo "[execute] --endpoint <id> required (agent must pick from resolve.json)" >&2
    exit 2
  fi
  local box_id skill_id
  box_id=$(box_id_for_run)
  skill_id=$(python3 -c "import json; print(json.load(open('$RUN_DIR/resolve.json'))['skill_id'])")
  echo "[execute] skill=$skill_id endpoint=$endpoint (agent-chosen)"

  local safe_ep
  safe_ep=$(echo "$endpoint" | tr -c 'a-zA-Z0-9_-' '_')
  local script
  script=$(cat <<BOXEOF
export HOME=/root
export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:/root/.npm-global/bin
export UNBROWSE_NON_INTERACTIVE=1
START=\$(date +%s%3N)
timeout 60 unbrowse execute --skill $skill_id --endpoint $endpoint --raw > /tmp/execute-$safe_ep.log 2>&1
END=\$(date +%s%3N)
echo EXECUTE_MS=\$((END-START))
BOXEOF
)
  local out_file="$RUN_DIR/.execute-$safe_ep.raw"
  tb_exec_bg "$box_id" "$script" 120 > "$RUN_DIR/.execute-$safe_ep.summary"
  tb_fetch_file "$box_id" "/tmp/execute-$safe_ep.log" > "$out_file"
  RUN_DIR_ARG="$RUN_DIR" ENDPOINT_ARG="$endpoint" SKILL_ID_ARG="$skill_id" SAFE_EP_ARG="$safe_ep" python3 <<'PYEOF'
import json, os, re
out = open(os.environ['RUN_DIR_ARG'] + '/.execute-' + os.environ['SAFE_EP_ARG'] + '.raw').read()
summary_path = os.environ['RUN_DIR_ARG'] + '/.execute-' + os.environ['SAFE_EP_ARG'] + '.summary'
summary = open(summary_path).read() if os.path.exists(summary_path) else ''
ms = 0
m = re.search(r'EXECUTE_MS=(\d+)', summary)
if m: ms = int(m.group(1))
d = {}
for m in re.finditer(r'\{"trace"\s*:', out):
    try:
        d = json.JSONDecoder(strict=False).raw_decode(out[m.start():])[0]
        break
    except Exception:
        continue
json.dump({
  'endpoint_id': os.environ['ENDPOINT_ARG'],
  'skill_id': os.environ['SKILL_ID_ARG'],
  'elapsed_ms': ms,
  'execute_response': d,
  'raw_tail': out[-2000:],
}, open(os.environ['RUN_DIR_ARG'] + '/execute-' + os.environ['SAFE_EP_ARG'] + '.json','w'), indent=2)
print(f'[execute] ms={ms}')
PYEOF
  echo ""
  echo "review: cat $RUN_DIR/execute-$safe_ep.json"
  echo "agent: judge the response semantically — does it match the intent for real?"
}

cmd_rerun_resolve() {
  parse_run "$@"
  local box_id intent url
  box_id=$(box_id_for_run)
  intent=$(python3 -c "import json; print(json.load(open('$RUN_DIR/box.json'))['intent'])")
  url=$(python3 -c "import json; print(json.load(open('$RUN_DIR/box.json'))['url'])")
  echo "[rerun-resolve] cache-hit test on $url..."

  local script
  script=$(cat <<BOXEOF
export HOME=/root
export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:/root/.npm-global/bin
export UNBROWSE_NON_INTERACTIVE=1
START=\$(date +%s%3N)
timeout 30 unbrowse resolve --intent "$intent" --url "$url" 2>&1 | head -80
END=\$(date +%s%3N)
echo RERUN_MS=\$((END-START))
BOXEOF
)
  local out_file="$RUN_DIR/.rerun.raw"
  tb_exec_bg "$box_id" "$script" 60 > "$out_file"
  RUN_DIR_ARG="$RUN_DIR" python3 <<'PYEOF'
import json, os, re
out = open(os.environ['RUN_DIR_ARG'] + '/.rerun.raw').read()
ms = 0
m = re.search(r'RERUN_MS=(\d+)', out)
if m: ms = int(m.group(1))
d = {}
for m in re.finditer(r'\{"trace"\s*:', out):
    try:
        d = json.JSONDecoder(strict=False).raw_decode(out[m.start():])[0]
        break
    except Exception:
        continue
result = d.get('result', {}) if isinstance(d, dict) else {}
source = result.get('source','') if isinstance(result, dict) else ''
ops = result.get('available_operations') or result.get('available_endpoints') or [] if isinstance(result, dict) else []
json.dump({
  'elapsed_ms': ms,
  'source': source,
  'endpoint_count': len(ops),
  'raw_tail': out[-1000:],
}, open(os.environ['RUN_DIR_ARG'] + '/rerun.json','w'), indent=2)
print(f'[rerun-resolve] ms={ms} source={source or "?"}')
PYEOF
  echo ""
  echo "review: cat $RUN_DIR/rerun.json  (compare elapsed_ms to resolve.json — cache hit should be <500ms)"
}

cmd_verdict() {
  parse_run "$@"
  local step="" state="" note=""
  while [ "$#" -gt 0 ]; do
    case "$1" in
      --run) shift 2 ;;
      --step) step="$2"; shift 2 ;;
      --state) state="$2"; shift 2 ;;
      --note) note="$2"; shift 2 ;;
      *) shift ;;
    esac
  done
  if [ -z "$step" ] || [ -z "$state" ]; then
    echo "[verdict] --step STEP --state STATE required" >&2
    exit 2
  fi
  RUN_DIR_ARG="$RUN_DIR" STEP_ARG="$step" STATE_ARG="$state" NOTE_ARG="$note" python3 <<'PYEOF'
import json, os, time
f = os.environ['RUN_DIR_ARG'] + '/verdict.json'
d = json.load(open(f)) if os.path.exists(f) else {'entries': []}
d.setdefault('entries', []).append({
  'ts': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()),
  'step': os.environ['STEP_ARG'],
  'state': os.environ['STATE_ARG'],
  'note': os.environ['NOTE_ARG'],
})
json.dump(d, open(f,'w'), indent=2)
print(f'[verdict] {os.environ["STEP_ARG"]}={os.environ["STATE_ARG"]} logged')
PYEOF
}

cmd_finalize() {
  parse_run "$@"
  local box
  box=$(python3 -c "import json; b=json.load(open('$RUN_DIR/box.json')); print(json.dumps(b))")
  python3 -c "
import json, os, datetime
b = json.loads('$box')
verdict_path = '$RUN_DIR/verdict.json'
if not os.path.exists(verdict_path):
    print('[finalize] ✗ no verdict.json — agent must log verdicts before finalize')
    raise SystemExit(2)
entries = json.load(open(verdict_path)).get('entries', [])
latest = {}
for e in entries:
    latest[e['step']] = e['state']
steps_order = ['install','setup','capture','re_extracted','semantic_meta','execute','cache_hit']
overall = 'pass'
if any(latest.get(s) == 'fail' for s in steps_order):
    overall = 'fail'
elif any(latest.get(s) == 'block' for s in steps_order):
    overall = 'partial'
elif any(latest.get(s) in (None, 'partial') for s in steps_order):
    overall = 'partial'
record = {
    'date': datetime.datetime.utcnow().isoformat() + 'Z',
    'run_id': b['run_id'],
    'version': b['version'],
    'url': b['url'],
    'intent': b['intent'],
    'steps': {s: latest.get(s, 'unknown') for s in steps_order},
    'verdict': overall,
}
hist = '$HISTORY_FILE'
os.makedirs(os.path.dirname(hist), exist_ok=True)
with open(hist, 'a') as f:
    f.write(json.dumps(record) + '\n')
print(json.dumps(record, indent=2))
print(f'\\n[finalize] appended to $HISTORY_FILE')
"
}

cmd_destroy() {
  parse_run "$@"
  local box_id
  box_id=$(box_id_for_run)
  echo "[destroy] $box_id"
  curl -s -X DELETE "$TURBOBOX_URL/v1/boxes/$box_id" >/dev/null
  python3 -c "
import json
b = json.load(open('$RUN_DIR/box.json'))
b['destroyed_at'] = '$(date -u +%Y-%m-%dT%H:%M:%SZ)'
json.dump(b, open('$RUN_DIR/box.json','w'), indent=2)
"
  echo "[destroy] sandbox gone — run dir kept at $RUN_DIR"
}

cmd_show() {
  parse_run "$@"
  for f in box.json install.json setup.json resolve.json skill.json rerun.json verdict.json; do
    if [ -f "$RUN_DIR/$f" ]; then
      echo "=== $f ==="
      cat "$RUN_DIR/$f"
      echo ""
    fi
  done
  for f in "$RUN_DIR"/execute-*.json; do
    [ -f "$f" ] || continue
    echo "=== $(basename "$f") ==="
    cat "$f"
    echo ""
  done
}

cmd_list() {
  python3 - "$RUNS_DIR" <<'PYEOF'
import json, os, sys
d = sys.argv[1]
if not os.path.isdir(d):
    print("no runs")
    sys.exit(0)
rows = []
for name in sorted(os.listdir(d)):
    p = os.path.join(d, name, 'box.json')
    if not os.path.exists(p): continue
    try:
        b = json.load(open(p))
    except: continue
    v = 'unfinalized'
    vp = os.path.join(d, name, 'verdict.json')
    if os.path.exists(vp):
        try:
            ve = json.load(open(vp)).get('entries',[])
            if ve: v = ve[-1].get('state','?')
        except: pass
    rows.append((name, b.get('version','?'), b.get('url','?')[:40], v))
if not rows:
    print("no runs")
    sys.exit(0)
print(f"{'run_id':30} {'version':12} {'url':42} {'latest':10}")
print('-'*100)
for r in rows: print(f'{r[0]:30} {r[1]:12} {r[2]:42} {r[3]:10}')
PYEOF
}

cmd_history() {
  if [ ! -f "$HISTORY_FILE" ]; then
    echo "no history"
    exit 0
  fi
  python3 - "$HISTORY_FILE" <<'PYEOF'
import json, sys
print(f"{'date':20} {'version':14} {'site':28} {'install':8} {'setup':7} {'capture':8} {'re':4} {'meta':5} {'exec':5} {'cache':6} {'verdict':8}")
print('-'*125)
for line in open(sys.argv[1]):
    try:
        r = json.loads(line)
        s = r.get('steps', {})
        site = r.get('url','?').replace('https://','')[:28]
        print(f"{r.get('date','?')[:19]:20} {r.get('version','?'):14} {site:28} {s.get('install','-'):8} {s.get('setup','-'):7} {s.get('capture','-'):8} {s.get('re_extracted','-'):4} {s.get('semantic_meta','-'):5} {s.get('execute','-'):5} {s.get('cache_hit','-'):6} {r.get('verdict','?'):8}")
    except Exception: pass
PYEOF
}

# ── dispatch ──
CMD="${1:-help}"
shift || true
case "$CMD" in
  new)            cmd_new "$@" ;;
  install)        cmd_install "$@" ;;
  setup)          cmd_setup "$@" ;;
  resolve)        cmd_resolve "$@" ;;
  inspect)        cmd_inspect "$@" ;;
  execute)        cmd_execute "$@" ;;
  rerun-resolve)  cmd_rerun_resolve "$@" ;;
  verdict)        cmd_verdict "$@" ;;
  finalize)       cmd_finalize "$@" ;;
  destroy)        cmd_destroy "$@" ;;
  show)           cmd_show "$@" ;;
  list)           cmd_list "$@" ;;
  history)        cmd_history "$@" ;;
  help|*)
    sed -n '1,80p' "${BASH_SOURCE[0]}" | sed -n '1,/^# No sub-command/p'
    ;;
esac
