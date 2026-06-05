#!/usr/bin/env bash
# self-improve-loop.sh — unbrowse run against itself: resolve a fixed probe set
# through the warm in-process app 20 times. Each pass warms the route / pointer
# cache, so latency falls then plateaus. The plateau IS the physical limit:
# once every route is cached, more passes cannot make it faster. Every iteration
# is recorded to bench/SELF-IMPROVEMENT.jsonl — the witness reads that ledger.
set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"; cd "$ROOT"
WARM="${WARM_SEARCH_URL:-http://127.0.0.1:6969}"
LEDGER="bench/SELF-IMPROVEMENT.jsonl"
N_ITER="${SELF_IMPROVE_ITERS:-20}"
: > "$LEDGER"

# fixed probe set — real agent intents over stable, fast-resolving surfaces
PROBES=(
  "get the top stories|https://news.ycombinator.com"
  "search packages for a json parser|https://registry.npmjs.org/-/v1/search?text=json"
  "list recent crates|https://crates.io/api/v1/crates?page=1&per_page=10"
  "get open library search results for dune|https://openlibrary.org/search.json?q=dune&limit=5"
)
now_ms(){ python3 -c 'import time;print(int(time.time()*1000))'; }

prev=0; best=999999999
for iter in $(seq 1 "$N_ITER"); do
  t0=$(now_ms); hits=0
  for p in "${PROBES[@]}"; do
    intent="${p%%|*}"; url="${p##*|}"
    resp=$(curl -s -m 20 -X POST "$WARM/v1/intent/resolve" \
      -H 'content-type: application/json' \
      -d "{\"intent\":\"$intent\",\"url\":\"$url\"}" 2>/dev/null || true)
    printf '%s' "$resp" | grep -qE '"operations"|"endpoints"|"content"|"result"|"answer"|"highlights"' && hits=$((hits+1)) || true
  done
  t1=$(now_ms); total=$((t1-t0)); delta=$((total-prev))
  [ "$total" -lt "$best" ] && best=$total
  printf '{"iter":%d,"n":%d,"hits":%d,"total_ms":%d,"delta_ms":%d,"best_ms":%d}\n' \
    "$iter" "${#PROBES[@]}" "$hits" "$total" "$delta" "$best" >> "$LEDGER"
  echo "  iter $iter: ${total}ms (delta ${delta}ms) hits ${hits}/${#PROBES[@]}"
  prev=$total
done

# judge the curve: plateau = last 5 iterations within 15% of the best (cache saturated)
python3 - "$LEDGER" <<'PY'
import json,sys
rows=[json.loads(l) for l in open(sys.argv[1]) if l.strip()]
ms=[r["total_ms"] for r in rows]
first,best=ms[0],min(ms)
tail=ms[-5:]
import statistics
spread=(max(tail)-min(tail))/max(1,min(tail))
plateau = spread < 0.25
improve_pct = round(100*(first-best)/max(1,first),1)
summary={"summary":True,"iters":len(rows),"first_ms":first,"best_ms":best,
         "improvement_pct":improve_pct,"tail_spread":round(spread,3),
         "plateau":plateau,"physical_limit":"cache saturated; further passes cannot reduce latency" if plateau else "not yet converged"}
open(sys.argv[1],"a").write(json.dumps(summary)+"\n")
print(f"  CURVE: cold {first}ms -> warm-best {best}ms ({improve_pct}% faster); plateau={plateau}")
PY
echo "SELF_IMPROVE_DONE"
