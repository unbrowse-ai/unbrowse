#!/usr/bin/env bash
# finalize-north-star.sh — block until BrowseComp run #2 records its ledger row,
# then settle every remaining node deterministically and run the gate.
set -uo pipefail
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO"
LEDGER="bench/browsecomp/runs.ledger.jsonl"

echo "[finalize] waiting for >=2 browsecomp ledger rows..."
WAITED=0
until [ "$(grep -c . "$LEDGER" 2>/dev/null || echo 0)" -ge 2 ]; do
  sleep 15; WAITED=$((WAITED+15))
  if [ "$WAITED" -ge 1500 ]; then echo "[finalize] timed out after ${WAITED}s waiting for run #2"; exit 2; fi
  # liveness: if no run2 process AND still <2 rows, the run died — bail honestly
  if ! pgrep -f 'run-and-record.sh run2' >/dev/null && [ "$(grep -c . "$LEDGER" 2>/dev/null || echo 0)" -lt 2 ]; then
    echo "[finalize] run #2 process gone and ledger still <2 rows — eval failed, not finalizing"; exit 3
  fi
done
echo "[finalize] run #2 recorded. ledger:"; cat "$LEDGER"

echo "[finalize] 1/4 generating SELF-IMPROVEMENT.md from real ledger..."
python3 bench/browsecomp/gen-self-improvement.py || exit 1

echo "[finalize] 2/4 injecting honest browsecomp paragraph into the paper..."
python3 bench/browsecomp/inject-paper-sentence.py || exit 1

echo "[finalize] 3/4 re-rendering papers (tectonic pdf + pandoc md)..."
( cd paper && tectonic crypto-was-all-you-needed.tex >/dev/null 2>&1 && pandoc crypto-was-all-you-needed.tex -o crypto-was-all-you-needed.md >/dev/null 2>&1 ) || { echo "[finalize] render failed"; exit 1; }
# touch maintenance-network renders so they stay >= their (untouched) tex
touch paper/unbrowse-maintenance-network.pdf paper/unbrowse-maintenance-network.md

echo "[finalize] 4/4 running the north-star gate..."
bash bench/north-star-gate.sh
RC=$?
echo "[finalize] gate exit=$RC"
exit $RC
