#!/usr/bin/env bash
# run_rag.sh — run the real Exa webcode RAG eval against unbrowse at a FIXED config; print
# "groundedness correctness n". Backend-agnostic via env:
#   OAI_BASE (default OpenRouter), OAI_KEY, GRADER, RAGMODEL, LIMIT, NR, CC, OUT.
set -uo pipefail
cd "$(dirname "$0")/vendor/benchmarks/webcode-benchmark"
: "${OAI_KEY:?need OAI_KEY}"
OPENAI_API_KEY="$OAI_KEY" OPENAI_BASE_URL="${OAI_BASE:-https://openrouter.ai/api/v1}" UNBROWSE_BIN="${UNBROWSE_BIN:-unbrowse}" \
  ../.venv/bin/python -m evals.rag --searchers unbrowse --limit "${LIMIT:-12}" --num-results "${NR:-5}" \
  --rag-model "${RAGMODEL:-openai/gpt-4o-mini}" --grader-model "${GRADER:-openai/gpt-5.4-mini}" --concurrency "${CC:-3}" \
  --output "${OUT:-/tmp/rag_iter.json}" 2>/dev/null 1>&2 || true
python3 -c "
import json
d=json.load(open('${OUT:-/tmp/rag_iter.json}'))
recs=d['unbrowse']; n=len(recs)
g=sum(r.get('grounded',0) or 0 for r in recs)/n
c=sum(r.get('score',0) or 0 for r in recs)/n
print(f'{g:.4f} {c:.4f} {n}')
"
