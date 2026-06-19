#!/usr/bin/env bash
# research-perf-gate.sh — performance witness for the research read step, measured IN-PROCESS
# (so fixed CLI/bun startup overhead doesn't mask the fetch saving). Exits 0 EXACTLY when a warm
# read of the same URL is served from cache (cached=true, deterministic) AND the in-process warm
# read is >=5x faster than the cold fetch. Proves the read-cache actually improves performance.
set -uo pipefail
cd "$(dirname "$0")/.." || exit 2

DIR="$(mktemp -d -t ub-perf.XXXXXX)"
cat > "$DIR/perf.ts" <<'TS'
import { doExtract } from "/Users/lekt9/Projects/unbrowse-ecosystem/unbrowse/src/orchestrator/research.js";
const url = "https://en.wikipedia.org/wiki/Stripe,_Inc.";
const t0 = performance.now();
const cold = (await doExtract([url])).results[0];
const t1 = performance.now();
const warm = (await doExtract([url])).results[0];
const t2 = performance.now();
const coldMs = t1 - t0, warmMs = t2 - t1;
const speedup = warmMs > 0 ? coldMs / warmMs : 999;
console.log(JSON.stringify({
  cold_ok: cold?.ok === true && (cold?.cached ?? false) === false,
  warm_hit: warm?.ok === true && warm?.cached === true,
  cold_ms: Math.round(coldMs), warm_ms: Math.round(warmMs), speedup: Number(speedup.toFixed(1)),
}));
TS

OUT="$(UNBROWSE_RESEARCH_CACHE=1 UNBROWSE_RESEARCH_CACHE_DIR="$DIR" UNBROWSE_RESEARCH_CACHE_TTL_MS=900000 \
  timeout 90 bun run "$DIR/perf.ts" 2>/dev/null | grep -E '^\{' | tail -1)"
rm -rf "$DIR"

echo "$OUT" | python3 -c '
import sys, json
try: d = json.loads(sys.stdin.read())
except Exception as e: print("[perf-gate] FAIL — bad json:", str(e)[:60]); sys.exit(1)
print("  cold ok=%s %dms | warm cache-hit=%s %dms | speedup=%sx"
      % (d["cold_ok"], d["cold_ms"], d["warm_hit"], d["warm_ms"], d["speedup"]))
ok = d["cold_ok"] and d["warm_hit"] and d["speedup"] >= 5.0
print("[perf-gate] %s" % ("PASS — warm read cache-hit + >=5x faster (in-process)" if ok else "FAIL — no cache-hit speedup"))
sys.exit(0 if ok else 1)
'
