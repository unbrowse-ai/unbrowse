#!/usr/bin/env bash
# Evidence collector + early-stop emitter. NO PASS/FAIL on the gate, but
# DOES write a `.suck-ass` marker that the autonomous loop can read to
# decide whether to keep paying for bench gate runs.
#
# Early-stop criterion (the user's "sucks ass" gate): if the latest
# bench-gate run's retrieve_coverage is <= prior AND index_coverage is
# <= prior, write `.suck-ass=true` to the scaffold root. The loop
# driver reads this and halts new waves until the agent ships a fix.
set -uo pipefail
cd "$(dirname "$0")/../../.."
SCAFFOLD="$(cd "$(dirname "$0")/.." && pwd)"
LEDGER="$SCAFFOLD/ledgers/lanes.jsonl"
SUCK_MARKER="$SCAFFOLD/.suck-ass"
TS=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
mkdir -p "$SCAFFOLD/logs"
echo "=== latest gate runs ==="
ls -dt .bench-gate/20260*/ 2>/dev/null | head -3
LATEST=$(ls -dt .bench-gate/20260*/ 2>/dev/null | head -1)
PRIOR=$(ls -dt .bench-gate/20260*/ 2>/dev/null | sed -n '2p')
echo "latest=$LATEST  prior=$PRIOR"
LATEST_IDX=0; LATEST_RET=0; PRIOR_IDX=0; PRIOR_RET=0; PASSED=false
if [ -f "${LATEST%/}/gate.json" ]; then
  read PASSED LATEST_IDX LATEST_RET < <(python3 -c "import json;g=json.load(open('${LATEST%/}/gate.json'));print(g.get('passed'),g.get('coverage',{}).get('index_coverage',0),g.get('coverage',{}).get('retrieve_coverage',0))" 2>/dev/null)
  echo "latest gate passed=$PASSED index=$LATEST_IDX retrieve=$LATEST_RET"
  printf '{"ts":"%s","plan":"%s","phase":"verify","latest_run":"%s","gate":{"passed":"%s","index":%s,"retrieve":%s}}\n' "$TS" "drive-gate-bugs" "${LATEST%/}" "$PASSED" "$LATEST_IDX" "$LATEST_RET" >> "$LEDGER"
fi
if [ -f "${PRIOR%/}/gate.json" ]; then
  read _PP PRIOR_IDX PRIOR_RET < <(python3 -c "import json;g=json.load(open('${PRIOR%/}/gate.json'));print(g.get('passed'),g.get('coverage',{}).get('index_coverage',0),g.get('coverage',{}).get('retrieve_coverage',0))" 2>/dev/null)
  echo "prior gate index=$PRIOR_IDX retrieve=$PRIOR_RET"
fi
# Early-stop logic: if latest is no better than prior on BOTH axes, mark suck-ass
if [ -f "${LATEST%/}/gate.json" ] && [ -f "${PRIOR%/}/gate.json" ]; then
  SUCKS=$(python3 -c "
import sys
li, lr = float('$LATEST_IDX'), float('$LATEST_RET')
pi, pr = float('$PRIOR_IDX'), float('$PRIOR_RET')
# Sucks if BOTH axes failed to improve. Equal counts as 'no movement' too.
print('true' if (lr <= pr and li <= pi) else 'false')
")
  if [ "$SUCKS" = "true" ]; then
    printf '{"ts":"%s","phase":"early_stop","reason":"sucks_ass","latest":{"index":%s,"retrieve":%s},"prior":{"index":%s,"retrieve":%s}}\n' "$TS" "$LATEST_IDX" "$LATEST_RET" "$PRIOR_IDX" "$PRIOR_RET" >> "$LEDGER"
    echo "[EARLY-STOP] gate regressed or did not move on either axis. Writing .suck-ass marker."
    echo "$TS retrieve=$LATEST_RET (prior $PRIOR_RET) index=$LATEST_IDX (prior $PRIOR_IDX)" > "$SUCK_MARKER"
  else
    # Clear stale marker on improvement
    rm -f "$SUCK_MARKER"
    echo "[OK] gate moved on at least one axis. Cleared .suck-ass."
  fi
fi
if [ -f "${LATEST%/}/verdict.json" ] && [ -f "${PRIOR%/}/verdict.json" ]; then
  python3 - "${PRIOR%/}/verdict.json" "${LATEST%/}/verdict.json" <<'PY' > "$SCAFFOLD/logs/wave-delta.txt"
import json,sys
a=json.load(open(sys.argv[1]))["verdicts"]; b=json.load(open(sys.argv[2]))["verdicts"]
A={v["probe_id"]:(v["index_verdict"],v["retrieve_verdict"]) for v in a}
B={v["probe_id"]:(v["index_verdict"],v["retrieve_verdict"]) for v in b}
flips=[]
for k in sorted(set(A)|set(B)):
    if A.get(k)!=B.get(k): flips.append((k,A.get(k),B.get(k)))
print(f"per-probe verdict flips: {len(flips)}")
for k,old,new in flips: print(f"  {k}: {old} -> {new}")
PY
  cat "$SCAFFOLD/logs/wave-delta.txt"
else
  echo "(only one gate run on disk; nothing to diff yet)"
fi
echo "verify done. Agent judges in-thread: did this wave move probes from FAIL -> PASS? .suck-ass marker is the loop's early-stop signal."
exit 0
