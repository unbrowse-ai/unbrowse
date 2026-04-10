#!/usr/bin/env bash
# drop-in-onboarding-test.sh — verify perfect drop-in agent experience
#
# Simulates a fresh agent that has NOTHING:
#   - no unbrowse binary
#   - no ~/.unbrowse config
#   - no skill pre-installed
#   - no prior API key
#
# Then verifies the agent can, purely via CLI, get to the point of
# successfully running resolve → execute → get real data. Every step
# must be discoverable from the CLI output itself.
#
# Usage:
#   bash scripts/drop-in-onboarding-test.sh --remote lekt8@89.169.121.108
#
set -uo pipefail

REMOTE=""
for arg in "$@"; do
  case "$arg" in
    --remote) shift; REMOTE="${1:-}"; shift || true ;;
  esac
done

if [ -n "$REMOTE" ]; then
  exec ssh -o ConnectTimeout=10 -o ServerAliveInterval=30 "$REMOTE" "bash -s" < "$0"
fi

# ── Running on target host ──
RESULTS=/tmp/drop-in-results.json
echo '{"steps":[]}' > "$RESULTS"

record() {
  local step="$1" status="$2" detail="$3"
  TMPF=$(mktemp)
  printf '%s' "$detail" > "$TMPF"
  STEP="$step" STATUS="$status" DETAIL_FILE="$TMPF" RESULTS="$RESULTS" python3 -c "
import json, os
with open(os.environ['RESULTS']) as f: d = json.load(f)
with open(os.environ['DETAIL_FILE']) as f: detail = f.read()
d['steps'].append({'step': os.environ['STEP'], 'status': os.environ['STATUS'], 'detail': detail[:500]})
with open(os.environ['RESULTS'], 'w') as f: json.dump(d, f)
" 2>/dev/null
  rm -f "$TMPF"
  echo "[drop-in] $step: $status" >&2
}

# ── Step 0: wipe prior state (simulate fresh agent) ──
echo "[drop-in] WIPING prior state..." >&2
pkill -u "$USER" -f 'unbrowse|kuri|node.*unbrowse' 2>/dev/null || true
sleep 1
rm -rf ~/.unbrowse 2>/dev/null || true
# Keep ~/.npm-global but remove the unbrowse install
NPM_BIN="${HOME}/.npm-global/bin"
if [ -f "$NPM_BIN/unbrowse" ]; then
  npm uninstall -g unbrowse 2>/dev/null || rm -f "$NPM_BIN/unbrowse"
fi

# Verify wipe
if [ -d ~/.unbrowse ] || [ -f "$NPM_BIN/unbrowse" ]; then
  record "wipe" "FAIL" "$(ls -la ~/.unbrowse $NPM_BIN/unbrowse 2>&1 | head -5)"
  python3 -c "import json; print(json.dumps(json.load(open('$RESULTS')), indent=2))"
  exit 1
fi
record "wipe" "PASS" "clean slate confirmed"

# ── Step 1: install from npm (no skill, no config) ──
export PATH="$HOME/.npm-global/bin:/usr/local/bin:$PATH"
INSTALL_LOG=$(mktemp)
npm cache clean --force 2>/dev/null || true
if npm install -g unbrowse@preview > "$INSTALL_LOG" 2>&1; then
  # Verify: the binary symlink resolves AND points to the installed package version
  cli_version=$("$NPM_BIN/unbrowse" --version 2>/dev/null || echo "not found")
  pkg_version=$(python3 -c "
import json, os
p = os.path.expanduser('~/.npm-global/lib/node_modules/unbrowse/package.json')
try: print(json.load(open(p))['version'])
except: print('missing')
" 2>/dev/null)
  symlink_target=$(readlink "$NPM_BIN/unbrowse" 2>/dev/null || echo "not-a-symlink")
  symlink_ok=$([ -e "$NPM_BIN/unbrowse" ] && echo "yes" || echo "BROKEN")
  if [ "$cli_version" = "$pkg_version" ] && [ "$symlink_ok" = "yes" ]; then
    record "npm_install" "PASS" "installed $cli_version (symlink ok)"
  else
    record "npm_install" "FAIL" "drift detected: cli=$cli_version pkg=$pkg_version symlink=$symlink_ok target=$symlink_target"
  fi
else
  record "npm_install" "FAIL" "$(tail -20 $INSTALL_LOG)"
  rm -f "$INSTALL_LOG"
  python3 -c "import json; print(json.dumps(json.load(open('$RESULTS')), indent=2))"
  exit 1
fi
rm -f "$INSTALL_LOG"

# ── Step 2: run setup non-interactively ──
SETUP_LOG=$(mktemp)
if UNBROWSE_NON_INTERACTIVE=1 UNBROWSE_TOS_ACCEPTED=1 "$NPM_BIN/unbrowse" setup --no-start > "$SETUP_LOG" 2>&1; then
  setup_result=$(python3 -c "
import json
try:
    d = json.load(open('$SETUP_LOG'))
    print(json.dumps({
        'ran_setup': True,
        'has_agent_id': bool(d.get('agent_id')),
        'wallet_configured': d.get('wallet',{}).get('configured',False),
        'agentmail_configured': d.get('agent_mail',{}).get('configured',False),
    }))
except Exception as e:
    print(json.dumps({'error': str(e)[:100]}))
" 2>/dev/null || echo '{}')
  record "setup" "PASS" "$setup_result"
else
  record "setup" "FAIL" "$(tail -20 $SETUP_LOG)"
fi
rm -f "$SETUP_LOG"

# ── Step 3: health check confirms server can start ──
if UNBROWSE_NON_INTERACTIVE=1 UNBROWSE_TOS_ACCEPTED=1 "$NPM_BIN/unbrowse" health 2>/dev/null | grep -q '"status":"ok"'; then
  record "health" "PASS" "server responds"
else
  record "health" "FAIL" "server did not come up"
fi

# ── Step 4: first real agent task — resolve + execute from fresh state ──
RESOLVE_LOG=$(mktemp)
UNBROWSE_NON_INTERACTIVE=1 UNBROWSE_TOS_ACCEPTED=1 "$NPM_BIN/unbrowse" resolve \
  --intent "get package info" \
  --url "https://pypi.org/project/flask/" > "$RESOLVE_LOG" 2>&1
if python3 -c "
import json, sys
raw = open('$RESOLVE_LOG').read()
dec = json.JSONDecoder()
for i, ch in enumerate(raw):
    if ch in '{[':
        try:
            obj, _ = dec.raw_decode(raw[i:])
            ops = obj.get('result',{}).get('available_operations',[])
            if ops:
                print(json.dumps({'ops': len(ops), 'skill_id': obj.get('trace',{}).get('skill_id','')}))
                sys.exit(0)
        except: continue
sys.exit(1)
" > /tmp/resolve-summary.json 2>/dev/null; then
  record "first_resolve" "PASS" "$(cat /tmp/resolve-summary.json)"
else
  record "first_resolve" "FAIL" "$(head -5 $RESOLVE_LOG)"
fi
rm -f "$RESOLVE_LOG"

# ── Step 5: execute — get real data for the first time ──
EXEC_LOG=$(mktemp)
SKILL=$(python3 -c "
import json
try: print(json.load(open('/tmp/resolve-summary.json'))['skill_id'])
except: pass
" 2>/dev/null)
if [ -n "$SKILL" ]; then
  # Need to redo resolve to get a valid endpoint
  UNBROWSE_NON_INTERACTIVE=1 UNBROWSE_TOS_ACCEPTED=1 "$NPM_BIN/unbrowse" resolve \
    --intent "get package info" \
    --url "https://pypi.org/project/flask/" > /tmp/r.log 2>&1
  EP=$(python3 -c "
import json
raw = open('/tmp/r.log').read()
dec = json.JSONDecoder()
for i, ch in enumerate(raw):
    if ch in '{[':
        try:
            obj, _ = dec.raw_decode(raw[i:])
            ops = obj.get('result',{}).get('available_operations',[])
            if ops:
                # Prefer flask endpoint
                flask_ops = [o for o in ops if 'flask' in o.get('url_template','')]
                picked = flask_ops[0] if flask_ops else ops[0]
                print(picked['endpoint_id'])
                break
        except: continue
" 2>/dev/null)
  if [ -n "$EP" ]; then
    UNBROWSE_NON_INTERACTIVE=1 UNBROWSE_TOS_ACCEPTED=1 "$NPM_BIN/unbrowse" execute \
      --skill "$SKILL" --endpoint "$EP" --url "https://pypi.org/project/flask/" \
      --raw > "$EXEC_LOG" 2>&1
    result=$(python3 -c "
import json
raw = open('$EXEC_LOG').read()
dec = json.JSONDecoder()
for i, ch in enumerate(raw):
    if ch in '{[':
        try:
            obj, _ = dec.raw_decode(raw[i:])
            tr = obj.get('trace',{})
            r = obj.get('result',{})
            if tr.get('success') and 'info' in r:
                i2 = r['info']
                print(json.dumps({'name': i2.get('name'), 'version': i2.get('version')}))
                break
            elif tr.get('success'):
                print(json.dumps({'success': True, 'keys': list(r.keys())[:5]}))
                break
        except: continue
" 2>/dev/null)
    if [ -n "$result" ]; then
      record "first_execute" "PASS" "$result"
    else
      record "first_execute" "FAIL" "$(head -5 $EXEC_LOG)"
    fi
  else
    record "first_execute" "FAIL" "no endpoint from resolve"
  fi
else
  record "first_execute" "FAIL" "no skill from resolve"
fi
rm -f "$EXEC_LOG" /tmp/resolve-summary.json /tmp/r.log

# ── Step 6: stop server, leave clean state ──
pkill -u "$USER" -f 'unbrowse|kuri' 2>/dev/null || true

# ── Summary ──
python3 -c "
import json
d = json.load(open('$RESULTS'))
total = len(d['steps'])
passed = sum(1 for s in d['steps'] if s['status'] == 'PASS')
d['summary'] = {'total_steps': total, 'passed': passed, 'all_pass': passed == total}
with open('$RESULTS', 'w') as f: json.dump(d, f)
print(json.dumps(d, indent=2))
"
