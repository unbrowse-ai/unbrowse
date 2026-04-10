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

record() {
  local task="$1" raw="$2"
  python3 -c "
import json, sys
with open('$RESULTS_FILE') as f: results = json.load(f)
try:
    data = json.loads('''$(echo "$raw" | sed "s/'/\\\\'/g")''')
except: data = '''$(echo "$raw" | head -c 500 | sed "s/'/\\\\'/g")'''
results['tasks'].append({'task': '$task', 'output': data})
with open('$RESULTS_FILE', 'w') as f: json.dump(results, f)
" 2>/dev/null
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
record "health" "$(unbrowse health 2>/dev/null || echo '{\"error\":\"health_failed\"}')"

# Resolve: does the marketplace return endpoints?
record "resolve_pypi_flask" "$(unbrowse resolve --intent 'get package info' --url 'https://pypi.org/project/flask/' --pretty 2>/dev/null)"

# Execute: does calling an endpoint return data?
RESOLVE=$(unbrowse resolve --intent 'get package info' --url 'https://pypi.org/project/flask/' 2>/dev/null)
SKILL=$(echo "$RESOLVE" | python3 -c "import sys,json; d=json.loads(sys.stdin.read()); print(d.get('trace',{}).get('skill_id',''))" 2>/dev/null)
EP=$(echo "$RESOLVE" | python3 -c "import sys,json; d=json.loads(sys.stdin.read()); ops=d.get('result',{}).get('available_operations',[]); print(ops[0]['endpoint_id'] if ops else '')" 2>/dev/null)
if [ -n "$SKILL" ] && [ -n "$EP" ]; then
  record "execute_pypi_flask" "$(unbrowse execute --skill "$SKILL" --endpoint "$EP" --url 'https://pypi.org/project/flask/' --raw --pretty 2>/dev/null)"
fi

# Parameterized search: can the agent fill template params?
RESOLVE_NPM=$(unbrowse resolve --intent 'search packages' --url 'https://registry.npmjs.org/-/v1/search?text=express' 2>/dev/null)
SKILL_NPM=$(echo "$RESOLVE_NPM" | python3 -c "import sys,json; d=json.loads(sys.stdin.read()); print(d.get('trace',{}).get('skill_id',''))" 2>/dev/null)
EP_NPM=$(echo "$RESOLVE_NPM" | python3 -c "import sys,json; d=json.loads(sys.stdin.read()); ops=d.get('result',{}).get('available_operations',[]); print(ops[0]['endpoint_id'] if ops else '')" 2>/dev/null)
if [ -n "$SKILL_NPM" ] && [ -n "$EP_NPM" ]; then
  record "execute_npm_search" "$(unbrowse execute --skill "$SKILL_NPM" --endpoint "$EP_NPM" --url 'https://registry.npmjs.org/-/v1/search?text=express' --params '{"q":"express"}' --raw --pretty 2>/dev/null)"
fi

# Feedback: does the loop close?
if [ -n "$SKILL" ] && [ -n "$EP" ]; then
  record "feedback" "$(unbrowse feedback --skill "$SKILL" --endpoint "$EP" --rating 5 --outcome success 2>/dev/null)"
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
