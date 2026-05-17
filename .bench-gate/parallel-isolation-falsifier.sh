#!/usr/bin/env bash
# Phase-1 FALSIFIER: concurrent browse-session isolation in the full collector
# pipeline. Reuses the real deterministic collector (faithful, no mocks) on a
# fixed 4-probe slice of EASY, FAST-RENDERING, DISTINCT-host sites (no anti-bot,
# no SPA capture-miss noise). Asserts every probe's snap host == its intended
# host. Pre-fix this FAILS (conc=4 cross-render: a probe renders another
# probe's site). Post-fix every host_match must be true.
set -u
REPO="/Users/lekt9/Projects/unbrowse-ecosystem/unbrowse"
cd "$REPO" || exit 2
SCRATCH="$(mktemp -d /tmp/p1-falsifier-XXXXXX)"
trap 'rm -rf "$SCRATCH"' EXIT
# 4 easy distinct hosts proven to render in serial probes 001-008
cat > "$SCRATCH/manifest.json" <<'JSON'
{"run_id":"p1-falsifier","cli_version":"falsifier","probes":[
{"probe_id":"f1_hn","lane":"anchor","intent":"get top hacker news stories","url":"https://news.ycombinator.com/"},
{"probe_id":"f2_lobsters","lane":"anchor","intent":"get latest stories","url":"https://lobste.rs/"},
{"probe_id":"f3_example","lane":"anchor","intent":"get page","url":"https://example.com/"},
{"probe_id":"f4_iana","lane":"anchor","intent":"get page","url":"https://www.iana.org/"}
]}
JSON
echo "[falsifier] running real collector conc=4 on 4 easy distinct hosts -> $SCRATCH"
UNBROWSE_GATE_CONCURRENCY=4 timeout 260 bun scripts/mcp-gate-parallel-collect.ts "$SCRATCH" >"$SCRATCH/_run.log" 2>&1
grep -E '^\[w[0-9]\]|ERROR' "$SCRATCH/_run.log" | tail -6
fail=0
for d in "$SCRATCH"/f*/; do
  p=$(basename "$d"); [ -f "$d/capture.meta.json" ] || { echo "  $p: NO capture.meta -> FAIL"; fail=1; continue; }
  intended=$(jq -r '.iso_self_check.intended_host' "$d/capture.meta.json" 2>/dev/null)
  got=$(jq -r '.iso_self_check.snap_host' "$d/capture.meta.json" 2>/dev/null)
  m=$(jq -r '.iso_self_check.host_match' "$d/capture.meta.json" 2>/dev/null)
  if [ "$m" = "true" ]; then echo "  $p: intended=$intended got=$got host_match=true OK"
  else echo "  $p: intended=$intended got=$got host_match=$m *** CROSS-CONTAMINATION ***"; fail=1; fi
done
if [ "$fail" -eq 0 ]; then echo "[falsifier] PASS — all 4 sessions isolated under conc=4"; exit 0
else echo "[falsifier] FAIL — concurrent browse-session cross-contamination reproduced"; exit 1; fi
