#!/usr/bin/env bash
# jespa-benchmarks-gate.sh — accumulating WIN ledger. Exits 0 when >= TARGET ledger rows
# with won:true have a `witness` command that RE-RUNS GREEN now. Honest negatives (won:false)
# are recorded but never counted. TARGET = the genuine reproduced-win count (say so), not an
# aspiration. No fabricated green: a won row with witness "none"/empty/red is NOT counted.
set -uo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"
LEDGER="${JESPA_LEDGER:-benchmarks-ledger.jsonl}"
TARGET="${JESPA_WIN_TARGET:-1}"
[ -s "$LEDGER" ] || { echo "[jespa-bench] no ledger ($LEDGER)"; exit 1; }
wins=0
while IFS= read -r line; do
  [ -z "$line" ] && continue
  read -r won wit bn < <(printf '%s' "$line" | python3 -c "import sys,json;d=json.load(sys.stdin);print(d.get('won'),'\t',repr(d.get('witness','')),'\t',d.get('bench',''))" 2>/dev/null | tr '\t' ' ')
  won=$(printf '%s' "$line" | python3 -c "import sys,json;print(json.load(sys.stdin).get('won'))" 2>/dev/null)
  [ "$won" = "True" ] || continue
  w=$(printf '%s' "$line" | python3 -c "import sys,json;print(json.load(sys.stdin).get('witness',''))" 2>/dev/null)
  b=$(printf '%s' "$line" | python3 -c "import sys,json;print(json.load(sys.stdin).get('bench',''))" 2>/dev/null)
  if [ -n "$w" ] && [ "$w" != "none" ] && timeout 600 bash -c "$w" >/dev/null 2>&1; then
    echo "[jespa-bench] WIN reproduced: $b"; wins=$((wins+1))
  else
    echo "[jespa-bench] won-row NOT reproduced (witness red/none): $b — not counted"
  fi
  # Early-exit once TARGET reproduced wins are proven — the witness need not re-run rows whose
  # witnesses live in other repos/envs absent on this checkout (recorded honestly, just not
  # reproducible here). The gate proves >= TARGET, it does not require every row to be local.
  [ "$wins" -ge "$TARGET" ] && break
done < "$LEDGER"
echo "[jespa-bench] reproduced wins: $wins / target $TARGET"
[ "$wins" -ge "$TARGET" ] && { echo "[jespa-bench] PASS"; exit 0; } || { echo "[jespa-bench] FAIL — need $((TARGET-wins)) more reproduced win(s)"; exit 1; }
