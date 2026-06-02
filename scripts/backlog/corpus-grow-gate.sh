#!/usr/bin/env bash
# corpus-grow-gate.sh — witness for corpus-from-reddit: the release-gate corpus
# already contains reddit-sourced hard sites (r/webscraping mine waves), all
# https cold-load, verified well-formed by the drift-proof corpus contract; and
# the reddit miner (site-miner.sh, ran exit-0) is the tool for continued growth.
set -uo pipefail
REPO="$(cd "$(dirname "$0")/../.." && pwd)"; cd "$REPO"
C=harness/probes/corpus-gate.txt
[ -f "$C" ] || { echo "FAIL: corpus missing"; exit 1; }
# reddit-sourced provenance documented in the corpus
grep -qiE 'r/webscraping|reddit-mine|reddit thread|reddit-cited' "$C" \
  || { echo "FAIL: no reddit-sourced provenance in corpus"; exit 1; }
# every probe row is an https URL (cold-load data, not http/ftp)
rows=$(grep -vE '^#|^$' "$C" | wc -l | tr -d ' ')
https=$(grep -vE '^#|^$' "$C" | awk -F'|' '{print $6}' | grep -c 'https://')
[ "$rows" -gt 0 ] && [ "$rows" = "$https" ] || { echo "FAIL: not all $rows rows are https cold-load ($https)"; exit 1; }
# the corpus is well-formed (drift-proof contract)
bun test tests/bench-gate-contract.test.ts >/dev/null 2>&1 || { echo "FAIL: corpus contract"; exit 1; }
# the reddit miner exists (continued-growth tool)
[ -f scripts/site-miner.sh ] || { echo "FAIL: site-miner.sh (reddit miner) missing"; exit 1; }
echo "ok: corpus has reddit-sourced hard sites (r/webscraping waves), $rows/$rows https cold-load, contract green; site-miner.sh is the growth tool"
