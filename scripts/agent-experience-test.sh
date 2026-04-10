#!/usr/bin/env bash
# agent-experience-test.sh — collect agent workflow artifacts for agent review
#
# Outputs structured JSON artifacts. The calling agent judges pass/fail.
# This is not a deterministic test — it's an evidence collector.
#
# Usage:
#   bash scripts/agent-experience-test.sh                    # local
#   bash scripts/agent-experience-test.sh --remote HOST      # remote via SSH
#
set -uo pipefail

REMOTE=""
for arg in "$@"; do
  case "$arg" in
    --remote) shift; REMOTE="${1:-}"; shift || true ;;
  esac
done

if [ -n "$REMOTE" ]; then
  exec ssh -o ConnectTimeout=10 -o ServerAliveInterval=30 "$REMOTE" \
    "bash -s" < "$0"
fi

# ── Target host ──
export PATH="$HOME/.npm-global/bin:/usr/local/bin:$PATH"
export UNBROWSE_NON_INTERACTIVE=1
export UNBROWSE_TOS_ACCEPTED=1

RESULTS_FILE="/tmp/agent-xp-results.json"
echo '{"tasks":[]}' > "$RESULTS_FILE"

# Strip unbrowse log lines like [domain-cache], [route-cache], [unbrowse] and
# capture-pipeline noise, leaving only JSON payload. The CLI mixes logs with
# JSON on stdout. JSON can be single-line or pretty-printed multi-line.
strip_logs() {
  python3 -c "
import sys, json
raw = sys.stdin.read()
decoder = json.JSONDecoder()
# Find first { or [ and decode greedy JSON from there
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

# Call unbrowse and return only the JSON from stdout
call() {
  "$@" 2>/dev/null | strip_logs
}

record() {
  local task="$1" raw="$2"
  # Write raw to a temp file to avoid bash quote escaping hell
  local tmpf
  tmpf=$(mktemp)
  printf '%s' "$raw" > "$tmpf"
  TASK_NAME="$task" RAW_FILE="$tmpf" RESULTS_FILE="$RESULTS_FILE" python3 -c "
import json, os
task = os.environ['TASK_NAME']
raw_file = os.environ['RAW_FILE']
results_file = os.environ['RESULTS_FILE']
with open(results_file) as f: results = json.load(f)
with open(raw_file) as f: raw = f.read()
try:
    data = json.loads(raw) if raw.strip() else raw
except Exception:
    data = raw
results['tasks'].append({'task': task, 'output': data})
with open(results_file, 'w') as f: json.dump(results, f)
" 2>/dev/null
  rm -f "$tmpf"
}

# ── System state before Unbrowse touches anything ──
record "system_before" "$(python3 -c "
import json, subprocess, os
procs = subprocess.run(['ps', 'aux'], capture_output=True, text=True).stdout
chrome_count = procs.count('chrome')
kuri_count = procs.count('kuri')
node_count = procs.count('node')
unbrowse_count = procs.count('unbrowse')
ports = subprocess.run(['ss', '-tlnp'], capture_output=True, text=True).stdout if os.path.exists('/usr/sbin/ss') else ''
mem = subprocess.run(['free', '-m'], capture_output=True, text=True).stdout if os.path.exists('/usr/bin/free') else ''
print(json.dumps({
  'chrome_processes': chrome_count,
  'kuri_processes': kuri_count,
  'node_processes': node_count,
  'unbrowse_processes': unbrowse_count,
  'listening_ports': [l.strip() for l in ports.split(chr(10)) if '6969' in l or '7700' in l or '9222' in l],
  'memory_mb': mem.split(chr(10))[1].split() if mem and len(mem.split(chr(10))) > 1 else [],
}))
" 2>/dev/null || echo '{}')"

# ── Collect evidence ──

# Version + health
record "version" "$(unbrowse --version 2>/dev/null || echo 'unknown')"

# ── Onboarding checks: the agent experience starts at install ──
record "onboarding" "$(python3 -c "
import os, json, subprocess, shutil
out = {}
out['binary_on_path'] = bool(shutil.which('unbrowse'))
cfg_path = os.path.expanduser('~/.unbrowse/config.json')
if os.path.exists(cfg_path):
    try:
        d = json.load(open(cfg_path))
        out['config_exists'] = True
        out['has_api_key'] = bool(d.get('api_key'))
        out['has_wallet'] = bool(d.get('wallet_address'))
        out['agent_email'] = d.get('agent_email','') or ''
    except: out['config_exists'] = False
else:
    out['config_exists'] = False
out['kuri_extracted'] = os.path.exists(os.path.expanduser('~/.unbrowse/bin/kuri'))
out['traces_dir_exists'] = os.path.exists(os.path.expanduser('~/.unbrowse/traces'))
out['has_agentmail_key'] = bool(os.environ.get('AGENTMAIL_API_KEY',''))
# Server reachable
try:
    r = subprocess.run(['curl','-s','-o','/dev/null','-w','%{http_code}','http://localhost:6969/health','--max-time','3'], capture_output=True, text=True, timeout=5)
    out['server_http_code'] = r.stdout.strip() or '000'
except: out['server_http_code'] = 'error'
print(json.dumps(out))
" 2>/dev/null || echo '{}')"

# Agentmail auto-registration: a fresh agent should be able to create an
# email identity without human intervention. If AGENTMAIL_API_KEY is set,
# try creating a session. If not, record that as a real gap.
record "onboarding_agentmail" "$(
if [ -n \"\${AGENTMAIL_API_KEY:-}\" ]; then
  unbrowse login-auto example.com --send-to nobody@example.com --subject probe --body probe 2>&1 | python3 -c \"
import sys, json
raw = sys.stdin.read()
# Find JSON in output
for line in raw.split(chr(10)):
    try:
        d = json.loads(line.strip())
        if 'email' in d or 'error' in d:
            print(json.dumps({'has_email_identity': 'email' in d, 'error': d.get('error'), 'email_domain': d.get('email','').split('@')[-1] if '@' in d.get('email','') else None}))
            exit(0)
    except: pass
print(json.dumps({'has_email_identity': False, 'error': 'no JSON in login-auto output', 'raw_preview': raw[:100]}))
\" 2>/dev/null
else
  echo '{\"has_email_identity\":false,\"error\":\"AGENTMAIL_API_KEY not set\"}'
fi
)"
record "health" "$(unbrowse health 2>/dev/null || echo '{\"error\":\"health_failed\"}')"

# Resolve: does the marketplace return endpoints?
record "resolve_pypi_flask" "$(unbrowse resolve --intent 'get package info' --url 'https://pypi.org/project/flask/' --pretty 2>/dev/null)"

# Execute: does calling an endpoint return data?
RESOLVE=$(call unbrowse resolve --intent 'get package info' --url 'https://pypi.org/project/flask/')
SKILL=$(echo "$RESOLVE" | python3 -c "import sys,json; d=json.loads(sys.stdin.read()); print(d.get('trace',{}).get('skill_id',''))" 2>/dev/null)
EP=$(echo "$RESOLVE" | python3 -c "import sys,json; d=json.loads(sys.stdin.read()); ops=d.get('result',{}).get('available_operations',[]); print(ops[0]['endpoint_id'] if ops else '')" 2>/dev/null)
if [ -n "$SKILL" ] && [ -n "$EP" ]; then
  record "execute_pypi_flask" "$(call unbrowse execute --skill "$SKILL" --endpoint "$EP" --url 'https://pypi.org/project/flask/' --raw --pretty)"
fi

# Parameterized search: can the agent fill template params?
RESOLVE_NPM=$(call unbrowse resolve --intent 'search packages' --url 'https://registry.npmjs.org/-/v1/search?text=express')
SKILL_NPM=$(echo "$RESOLVE_NPM" | python3 -c "import sys,json; d=json.loads(sys.stdin.read()); print(d.get('trace',{}).get('skill_id',''))" 2>/dev/null)
EP_NPM=$(echo "$RESOLVE_NPM" | python3 -c "import sys,json; d=json.loads(sys.stdin.read()); ops=d.get('result',{}).get('available_operations',[]); print(ops[0]['endpoint_id'] if ops else '')" 2>/dev/null)
if [ -n "$SKILL_NPM" ] && [ -n "$EP_NPM" ]; then
  record "execute_npm_search" "$(call unbrowse execute --skill "$SKILL_NPM" --endpoint "$EP_NPM" --url 'https://registry.npmjs.org/-/v1/search?text=express' --params '{"q":"express"}' --raw --pretty)"
fi

# Feedback: does the loop close?
if [ -n "$SKILL" ] && [ -n "$EP" ]; then
  record "feedback" "$(call unbrowse feedback --skill "$SKILL" --endpoint "$EP" --rating 5 --outcome success)"
fi

# Browse: can the agent drive a browser?
for attempt in 1 2 3; do
  GO=$(unbrowse go 'https://example.com' 2>/dev/null) || true
  if echo "$GO" | python3 -c "import sys,json; exit(0 if json.loads(sys.stdin.read()).get('ok') else 1)" 2>/dev/null; then
    SESSION=$(echo "$GO" | python3 -c "import sys,json; print(json.loads(sys.stdin.read())['session_id'])" 2>/dev/null)
    record "browse_go" "$GO"
    record "browse_eval" "$(unbrowse eval --session "$SESSION" "JSON.stringify({title:document.title,h1:document.querySelector('h1')?.textContent,bodyLen:document.body.innerHTML.length})" 2>/dev/null)"
    record "browse_snap_head" "$(unbrowse snap --session "$SESSION" 2>/dev/null | head -15)"
    record "browse_close" "$(unbrowse close --session "$SESSION" 2>/dev/null)"
    break
  fi
  sleep 5
done

# ── System state after tests — what did Unbrowse leave running? ──
record "system_after" "$(python3 -c "
import json, subprocess, os
procs = subprocess.run(['ps', 'aux'], capture_output=True, text=True).stdout
chrome_lines = [l.strip() for l in procs.split(chr(10)) if 'chrome' in l.lower() and 'defunct' not in l]
kuri_lines = [l.strip()[:80] for l in procs.split(chr(10)) if 'kuri' in l]
unbrowse_lines = [l.strip()[:80] for l in procs.split(chr(10)) if 'unbrowse' in l and 'agent-xp' not in l]
zombies = procs.count('<defunct>')
print(json.dumps({
  'chrome_alive': len(chrome_lines),
  'kuri_alive': len(kuri_lines),
  'unbrowse_alive': len(unbrowse_lines),
  'zombie_count': zombies,
}))
" 2>/dev/null || echo '{}')"

# ── Output the artifact ──
pkill -9 -f 'unbrowse|kuri' 2>/dev/null || true
cat "$RESULTS_FILE"
