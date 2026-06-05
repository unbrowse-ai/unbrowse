#!/usr/bin/env bash
# run-and-record.sh RUN_ID [N] — run ONE real BrowseComp eval through unbrowse,
# capture the eval log, and append a ledger row tying the score to that log.
#
# The N-tries self-improvement experiment: run this repeatedly. Each run reuses
# the route ledger / capture cache the previous run warmed (capture -> index ->
# reuse), so accuracy/latency can drift run-over-run. Every row is real: the
# score is parsed from "Evaluation complete. Score: X" in an exited-0 process.
set -uo pipefail
RUN_ID="${1:?usage: run-and-record.sh RUN_ID [N]}"
N="${2:-${BROWSECOMP_GATE_N:-10}}"
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$REPO"
set -a; . ./.env 2>/dev/null || true; set +a
# BROWSECOMP_PIPELINE=kimi forces the fast, reliable direct-Nebius Kimi path and
# skips OpenRouter entirely (the gpt-4.1-via-OpenRouter LLM call stalls/wedges on
# some queries — diagnosed: the hang is in the grader API call, not unbrowse).
if [ "${BROWSECOMP_PIPELINE:-}" != "kimi" ]; then
  . ~/.config/unbrowse-bench/openrouter.env 2>/dev/null || true
fi

LEDGER="bench/browsecomp/runs.ledger.jsonl"
LOGDIR="bench/browsecomp/logs"; mkdir -p "$LOGDIR"
LOG="$LOGDIR/$RUN_ID.log"
LOG_REL="logs/$RUN_ID.log"   # relative to the ledger's dir (bench/browsecomp/)

# gpt-4.1 agent + gpt-4.1 grader via OpenRouter = apples-to-apples with Exa 0.336.
if [ -n "${OPENROUTER_API_KEY:-}" ] && [ "${BROWSECOMP_PIPELINE:-}" != "kimi" ]; then
  MODEL="${BROWSECOMP_GATE_MODEL:-nebius/openai/gpt-4.1}"
  GRADER_BACKEND="nebius"; GRADER_MODEL="openai/gpt-4.1"
  export NEBIUS_BASE_URL="https://openrouter.ai/api/v1"; export NEBIUS_API_KEY="$OPENROUTER_API_KEY"
else
  MODEL="${BROWSECOMP_GATE_MODEL:-nebius/moonshotai/Kimi-K2.6}"
  GRADER_BACKEND="nebius"; GRADER_MODEL="moonshotai/Kimi-K2.6"
fi

# Source binary: measures the REAL current code (global binary lacks working search).
UNBROWSE_BIN="$REPO/bench/browsecomp/.unbrowse-src"
export UNBROWSE_BIN
export UNBROWSE_ENRICH_TOP_K="${UNBROWSE_ENRICH_TOP_K:-0}"
export UNBROWSE_SERP_CONCURRENCY="${UNBROWSE_SERP_CONCURRENCY:-2}"
export UNBROWSE_TIMEOUT="${UNBROWSE_TIMEOUT:-180}"
WORKERS="${BROWSECOMP_WORKERS:-3}"

bash bench/browsecomp/nebius-port/apply.sh >/dev/null 2>&1 || true

echo "[run-and-record] $RUN_ID: N=$N model=$MODEL grader=$GRADER_MODEL workers=$WORKERS" >&2
START=$(date +%s)
( cd bench/browsecomp/vendor/search_evals
  GRADER_BACKEND="$GRADER_BACKEND" GRADER_MODEL="$GRADER_MODEL" \
  BROWSECOMP_LIMIT="$N" UNBROWSE_BIN="$UNBROWSE_BIN" \
  uv run python search_evals/run_eval.py search_engine=unbrowse \
    model="$MODEL" suite=browsecomp rerun=true max_workers="$WORKERS"
) > "$LOG" 2>&1
RC=$?
END=$(date +%s); LATENCY=$((END-START))
SCORE="$(grep -oE 'Evaluation complete\. Score: [0-9.]+' "$LOG" | tail -1 | grep -oE '[0-9.]+$')"
echo "[run-and-record] $RUN_ID: RC=$RC score=${SCORE:-<none>} latency=${LATENCY}s" >&2

if [ "$RC" -ne 0 ] || [ -z "$SCORE" ]; then
  echo "[run-and-record] eval did not complete cleanly — NOT recording (honest: no fake row)" >&2
  tail -8 "$LOG" >&2
  exit 1
fi

TS="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
python3 - "$LEDGER" "$RUN_ID" "$N" "$SCORE" "$LATENCY" "$TS" "$MODEL" "$LOG_REL" <<'PY'
import json,sys
ledger,run,n,score,lat,ts,model,log=sys.argv[1:9]
row={"run":run,"n":int(n),"score":float(score),"latency_s":int(lat),"ts":ts,"model":model,"log":log,"per_query_s":round(int(lat)/max(int(n),1),1)}
with open(ledger,"a") as f: f.write(json.dumps(row)+"\n")
print("recorded:",json.dumps(row))
PY
echo "[run-and-record] $RUN_ID recorded to $LEDGER" >&2
