#!/bin/bash
# verify.sh - runs the verify_command DECLARED in the state file frontmatter.
# Substrate principle: this script surfaces what is declared; it does not bake
# the literal command. Edit the state file's verify_command to change behavior.
set -uo pipefail
cd "$(dirname "$0")/../../.."
export PLAN=add-an-opt-in-paid-residential-proxy-fallback-fo
export SCAFFOLD="$(cd "$(dirname "$0")/.." && pwd)"
STATE_FILE="$(dirname "$SCAFFOLD")/${PLAN}.local.md"
TS=$(date -u +"%Y-%m-%dT%H:%M:%SZ")

VERIFY_CMD="$(python3 - "$STATE_FILE" <<'PYEXTRACT'
import sys, re
text = open(sys.argv[1]).read()
m = re.match(r"^---\n(.*?)\n---", text, re.S)
if not m:
    sys.exit("[verify] no frontmatter in state file")
fm = m.group(1)
m2 = re.search(r"^verify_command:\s*\|\s*\n((?:[ \t]+.*\n?)+)", fm, re.M)
if m2:
    body = m2.group(1)
    lines = body.splitlines()
    indents = [len(l) - len(l.lstrip()) for l in lines if l.strip()]
    strip = min(indents) if indents else 0
    print("\n".join(l[strip:] if len(l) >= strip else l for l in lines))
    sys.exit(0)
m3 = re.search(r"^verify_command:\s*(.+)$", fm, re.M)
if not m3:
    sys.exit("[verify] no verify_command declared")
print(m3.group(1).strip())
PYEXTRACT
)"
EXTRACT_RC=$?
if [ $EXTRACT_RC -ne 0 ] || [ -z "$VERIFY_CMD" ]; then
  echo "[verify:$PLAN] FATAL: could not extract verify_command from state file" >&2
  exit 3
fi

echo "[verify:$PLAN] state-file verify_command:"
echo "$VERIFY_CMD" | sed 's/^/    /'
set +e
bash -c "$VERIFY_CMD"
VERIFY_RC=$?
set -e
echo "[verify:$PLAN] verify_command rc=$VERIFY_RC"
# Phase 2: lane evidence (only if references/criteria.md declares lanes:)
CRITERIA="$SCAFFOLD/references/criteria.md"
if [[ -f "$CRITERIA" ]] && grep -q "^lanes:" "$CRITERIA"; then
  echo "[verify:$PLAN] lanes declared - collecting raw evidence per lane"
  python3 - <<'PYLANE'
import re, json, os, subprocess
from datetime import datetime
scaffold = os.environ["SCAFFOLD"]
plan = os.environ["PLAN"]
crit_path = os.path.join(scaffold, "references", "criteria.md")
ledger = os.path.join(scaffold, "ledgers", "lanes.jsonl")
text = open(crit_path).read()
m = re.search(r"```yaml\s*(.*?)```", text, re.S)
block = m.group(1) if m else text
lanes = []
cur = None
for line in block.splitlines():
    s = line.rstrip()
    if re.match(r"^\s*-\s+id:", s):
        if cur:
            lanes.append(cur)
        cur = {"id": s.split("id:", 1)[1].strip().strip('"').strip("'")}
    elif cur and re.match(r"^\s+(question|bench_command|source_id):", s):
        k = s.strip().split(":", 1)[0].strip()
        v = s.split(":", 1)[1].strip().strip('"').strip("'")
        cur[k] = v
if cur:
    lanes.append(cur)
ts = datetime.utcnow().strftime("%Y-%m-%dT%H:%M:%SZ")
for lane in lanes:
    cmd = lane.get("bench_command", "")
    if not cmd:
        row = {"lane": lane.get("id"), "ts": ts, "plan": plan,
               "exit_code": None, "output_tail": "no bench_command", "skipped": True}
    else:
        r = subprocess.run(cmd, shell=True, capture_output=True, text=True)
        tail = (r.stdout + r.stderr).strip()[-400:]
        row = {"lane": lane.get("id"), "ts": ts, "plan": plan,
               "question": lane.get("question", ""),
               "source_id": lane.get("source_id", ""),
               "exit_code": r.returncode, "output_tail": tail}
    with open(ledger, "a") as fh:
        fh.write(json.dumps(row) + "\n")
    print(f"  [{lane.get('id')}] exit={row.get('exit_code')}")
PYLANE
fi
exit $VERIFY_RC
