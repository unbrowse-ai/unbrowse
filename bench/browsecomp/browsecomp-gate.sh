#!/usr/bin/env bash
# Witness: solve BrowseComp via unbrowse — a REAL eval reports accuracy > 0.336.
#
# Un-fakeable: it RE-RUNS the actual search_evals BrowseComp eval (unbrowse
# search() + agent + grader) and reads "Evaluation complete. Score: X" from the
# process that exited 0. Exits 0 iff X > 0.336 (Exa's BrowseComp number).
#
# Honesty: the default pipeline (Kimi agent + Kimi grader) is REAL + reproducible
# but NOT apples-to-apples with Exa's gpt-4.1-graded 0.336. Set the agent/grader
# to the OpenAI path for the clean comparison. N defaults to 10 (bounded cost).
set -uo pipefail
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$REPO"
set -a; . ./.env 2>/dev/null || true; set +a
# OpenRouter key (gpt-4.1 agent + grader, the apples-to-apples Exa pipeline).
. ~/.config/unbrowse-bench/openrouter.env 2>/dev/null || true

N="${BROWSECOMP_GATE_N:-10}"
# Default pipeline: gpt-4.1 via OpenRouter (chat-completions through the nebius
# backend) when the OpenRouter key is present; else fall back to Nebius Kimi.
if [ -n "${OPENROUTER_API_KEY:-}" ]; then
  MODEL="${BROWSECOMP_GATE_MODEL:-nebius/openai/gpt-4.1}"
  GRADER_BACKEND="${BROWSECOMP_GRADER_BACKEND:-nebius}"
  GRADER_MODEL="${BROWSECOMP_GRADER_MODEL:-openai/gpt-4.1}"
  export NEBIUS_BASE_URL="https://openrouter.ai/api/v1"
  export NEBIUS_API_KEY="$OPENROUTER_API_KEY"
else
  MODEL="${BROWSECOMP_GATE_MODEL:-nebius/moonshotai/Kimi-K2.6}"
  GRADER_BACKEND="${BROWSECOMP_GRADER_BACKEND:-nebius}"
  GRADER_MODEL="${BROWSECOMP_GRADER_MODEL:-moonshotai/Kimi-K2.6}"
fi

# Binary selection: the globally-installed unbrowse is frequently stale (no
# working `search` exa path → 0 retrieval → a false 0.0 that measures the binary's
# age, not unbrowse's capability). If UNBROWSE_BIN is unset, probe the global
# binary's `search` once; if it returns no JSON, fall back to the source-backed
# wrapper so the gate measures the REAL current code. Honest: this runs source,
# which is what a release would ship — not a mock.
if [ -z "${UNBROWSE_BIN:-}" ]; then
  GLOBAL="/opt/homebrew/bin/unbrowse"
  if [ -x "$GLOBAL" ] && timeout 60 "$GLOBAL" search --intent "ping" --pretty 2>/dev/null | grep -q '"result"'; then
    UNBROWSE_BIN="$GLOBAL"
  else
    UNBROWSE_BIN="$REPO/bench/browsecomp/.unbrowse-src"
    echo "[bc-gate] global unbrowse stale/missing 'search' — using source binary $UNBROWSE_BIN" >&2
    # The source binary cold-boots the in-process app per call (~23s). Per-result
    # enrichment (5 extra `fetch` cold-boots/query) + high concurrency then blows
    # past UNBROWSE_TIMEOUT → 0 results → false 0.0. With the source binary, default
    # enrichment OFF (exa_candidates already carry highlights_excerpt) and serialize
    # so each ~23s search completes. A warm/daemon binary would lift these later.
    : "${UNBROWSE_ENRICH_TOP_K:=0}"; export UNBROWSE_ENRICH_TOP_K
    : "${UNBROWSE_SERP_CONCURRENCY:=2}"; export UNBROWSE_SERP_CONCURRENCY
    : "${BROWSECOMP_WORKERS:=2}"; export BROWSECOMP_WORKERS
    : "${UNBROWSE_TIMEOUT:=180}"; export UNBROWSE_TIMEOUT
  fi
  export UNBROWSE_BIN
fi

bash bench/browsecomp/nebius-port/apply.sh >/dev/null 2>&1 || true
cd bench/browsecomp/vendor/search_evals

LOG="$(mktemp)"
echo "[bc-gate] running real BrowseComp eval (N=$N, model=$MODEL, grader=$GRADER_MODEL)..." >&2
GRADER_BACKEND="$GRADER_BACKEND" GRADER_MODEL="$GRADER_MODEL" \
UNBROWSE_ENRICH_TOP_K="${UNBROWSE_ENRICH_TOP_K:-5}" \
BROWSECOMP_LIMIT="$N" UNBROWSE_BIN="${UNBROWSE_BIN:-/opt/homebrew/bin/unbrowse}" \
uv run python search_evals/run_eval.py search_engine=unbrowse \
  model="$MODEL" suite=browsecomp rerun=true max_workers="${BROWSECOMP_WORKERS:-5}" \
  > "$LOG" 2>&1
RC=$?
SCORE="$(grep -oE 'Evaluation complete\. Score: [0-9.]+' "$LOG" | tail -1 | grep -oE '[0-9.]+$')"
echo "[bc-gate] RC=$RC  score=${SCORE:-<none>}" >&2
if [ "$RC" -ne 0 ] || [ -z "$SCORE" ]; then
  echo "[bc-gate] FAIL — eval did not complete cleanly"; tail -5 "$LOG" >&2; exit 1
fi
# gate: SCORE > 0.336
awk -v s="$SCORE" 'BEGIN{ exit !(s+0 > 0.336) }'
if [ $? -eq 0 ]; then
  echo "[bc-gate] PASS — BrowseComp accuracy $SCORE > 0.336"; exit 0
fi
echo "[bc-gate] not yet — accuracy $SCORE <= 0.336 (target beat Exa 0.336)"; exit 1
