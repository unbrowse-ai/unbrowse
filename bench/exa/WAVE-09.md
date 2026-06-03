# WAVE-09 — full-page enrichment in search(): RAG 30.0% → 60.0% (2026-05-29)

Branch `jl/exa-browsecomp`. The WAVE-08 #1 lever (corroborated by both tracks) was
FULL-PAGE ENRICHMENT in search(): for the top-k ranked SERP results, fetch the
source page via `unbrowse fetch` → markdown and put the FULL page body into the
result text/snippet field (was: thin 1-2 sentence DDG highlight).

## BUILD (both committed adapters)
- `bench/exa/unbrowse_searcher.py`: search() now runs a real ranked DDG SERP
  (libcurl-impersonate fetch of html.duckduckgo.com) then concurrently (bounded
  semaphore) full-page-enriches the top-3 into `text` (the field evals.rag reads),
  capped at 8000 chars. Honest-empty on SERP failure; thin DDG snippet kept as
  fallback if a per-page fetch fails. (Already landed by peer commit 09cc16f07;
  this wave reproduced it byte-identical + re-measured.)
- `bench/browsecomp/unbrowse_browsecomp_searcher.py`: same enrichment, top-3 into
  `snippet`. Made always-on (WAVE-09 made it default rather than opt-in).
- Mirrored into the registered vendor locations (gitignored vendor/):
  `bench/exa/vendor/benchmarks/shared/shared/searchers/unbrowse.py`,
  `bench/browsecomp/vendor/search_evals/search_evals/search_engines/unbrowse.py`.

## REAL NUMBER (Exa WebCode RAG, agent-judged, no fabrication)
**Groundedness = 60.0% (6/10) — UP from 30.0% (WAVE-07), +30 pts, doubled.**
Still BELOW Exa published 79.4.
- Correctness 40.0% (held). Citation-Precision 24.0% (down from 50.0% — full pages
  dilute precision but vastly raise groundedness; the grounder now finds the exact
  passage). Avg 1164 citation tokens (was 804).
- Per-query grounded flips vs WAVE-07: now grounded = rag_002,004,005,007,008,009
  (6/10). rag_001/003/006/010 still ungrounded.
- Command (uv run resolves the `shared` workspace package — bare python3 fails):
    set -a; . ~/.config/env/global.env; set +a
    export OPENAI_API_KEY="$OPENROUTER_API_KEY"; export OPENAI_BASE_URL="https://openrouter.ai/api/v1"
    export UNBROWSE_BIN=/opt/homebrew/bin/unbrowse UNBROWSE_ENRICH_TOP_K=3 UNBROWSE_ENRICH_CHARS=8000
    cd bench/exa/vendor/benchmarks/webcode-benchmark
    uv run python -m evals.rag --searchers unbrowse --limit 10 --concurrency 5 \
      --grader-model openai/gpt-5.4 --rag-model openai/gpt-5.4-mini --output /tmp/rag_enriched.json

## BrowseComp — adapter verified, scored run BLOCKED on funding
- Adapter self-test LIVE-verified through the real import path: DDG SERP ranked
  correctly (Wikipedia/Forbes/Observer/fello/LinkedIn for "anthropic ceo"), top-3
  enriched to full page bodies, others keep thin snippet. Honest fallback works.
- The scored limit-10 run crashed mid-run: `openai.APIStatusError 402 — This
  request requires more credits` (gpt-5-medium reasoning agent requests up to 65536
  tokens; OpenRouter balance could only afford ~37993). Enrichment ADDS page text to
  the agent context, raising token spend, which tipped the already-low balance.
- No fresh n=10 BrowseComp number this wave. The committed aggregate is the stale
  WAVE-08 n=5/0.200. Gate 2 is now BLOCKED on OpenRouter funding, not on code.

## Gate ledger
- Gate 1 (beat Exa RAG 79.4): 60.0% → NOT met, but +30 pts from enrichment. Next
  lever: tune retrieval to also recover rag_001/003/006/010 (full doc present but
  grounder missed) and lift citation-precision back without losing groundedness.
- Gate 2 (BrowseComp > 0.336): adapter ready, run BLOCKED on OpenRouter 402. Re-run
  the moment credits are topped up; consider lower agent max_tokens or cheaper model.
