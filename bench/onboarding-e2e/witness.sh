#!/usr/bin/env bash
# onboarding-e2e/witness.sh — fresh-machine onboarding + agent-experience witness.
#
# Simulates a pristine machine with a temp HOME (equivalent to moving ~/.unbrowse aside,
# but zero risk to real data), runs the INSTALLED unbrowse from scratch, and asserts:
#   1. onboarding auto-creates a self-custody wallet identity (~/.unbrowse/wallet.json),
#   2. an agent completes a real browsecomp-style search end-to-end (≥1 result),
# then records the run (speed + hits) to runs.json for the whitepaper. Un-fakeable: it
# runs the real binary against the live web and reads real output.
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
RUNS="$HERE/runs.json"
BIN="${UNBROWSE_BIN:-unbrowse}"
TH="$(mktemp -d)"
trap 'rm -rf "$TH"' EXIT
fail=0

echo "== 1. fresh onboarding (HOME=$TH) — wallet auto-created? =="
HOME="$TH" UNBROWSE_NON_INTERACTIVE=1 UNBROWSE_SKIP_WALLET_SETUP=1 timeout 120 "$BIN" setup >"$TH/setup.log" 2>&1 || true
addr=""
if [ -f "$TH/.unbrowse/wallet.json" ]; then
  addr="$(python3 -c "import json;print(json.load(open('$TH/.unbrowse/wallet.json'))['address'])" 2>/dev/null)"
fi
[ -n "$addr" ] || { echo "  FAIL: onboarding did not auto-create a wallet"; fail=1; }
echo "  wallet: ${addr:-<none>}"

echo "== 2. agent experience — real browsecomp search from the fresh install =="
Q="what year did the company that makes claude release its first model"
t0=$(python3 -c "import time;print(time.time())")
out="$(HOME="$TH" timeout 90 "$BIN" search --intent "$Q" --pretty 2>/dev/null)"
t1=$(python3 -c "import time;print(time.time())")
hits=$(printf '%s' "$out" | grep -oE '"url"|"title"' | wc -l | tr -d ' ')
elapsed=$(python3 -c "print(round($t1-$t0,1))")
[ "${hits:-0}" -ge 1 ] || { echo "  FAIL: fresh search returned no results"; fail=1; }
echo "  search: $hits hits in ${elapsed}s"

echo "== 3. capture =="
python3 - "$RUNS" "$addr" "$elapsed" "$hits" <<'PY'
import json, sys
path, addr, elapsed, hits = sys.argv[1], sys.argv[2], float(sys.argv[3]), int(sys.argv[4])
rec = {"mode": "fresh-onboarding+search", "wallet_created": bool(addr), "wallet": addr,
       "search_elapsed_s": elapsed, "search_hits": hits}
try:
    runs = json.load(open(path))
    if not isinstance(runs, list): runs = [runs]
except Exception:
    runs = []
runs.append(rec)
json.dump(runs, open(path, "w"), indent=2)
print(f"  recorded run #{len(runs)}: wallet={'yes' if addr else 'NO'} hits={hits} {elapsed}s")
PY

if [ "$fail" -eq 0 ]; then
  echo "ONBOARDING_E2E PASS — fresh wallet auto-created + agent search works end-to-end."
else
  echo "ONBOARDING_E2E FAIL"
fi
exit $fail
