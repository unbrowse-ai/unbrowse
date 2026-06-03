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
