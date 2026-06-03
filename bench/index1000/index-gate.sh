#!/usr/bin/env bash
# index-gate — the witness for the 1000-site 80/20 indexing campaign. Exit 0 iff at least
# INDEX_THRESHOLD sites were indexed successfully (the "80%" of the 1000-site target).
# Reads the real ledger run.sh writes — un-fakeable: it counts actual ok rows.
#
# Until the fleet/CI campaign runs over the full 1000-site list, this is RED (honest) —
# the harness is built and proven on the seed slice, but "1000 indexed" needs the campaign.
set -uo pipefail
cd "$(dirname "$0")/../.."
OUT="${INDEX_OUT:-bench/index1000/.artifacts/index.jsonl}"
THRESH="${INDEX_THRESHOLD:-800}"   # 80% of 1000; set lower for a proof slice

ok=$(grep -c '"ok":true' "$OUT" 2>/dev/null || echo 0)
total=$(wc -l < "$OUT" 2>/dev/null | tr -d ' ' || echo 0)
echo "[index-gate] indexed ok=$ok / attempted=$total ; threshold=$THRESH"
if [ "$ok" -ge "$THRESH" ]; then
  echo "[index-gate] PASS — >= $THRESH sites indexed."
  exit 0
fi
echo "[index-gate] NOT YET — $ok/$THRESH. Run the campaign: bash bench/index1000/run.sh <1000-site-list>"
exit 1
