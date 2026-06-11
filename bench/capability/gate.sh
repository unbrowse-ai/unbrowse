#!/usr/bin/env bash
# bench/capability/gate.sh — Day-6 dominion: the gating spine over the axes.
#
# Runs the axis scorer end-to-end, records to history.jsonl, and gates on a
# threshold across TWO independent witnesses (the trans-window / two-witness
# rule, Gen 2:2). Exit 0 only when both witnesses pass AND agree.
#
# v1 wires Axis A (deterministic, fixture-backed). Axes B/C/D plug into the same
# spine. HONESTY GUARD: a `source=fixture` run validates the SPINE, not an
# unbrowse benchmark win — only `source=live` rows (real `unbrowse go` + resolve)
# count as scores. The source is stamped into every history row.
#
# Env knobs: CORPUS QRELS RESULTS MIN_NDCG MIN_ABSTENTION SOURCE K UNBROWSE_BIN
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

CORPUS="${CORPUS:-$HERE/corpus/R.jsonl}"
QRELS="${QRELS:-$HERE/gold/axisA_qrels.jsonl}"
RESULTS="${RESULTS:-$HERE/snapshots/resolve_R_fixture.jsonl}"
MIN_NDCG="${MIN_NDCG:-0.5}"            # PLACEHOLDER bar — replace with the real embed-search baseline for live runs
MIN_ABSTENTION="${MIN_ABSTENTION:-0.90}"
SOURCE="${SOURCE:-fixture}"            # fixture | live
K="${K:-10}"
AGREE_TOL="${AGREE_TOL:-1e-9}"         # witness agreement tol; tighten for fixture, loosen for live double-resolve
HISTORY="$HERE/history.jsonl"
TS="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

# Pin the artifact under test (best-effort; tolerate no live CLI).
CLI_VERSION="$(${UNBROWSE_BIN:-unbrowse} eval version 2>/dev/null \
  | python3 -c 'import sys,json
v="unknown"
for ln in reversed(sys.stdin.read().splitlines()):
    ln=ln.strip()
    if ln.startswith("{"):
        try: v=(json.loads(ln).get("version") or json.loads(ln).get("cli_version") or "unknown"); break
        except Exception: pass
print(v)' 2>/dev/null || echo unknown)"
[ -z "$CLI_VERSION" ] && CLI_VERSION="unknown"

# Honesty enforcement: source=live may NOT be claimed unless the binary reported a
# real version (a dead/un-probed CLI can't have produced a live score). This closes
# the "stamp a fixture run as live" fabricated-green hole.
if [ "$SOURCE" = "live" ] && [ "$CLI_VERSION" = "unknown" ]; then
  echo "REFUSING source=live: cli_version is unknown — the binary did not report a version." >&2
  echo "A live score requires a live CLI (run 'unbrowse go' + a real resolve first)." >&2
  exit 2
fi

run_axis_a() {  # -> prints "ndcg abstention"; null (all-unanswerable corpus) coerced to 0.0
  python3 "$HERE/score_retrieval.py" --corpus "$CORPUS" --qrels "$QRELS" \
    --results "$RESULTS" --k "$K" 2>/dev/null \
  | python3 -c "import sys,json;d=json.load(sys.stdin);print(d.get('ndcg@$K') or 0.0, d.get('abstention_acc') or 0.0)"
}

# TWO witnesses (independent runs). Deterministic scorer => identical; for live
# runs these become two independent resolve passes that must agree within tol.
W1="$(run_axis_a)"; ND1="${W1% *}"; AB1="${W1#* }"
W2="$(run_axis_a)"; ND2="${W2% *}"; AB2="${W2#* }"

PASS=$(python3 -c "
nd1,ab1,nd2,ab2=float('$ND1'),float('$AB1'),float('$ND2'),float('$AB2')
ndcg_ok = nd1>=$MIN_NDCG and nd2>=$MIN_NDCG
abst_ok = ab1>=$MIN_ABSTENTION and ab2>=$MIN_ABSTENTION
agree   = abs(nd1-nd2)<$AGREE_TOL and abs(ab1-ab2)<$AGREE_TOL
print('true' if (ndcg_ok and abst_ok and agree) else 'false')
")

# Append an honest, append-only history row.
python3 -c "
import json
row={'ts':'$TS','cli_version':'$CLI_VERSION','source':'$SOURCE','axis':'A_retrieval',
     'k':$K,'ndcg':float('$ND1'),'abstention':float('$AB1'),
     'thresholds':{'ndcg':$MIN_NDCG,'abstention':$MIN_ABSTENTION},
     'witnesses':[{'ndcg':float('$ND1'),'abstention':float('$AB1')},
                  {'ndcg':float('$ND2'),'abstention':float('$AB2')}],
     'gate':'$PASS'}
open('$HISTORY','a').write(json.dumps(row)+'\n')
"

echo "── capability gate ──────────────────────────────"
echo " source=$SOURCE  cli=$CLI_VERSION  axis=A_retrieval"
echo " witness1: ndcg@$K=$ND1 abstention=$AB1"
echo " witness2: ndcg@$K=$ND2 abstention=$AB2"
echo " bar: ndcg>=$MIN_NDCG abstention>=$MIN_ABSTENTION  | two-witness agree required"
echo " GATE: $PASS"
[ "$SOURCE" = "fixture" ] && echo " NOTE: source=fixture validates the SPINE, not an unbrowse score."
echo "─────────────────────────────────────────────────"

[ "$PASS" = "true" ] || { echo "GATE FAIL" >&2; exit 1; }
exit 0
