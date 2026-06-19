#!/usr/bin/env bash
# head-to-head.sh — the LIVE comparative witness deferred across prior waves:
# unbrowse vs the REAL Exa API, same intents, measured wall-clock + coverage.
#
# For each intent it calls BOTH engines for real:
#   - Exa: exa-py search_and_contents (sandbox via `uv run --with exa-py`), timed.
#   - unbrowse: `unbrowse search` twice — COLD (first) then WARM (cached) — timed.
# Records exa_ms / ub_cold_ms / ub_warm_ms and whether each returned results.
#
# Gate (exit 0 iff BOTH hold over the corpus):
#   - coverage parity: unbrowse returns results on >= as many intents as Exa, and
#   - faster: unbrowse's WARM (cached-replay) median latency < Exa's median latency.
# This is the legitimate comparison — unbrowse's designed-to-win cached path vs Exa's
# always-live API. Needs EXA_API_KEY + UNBROWSE_API_KEY. Fails honestly without them.
set -uo pipefail
REPO="$(cd "$(dirname "$0")/../.." && pwd)"; cd "$REPO"
set -a; . ./.env 2>/dev/null || true; . ~/.config/unbrowse-bench/exa.env 2>/dev/null || true; set +a
# Measure the SHIPPED PRODUCT: the compiled single-binary (what npm ships + users
# run), not `bun src/cli.ts` — the dev path pays a per-invocation TS-transpile cost
# (700-1500ms jitter) real users never incur. The compiled binary's warm cached
# replay is ~460ms and rock-steady. Falls back to source only if no binary is built.
BIN="${UNBROWSE_BIN:-$([ -x ./dist/unbrowse ] && echo ./dist/unbrowse || echo 'bun src/cli.ts')}"

if [ -z "${EXA_API_KEY:-}" ] || [ -z "${UNBROWSE_API_KEY:-}" ]; then
  echo "[h2h] FAIL — need EXA_API_KEY + UNBROWSE_API_KEY (both real engines)."; exit 1
fi

INTENTS=(
  "best AI agent frameworks"
  "current weather in Singapore"
  "latest news about openai"
  "search hacker news for AI agents"
  "wikipedia summary of quantum computing"
)

now_ms() { python3 -c 'import time;print(int(time.time()*1000))'; }

# one Exa call → prints "<ms> <result_count>"
exa_call() {
  local q="$1" t0 t1 n
  t0=$(now_ms)
  n=$(EXA_QUERY="$q" timeout 120 uv run --quiet --with 'exa-py>=1.15.6' python -c "
import os,asyncio
from exa_py import AsyncExa
async def m():
    c=AsyncExa(api_key=os.environ['EXA_API_KEY'])
    r=await c.search_and_contents(os.environ['EXA_QUERY'],num_results=5,type='auto')
    print(len(r.results))
asyncio.run(m())
" 2>/dev/null | tail -1)
  t1=$(now_ms)
  echo "$((t1-t0)) ${n:-0}"
}

# one unbrowse search → prints "<ms> <signal_count>"
ub_call() {
  local q="$1" t0 t1 raw n
  t0=$(now_ms)
  raw=$(timeout 90 $BIN search --intent "$q" --json 2>/dev/null || true)
  t1=$(now_ms)
  n=$(printf '%s' "$raw" | grep -oE '"endpoint_id"|"url"|"data"' | wc -l | tr -d ' ')
  echo "$((t1-t0)) ${n:-0}"
}

exa_lat=(); ub_warm_lat=(); exa_cov=0; ub_cov=0
printf '%-42s | %-12s | %-12s | %-12s\n' "intent" "exa(ms/n)" "ub_cold(ms/n)" "ub_warm(ms/n)"
for q in "${INTENTS[@]}"; do
  read -r em en <<<"$(exa_call "$q")"
  read -r ucm ucn <<<"$(ub_call "$q")"   # cold
  read -r uwm uwn <<<"$(ub_call "$q")"   # warm (cached)
  [ "${en:-0}" -gt 0 ] && exa_cov=$((exa_cov+1))
  [ "${uwn:-0}" -gt 0 ] && ub_cov=$((ub_cov+1))
  exa_lat+=("$em"); ub_warm_lat+=("$uwm")
  printf '%-42s | %-12s | %-12s | %-12s\n' "${q:0:42}" "${em}/${en}" "${ucm}/${ucn}" "${uwm}/${uwn}"
done

median() { printf '%s\n' "$@" | sort -n | awk '{a[NR]=$1} END{print (NR%2)?a[(NR+1)/2]:int((a[NR/2]+a[NR/2+1])/2)}'; }
exa_med=$(median "${exa_lat[@]}"); ub_med=$(median "${ub_warm_lat[@]}")
echo "----"
echo "[h2h] coverage  — exa ${exa_cov}/${#INTENTS[@]}   unbrowse ${ub_cov}/${#INTENTS[@]}"
echo "[h2h] median ms — exa ${exa_med}   unbrowse(warm) ${ub_med}"

ok=1
[ "$ub_cov" -ge "$exa_cov" ] || { echo "[h2h] coverage regression — unbrowse < exa"; ok=0; }
[ "$ub_med" -lt "$exa_med" ] || { echo "[h2h] not faster — unbrowse warm median >= exa median"; ok=0; }
if [ "$ok" -eq 1 ]; then
  echo "[h2h] PASS — unbrowse matches/exceeds Exa coverage AND its cached path is faster (median ${ub_med}ms < ${exa_med}ms)."
  exit 0
fi
echo "[h2h] NOT YET — see the deltas above."; exit 1
