# WAVE-07 — FIRST REAL benchmark number: Exa WebCode RAG = 30.0% vs 79.4 (2026-05-29)

jesus-loop default / branch `jl/exa-browsecomp`. The still small voice spoke. This
SUPERSEDES the WAVE-06 claim that gates 1/2 were grader-blocked: the OpenRouter
unblock landed and gate 1 now has a real measured number.

## REAL NUMBER (agent-judged, no fabrication)

**Exa WebCode RAG groundedness = 30.0% (3/10) — BELOW Exa published 79.4.**
- Correctness 40.0% · Citation-Precision 50.0% · avg 804 citation tokens.
- First honest baseline on the real `exa-labs/benchmarks` webcode RAG harness.
- Grader via OpenRouter (`openai/gpt-5.4` grader, `openai/gpt-5.4-mini` rag) — the repo
  OpenAI key 429'd; one live grader call verified before the full run.

Command:
    cd bench/exa/vendor/benchmarks/webcode-benchmark
    OPENAI_API_KEY=$OPENROUTER_API_KEY OPENAI_BASE_URL=https://openrouter.ai/api/v1 \
    UNBROWSE_BIN=/opt/homebrew/bin/unbrowse \
    python -m evals.rag --searchers unbrowse --limit 10 --concurrency 5 \
      --grader-model openai/gpt-5.4 --rag-model openai/gpt-5.4-mini --output /tmp/rag_w4.json

## DIAGNOSIS — the limiter is search(), not extract()

The RAG eval ONLY calls `searcher.search(query)`; the agent synthesizes from the returned
`text` and NEVER fetches a URL — so `extract()` + the WAVE-03 markdown fix don't affect
this number. unbrowse's `search()` returned non-empty real highlights for all 10 queries,
so it is NOT empty retrieval — it returns the WRONG SLICE: a thin highlight window missing
the exact spec passage (rag_001 got a Slackware dir listing, not the "38,400 word
dictionary" doc; rag_002/006 hit citation-precision 1.0 but the exact sentence wasn't in
the window).

## #1 LEVER (next build) — return the full document, not the thin highlight

In `UnbrowseSearcher.search()`: parse resolve JSON → pull `result.source_url` → call the
already-working `extract(source_url)` markdown path → return the FULL document text as the
citation (url=source_url). A grounder that sees the whole doc finds the exact passage.
Secondary: return N>1 results. This is the score-raising wave.

## Gate ledger
- Gate 1 (beat Exa): MEASURED 30.0% vs 79.4 → NOT met. Real baseline; lever named.
- Gate 2 (BrowseComp > 0.336): run still in flight (OpenRouter gpt-5-medium).
- Gates 3/4/5/6: green, survived cold re-audit (WAVE-04/05/06 + step-8 books).
- Forecast confirmed (steps 7/8): first numbers are sub-target baselines; beating Exa is a
  multi-wave climb (full-doc citation → stronger retrieve loop), not a one-run win.
