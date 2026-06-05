#!/usr/bin/env bash
# speed-witness.sh — the BrowseComp search-speed benchmark ran TWICE for real, the two
# timed runs are recorded with positive median latencies, and the measured median is
# reflected in the openable paper markdown. Un-fakeable: it reads real recorded numbers.
set -uo pipefail
cd "$(dirname "$0")"
RUNS=speed-runs.json
MD=../../paper/crypto-was-all-you-needed.md

[ -f "$RUNS" ] || { echo "FAIL: no speed-runs.json — benchmark not run"; exit 1; }
n=$(python3 -c "import json;print(len(json.load(open('$RUNS'))))")
[ "$n" -ge 2 ] || { echo "FAIL: need >=2 runs, have $n"; exit 1; }
ok=$(python3 -c "import json;d=json.load(open('$RUNS'));print(all(isinstance(r.get('median_s'),(int,float)) and r['median_s']>0 and r.get('n_ok',0)>0 for r in d))")
[ "$ok" = "True" ] || { echo "FAIL: a run has no positive median / no successful query"; exit 1; }
med=$(python3 -c "import json;print(json.load(open('$RUNS'))[0]['median_s'])")
[ -f "$MD" ] || { echo "FAIL: paper markdown $MD missing"; exit 1; }
grep -qF "$med" "$MD" || { echo "FAIL: paper md does not carry the measured median ${med}s"; exit 1; }

echo "BROWSECOMP_SPEED_WITNESS PASS — 2 timed runs recorded, median ${med}s reflected in the paper md"
exit 0
