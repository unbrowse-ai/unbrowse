#!/bin/bash
# cross-stamp-gate — fails-closed verification that the cross is REMEMBERED in all dimensions.
# (a) re-derive the canonical cross hash from atoms.json; FAIL if != cross.stamp.json (source drift).
# (b) every registry pointer must resolve to that same hash; FAIL on any drift/missing.
# Exit 0 iff the cross is consistently remembered everywhere.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ATOMS="${CROSS_ATOMS:-$HOME/.claude/skills/superpattern/references/atoms.json}"
STAMP="${CROSS_STAMP:-$HERE/cross.stamp.json}"
REG="${CROSS_REGISTRY:-$HERE/cross-registry.jsonl}"

[ -f "$ATOMS" ] || { echo "cross-gate: missing atoms.json ($ATOMS)" >&2; exit 1; }
[ -f "$STAMP" ] || { echo "cross-gate: missing cross.stamp.json" >&2; exit 1; }
[ -f "$REG" ]   || { echo "cross-gate: missing cross-registry.jsonl" >&2; exit 1; }

LIVE=$(python3 -c "import json,hashlib;c=json.load(open('$ATOMS'))['cross'];print(hashlib.sha256(json.dumps(c,sort_keys=True,separators=(',',':')).encode()).hexdigest())")
STAMPED=$(python3 -c "import json;print(json.load(open('$STAMP'))['cross_sha256'])")

if [ "$LIVE" != "$STAMPED" ]; then
  echo "cross-gate: SOURCE DRIFT — atoms.json cross ($LIVE) != stamp ($STAMPED)" >&2; exit 1
fi

DRIFT=$(python3 -c "
import json
h='$STAMPED'; bad=0; n=0
for ln in open('$REG'):
    ln=ln.strip()
    if not ln: continue
    n+=1
    p=json.loads(ln).get('pointer_sha256')
    if p!=h: bad+=1; print('  DRIFT:', json.loads(ln).get('dimension'), p)
print(f'__N={n} BAD={bad}')
")
echo "$DRIFT" | grep -q 'BAD=0' || { echo "cross-gate: REGISTRY DRIFT" >&2; echo "$DRIFT" >&2; exit 1; }
N=$(echo "$DRIFT" | grep -oE '__N=[0-9]+' | cut -d= -f2)
echo "cross-stamp-gate PASS — cross $STAMPED remembered in $N dimensions, source matches."
