#!/usr/bin/env bash
# agent-experience-test.sh — verify the full agent workflow on a target host
#
# Usage:
#   bash scripts/agent-experience-test.sh                    # run locally
#   bash scripts/agent-experience-test.sh --remote HOST      # run on remote via SSH
#   bash scripts/agent-experience-test.sh --remote lekt8@89.169.121.108
#
set -uo pipefail

REMOTE=""
for arg in "$@"; do
  case "$arg" in
    --remote) shift; REMOTE="$1"; shift ;;
  esac
done

if [ -n "$REMOTE" ]; then
  exec ssh -o ConnectTimeout=10 -o ServerAliveInterval=30 "$REMOTE" \
    "bash -s" < "$0"
fi

# ── Running on target host ──
export PATH="$HOME/.npm-global/bin:/usr/local/bin:$PATH"
export UNBROWSE_NON_INTERACTIVE=1
export UNBROWSE_TOS_ACCEPTED=1

log() { echo "[agent-xp] $(date +%H:%M:%S) $*"; }
PASS=0; FAIL=0; SKIP=0

assert() {
  local name="$1"; shift
  log "TEST: $name"
  local out
  if out=$("$@" 2>&1); then
    PASS=$((PASS + 1))
    log "  PASS"
  else
    FAIL=$((FAIL + 1))
    log "  FAIL: $out" | head -3
  fi
}

skip() {
  local name="$1"
  SKIP=$((SKIP + 1))
  log "TEST: $name"
  log "  SKIP"
}

# ── Tests ──

# 1. Version + health
assert "version" sh -c 'unbrowse --version | grep -qE "^[0-9]+\.[0-9]+\.[0-9]+"'
assert "health" sh -c 'unbrowse health 2>/dev/null | grep -q "\"ok\""'

# 2. Resolve finds endpoints on a known marketplace site
assert "resolve finds pypi endpoint" sh -c '
  unbrowse resolve --intent "get package info" --url "https://pypi.org/project/flask/" 2>/dev/null \
    | grep -q "available_operations\|available_endpoints"
'

# 3. Two-step resolve → execute returns real data
test_resolve_execute() {
  local OUT SKILL EP
  OUT=$(unbrowse resolve --intent "get package info" --url "https://pypi.org/project/flask/" 2>/dev/null)
  SKILL=$(echo "$OUT" | python3 -c "import sys,json; d=json.loads(sys.stdin.read()); print(d.get('trace',{}).get('skill_id',''))" 2>/dev/null)
  EP=$(echo "$OUT" | python3 -c "import sys,json; d=json.loads(sys.stdin.read()); ops=d.get('result',{}).get('available_operations',[]); print(ops[0]['endpoint_id'] if ops else '')" 2>/dev/null)
  if [ -z "$SKILL" ] || [ -z "$EP" ]; then echo "no skill/ep"; return 1; fi
  unbrowse execute --skill "$SKILL" --endpoint "$EP" --raw 2>/dev/null | grep -q '"success":true'
}
assert "resolve+execute two-step" test_resolve_execute

# 4. Parameterized resolve + execute (agent fills a template)
test_parameterized_search() {
  local OUT SKILL EP
  OUT=$(unbrowse resolve --intent "search packages" --url "https://registry.npmjs.org/-/v1/search?text=express" 2>/dev/null)
  SKILL=$(echo "$OUT" | python3 -c "import sys,json; d=json.loads(sys.stdin.read()); print(d.get('trace',{}).get('skill_id',''))" 2>/dev/null)
  EP=$(echo "$OUT" | python3 -c "import sys,json; d=json.loads(sys.stdin.read()); ops=d.get('result',{}).get('available_operations',[]); print(ops[0]['endpoint_id'] if ops else '')" 2>/dev/null)
  if [ -z "$SKILL" ] || [ -z "$EP" ]; then echo "no skill/ep"; return 1; fi
  unbrowse execute --skill "$SKILL" --endpoint "$EP" --params '{"q":"express"}' --raw 2>/dev/null | grep -q '"success":true'
}
assert "parameterized search" test_parameterized_search

# 5. Feedback loop (mandatory after execute)
test_feedback() {
  local OUT SKILL EP
  OUT=$(unbrowse resolve --intent "get info" --url "https://pypi.org/project/numpy/" 2>/dev/null)
  SKILL=$(echo "$OUT" | python3 -c "import sys,json; d=json.loads(sys.stdin.read()); print(d.get('trace',{}).get('skill_id',''))" 2>/dev/null)
  EP=$(echo "$OUT" | python3 -c "import sys,json; d=json.loads(sys.stdin.read()); ops=d.get('result',{}).get('available_operations',[]); print(ops[0]['endpoint_id'] if ops else '')" 2>/dev/null)
  if [ -z "$SKILL" ] || [ -z "$EP" ]; then return 0; fi
  unbrowse feedback --skill "$SKILL" --endpoint "$EP" --rating 5 --outcome success 2>/dev/null
}
assert "feedback" test_feedback

# 6. Browse session: go → eval → snap → close (skip if no Chrome)
GO_OUT=$(unbrowse go "https://example.com" 2>/dev/null) || true
if echo "$GO_OUT" | grep -q '"ok":true'; then
  SESSION=$(echo "$GO_OUT" | python3 -c "import sys,json; print(json.loads(sys.stdin.read()).get('session_id',''))" 2>/dev/null)

  assert "eval returns page title" sh -c "
    unbrowse eval --session '$SESSION' 'document.title' 2>/dev/null | grep -q 'Example Domain'
  "

  assert "snap returns a11y tree" sh -c "
    unbrowse snap --session '$SESSION' 2>/dev/null | grep -q '\[e0\]'
  "

  assert "close checkpoints" sh -c "
    unbrowse close --session '$SESSION' 2>/dev/null | grep -q '\"ok\":true'
  "
else
  skip "eval returns page title (no Chrome)"
  skip "snap returns a11y tree (no Chrome)"
  skip "close checkpoints (no Chrome)"
fi

# ── Results ──
log "════════════════════"
log "PASS=$PASS FAIL=$FAIL SKIP=$SKIP"

pkill -9 -f 'unbrowse|kuri' 2>/dev/null || true

[ "$FAIL" -eq 0 ]
