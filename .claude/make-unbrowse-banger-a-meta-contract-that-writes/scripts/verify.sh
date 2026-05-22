#!/bin/bash
# verify.sh — umbrella gate for "make unbrowse banger" (the contract-writer).
#
# The artifact this umbrella BUILDS is child contracts. "Test what you
# build" => verify exercises a generated child as a real served surface:
# every bound child must be a valid, iterable meta-harness scaffold whose
# state file parses. A scaffold that does not resolve is a regression to
# the next agent who tries to iterate it.
#
# Gate (all must hold):
#   G1  scripts/generate-child.sh exists and is executable
#   G2  scripts/research.sh       exists and is executable
#   G3  >= 1 real (uncommented) entry in bound_contracts:
#   G4  every bound child has scaffold dir + scripts/iterate.sh + state file
#   G5  every bound child state file frontmatter parses (plan: + plan_text:)
#
# Evidence is printed per child; the agent reads it. The exit code is a
# mechanical structural check of the generator, not a judgement of whether
# unbrowse is "banger" — that verdict the agent renders from the stitched
# child ledger rows the bound-contracts phase writes into iterations.jsonl.
set -uo pipefail
# Resolve paths from BASH_SOURCE BEFORE any cd ($0 may be relative).
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
export SCAFFOLD="$(cd "$SCRIPT_DIR/.." && pwd)"
PROJECT="$(cd "$SCAFFOLD/../.." && pwd)"
cd "$PROJECT"
export PLAN=make-unbrowse-banger-a-meta-contract-that-writes
STATE="$PROJECT/.claude/$PLAN.local.md"
RC=0

echo "[verify:$PLAN] gate: contract-writer mechanism intact + every bound child iterable"

# G1 / G2 — generator primitives present
for s in generate-child.sh research.sh; do
  if [[ -x "$SCAFFOLD/scripts/$s" ]]; then
    echo "  [G] scripts/$s: present + executable"
  else
    echo "  [G] scripts/$s: MISSING or not executable"; RC=1
  fi
done

# G3..G5 — bound children
BOUND="$(python3 - "$STATE" <<'PYBOUND'
import sys
lines = open(sys.argv[1]).read().splitlines()
inb = False
for ln in lines:
    s = ln.strip()
    if s == "bound_contracts:":
        inb = True; continue
    if inb:
        if ln and not ln[0].isspace() and s and not s.startswith("#"):
            break
        if s.startswith("- "):
            print(s[2:].strip())
PYBOUND
)"

if [[ -z "$BOUND" ]]; then
  echo "  [G3] bound_contracts: ZERO real entries — umbrella has written no child yet"
  RC=1
else
  N=$(printf '%s\n' "$BOUND" | grep -c .)
  echo "  [G3] bound_contracts: $N child contract(s) bound"
  while IFS= read -r child; do
    [[ -z "$child" ]] && continue
    cdir="$PROJECT/.claude/$child"
    cstate="$PROJECT/.claude/$child.local.md"
    ok=1
    [[ -d "$cdir" ]]                    || { echo "  [G4] $child: scaffold dir MISSING"; ok=0; }
    [[ -e "$cdir/scripts/iterate.sh" ]] || { echo "  [G4] $child: scripts/iterate.sh MISSING"; ok=0; }
    [[ -f "$cstate" ]]                  || { echo "  [G4] $child: state file MISSING"; ok=0; }
    if [[ -f "$cstate" ]]; then
      python3 - "$cstate" <<'PYPARSE' || ok=0
import sys
t = open(sys.argv[1]).read()
assert t.startswith("---"), "no frontmatter"
fm = t.split("---", 2)[1]
assert "plan:" in fm and "plan_text:" in fm, "frontmatter missing plan/plan_text"
PYPARSE
    fi
    last="(never iterated)"
    cled="$cdir/ledgers/iterations.jsonl"
    if [[ -s "$cled" ]]; then
      last="$(python3 - "$cled" <<'PYLAST'
import json, sys
try:
    rows = [json.loads(l) for l in open(sys.argv[1]) if l.strip()]
    r = rows[-1]
    print("iter=%s phase=%s status=%s exit=%s" % (
        r.get("iter"), r.get("phase"), r.get("status"), r.get("exit_code")))
except Exception as e:
    print("(unreadable: %s)" % e)
PYLAST
)"
    fi
    if [[ "$ok" == 1 ]]; then
      echo "  [G4/G5] $child: VALID iterable scaffold | last: $last"
    else
      echo "  [G4/G5] $child: INVALID scaffold | last: $last"; RC=1
    fi
  done <<< "$BOUND"
fi

# Phase 2: criteria.md lanes (raw evidence into lanes.jsonl)
CRITERIA="$SCAFFOLD/references/criteria.md"
if [[ -f "$CRITERIA" ]] && grep -q "^lanes:" "$CRITERIA" 2>/dev/null; then
  echo "[verify:$PLAN] lanes declared — collecting raw evidence"
  python3 - <<'PYLANE'
import re, json, os, subprocess
from datetime import datetime
scaffold = os.environ["SCAFFOLD"]; plan = os.environ["PLAN"]
text = open(os.path.join(scaffold, "references", "criteria.md")).read()
m = re.search(r"```yaml\s*(.*?)```", text, re.S)
block = m.group(1) if m else text
lanes, cur = [], None
def uq(r):
    r = r.strip()
    return r[1:-1] if len(r) >= 2 and r[0] == r[-1] and r[0] in "\"'" else r
for line in block.splitlines():
    s = line.rstrip()
    if re.match(r"^\s*-\s+id:", s):
        if cur: lanes.append(cur)
        cur = {"id": uq(s.split("id:", 1)[1])}
    elif cur and re.match(r"^\s+(question|bench_command|source_id):", s):
        k = s.strip().split(":", 1)[0].strip()
        cur[k] = uq(s.split(":", 1)[1])
if cur: lanes.append(cur)
ts = datetime.utcnow().strftime("%Y-%m-%dT%H:%M:%SZ")
ledger = os.path.join(scaffold, "ledgers", "lanes.jsonl")
for lane in lanes:
    cmd = lane.get("bench_command", "")
    if not cmd:
        row = {"lane": lane.get("id"), "ts": ts, "plan": plan, "skipped": True}
    else:
        r = subprocess.run(cmd, shell=True, capture_output=True, text=True)
        row = {"lane": lane.get("id"), "ts": ts, "plan": plan,
               "question": lane.get("question", ""), "source_id": lane.get("source_id", ""),
               "exit_code": r.returncode, "output_tail": (r.stdout + r.stderr).strip()[-400:]}
    open(ledger, "a").write(json.dumps(row) + "\n")
    print(f"  [{lane.get('id')}] exit={row.get('exit_code')}")
PYLANE
fi

if [[ "$RC" == 0 ]]; then
  echo "[verify:$PLAN] PASS — generator intact, every bound child is a valid iterable scaffold"
else
  echo "[verify:$PLAN] FAIL — see G* rows above"
fi
exit $RC
