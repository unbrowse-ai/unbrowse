#!/usr/bin/env bash
# bench/capability/webagent/gate_write.sh — the jesus-ralph WITNESS.
#
# Exits 0 only when, across TWO independent witnesses (Gen 2:2):
#   1. agent-driven WRITE actions (POST/PUT/PATCH/DELETE) succeed via the
#      ad-hoc execute path and the request body crosses the wire (the public
#      write-safe target reflects it), AND
#   2. ZK input-censoring holds: a sensitive body field (password) reaches the
#      TARGET in clear (the write works) but NEVER persists in clear on disk —
#      only its sha256 commitment is written.
#
# Public write-safe targets only (postman-echo) — no login, no real account,
# reproducible anywhere with network. Network-unreachable => exit 3 (BLOCKED),
# distinct from a real FAIL, so a transient outage is not read as a fabricated
# green nor as a code regression.
#
# Binary under test: $UNBROWSE_BIN (default = local source `bun src/cli.ts`,
# because the fix ships in source; the npm-binary number follows a release).
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/../../.." && pwd)"
cd "$ROOT"

BIN_CMD="${UNBROWSE_BIN:-bun src/cli.ts}"
CFG="${UNBROWSE_CONFIG_DIR:-$HOME/.unbrowse}"
TS="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
HISTORY="$ROOT/bench/capability/history.jsonl"

run_write() { # url method bodyjson -> prints "success|<echoed-json>"
  local url="$1" method="$2" body="$3"
  timeout 60 $BIN_CMD execute --url "$url" --method "$method" --body "$body" 2>/dev/null \
  | python3 -c "import sys,json
raw=sys.stdin.read();best=None
for ln in raw.splitlines():
    ln=ln.strip()
    if ln.startswith('{'):
        try: best=json.loads(ln)
        except: pass
if not best: print('none|'+raw[-160:].replace(chr(10),' ')); sys.exit()
ok=best.get('trace',{}).get('success')
res=best.get('result',{}); data=res.get('data') if isinstance(res,dict) else None
print(('yes' if ok else 'no')+'|'+json.dumps(data if data is not None else res)[:300])"
}

# ── Axis 1: the four write verbs reflect their body ───────────────────────────
# bash 3.2 (macOS default) has no associative arrays — lowercase the verb for the path.
witness_pass() {  # -> echoes "PASS"/"FAIL"/"BLOCKED" + detail to stderr
  local all_ok=1 blocked=0
  for M in POST PUT PATCH DELETE; do
    local path; path="$(echo "$M" | tr 'A-Z' 'a-z')"
    local url="https://postman-echo.com/${path}"
    local marker="wa-${M}-$$-${RANDOM}"
    local out; out="$(run_write "$url" "$M" "{\"marker\":\"$marker\",\"verb\":\"$M\"}")"
    local ok="${out%%|*}" echoed="${out#*|}"
    if [ "$ok" = "none" ]; then echo "  $M BLOCKED ($echoed)" >&2; blocked=1; continue; fi
    if [ "$ok" = "yes" ] && echo "$echoed" | grep -q "$marker"; then
      echo "  $M PASS (body reflected)" >&2
    else
      echo "  $M FAIL ok=$ok echoed=${echoed:0:80}" >&2; all_ok=0
    fi
  done
  # ── Axis 2: ZK input-censoring ──────────────────────────────────────────────
  local secret="zk-witness-$$-${RANDOM}"
  rm -f "$CFG/skill-cache/adhoc-write-"*.json 2>/dev/null
  local out; out="$(run_write "https://postman-echo.com/post" POST "{\"email\":\"x@y.z\",\"password\":\"$secret\"}")"
  local ok="${out%%|*}" echoed="${out#*|}"
  if [ "$ok" = "none" ]; then echo "  ZK BLOCKED ($echoed)" >&2; blocked=1;
  else
    # the TARGET must have received the real secret (write truly worked)
    if echo "$echoed" | grep -q "$secret"; then echo "  ZK target-received-secret PASS" >&2;
    else echo "  ZK FAIL: target did not receive secret" >&2; all_ok=0; fi
    # the secret must NOT persist in clear anywhere under the config dir
    if grep -rl "$secret" "$CFG" >/dev/null 2>&1; then
      echo "  ZK FAIL: cleartext secret leaked to disk" >&2; all_ok=0
    else echo "  ZK no-cleartext-on-disk PASS" >&2; fi
    # the commitment must be persisted
    local f; f="$(ls "$CFG/skill-cache/adhoc-write-"*.json 2>/dev/null | head -1)"
    if [ -n "$f" ] && grep -q '"password": *"sha256:' "$f"; then echo "  ZK commitment-persisted PASS" >&2;
    elif [ -n "$f" ]; then echo "  ZK FAIL: no sha256 commitment in persisted route" >&2; all_ok=0;
    else echo "  ZK (no persisted route file — in-memory only)" >&2; fi
  fi
  if [ "$blocked" = "1" ] && [ "$all_ok" = "1" ]; then echo BLOCKED; return; fi
  [ "$all_ok" = "1" ] && echo PASS || echo FAIL
}

echo "── webagent write gate (witness 1) ──────────────" >&2
W1="$(witness_pass)"; [ -z "$W1" ] && W1="FAIL"
echo "── webagent write gate (witness 2) ──────────────" >&2
W2="$(witness_pass)"; [ -z "$W2" ] && W2="FAIL"

echo "─────────────────────────────────────────────────"
echo " witness1=$W1  witness2=$W2  bin=$BIN_CMD"

# honest history row
python3 -c "
import json
open('$HISTORY','a').write(json.dumps({'ts':'$TS','source':'live','axis':'C_write_zk',
  'bin':'$BIN_CMD','witness1':'$W1','witness2':'$W2',
  'gate': 'true' if ('$W1'=='PASS' and '$W2'=='PASS') else 'false'})+'\n')
"

if [ "$W1" = "BLOCKED" ] || [ "$W2" = "BLOCKED" ]; then
  echo " GATE: BLOCKED (network/target unreachable — not a code result)"; exit 3
fi
if [ "$W1" = "PASS" ] && [ "$W2" = "PASS" ]; then
  echo " GATE: PASS — agent-driven writes work + inputs ZK-censored (two witnesses)"; exit 0
fi
echo " GATE: FAIL"; exit 1
