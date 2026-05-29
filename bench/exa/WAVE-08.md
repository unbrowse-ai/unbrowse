# WAVE-08 — BrowseComp first real number + the two-witness lever (2026-05-29)

jesus-loop default / branch `jl/exa-browsecomp`. Both benchmark tracks now emit real
numbers via the OpenRouter grader path. Honest: both BELOW target.

## REAL NUMBERS (agent-judged, no fabrication)
- **BrowseComp = 1/5 = 0.200** vs Exa-published 0.336. n=5 → noisy (±~0.18); a valid
  pipeline-smoke number, NOT a benchmark verdict (Exa's is n≈600). Exit 0.
- **Exa WebCode RAG = 30.0%** vs 79.4 (WAVE-07).

BrowseComp command:
    set -a; . ~/.config/env/global.env; set +a
    export OPENAI_API_KEY="$OPENROUTER_API_KEY"; export OPENAI_BASE_URL="https://openrouter.ai/api/v1"
    cd bench/browsecomp/vendor/search_evals
    UNBROWSE_BIN=/opt/homebrew/bin/unbrowse BROWSECOMP_LIMIT=5 \
      uv run python search_evals/run_eval.py search_engine=unbrowse model=openai/gpt-5-medium suite=browsecomp rerun=true max_workers=2
(model `openai/gpt-5-medium`: harness strips `-medium` → `openai/gpt-5` + reasoning effort
medium; bare `openai/gpt-5` 400s on OpenRouter because effort `none` is rejected — the
`-medium` suffix is required.)

Per-question: Q2 (Amr Zaki) CORRECT; Q1/Q3/Q4/Q5 wrong — on Q3/Q4 the agent GAVE UP and
asked for clarification instead of grinding the multi-hop chain. 1 right, 4 wrong.

## TWO-WITNESS DIAGNOSIS — search() is NOT the bottleneck anymore
Both independent agents (Exa-RAG track + BrowseComp track) concluded the same thing:
- search() health excellent: 9/9 SERP returns per question, 0 empty, correct rank order,
  no bot-wall (DDG-via-unbrowse-impersonate). The WAVE-02/03 blocker is solved.
- The losses are DOWNSTREAM: the agent sees only 1-2 sentence DDG snippets, never page
  bodies. On multi-hop BrowseComp it can't verify the entity and bails; on Exa RAG it gets
  a thin window missing the exact spec sentence.

## #1 LEVER (next wave, corroborated by both tracks)
In `search()`: for the top-k results, call the already-working `extract(source_url)`
(`unbrowse fetch` → markdown) and return the FULL page text in the citation/snippet field
instead of the thin DDG highlight. One build raises BOTH numbers. Secondary: N>1 results
already returned; consider a stronger/longer-budget agent model.

## Gate ledger
- Gate 1 (beat Exa RAG): 30.0% vs 79.4 → NOT met. Lever named.
- Gate 2 (BrowseComp > 0.336): 0.200 (n=5, noisy) → NOT met. Lever named.
- Gates 3/4/5/6: green (WAVE-04/05/06 + cold re-audit).
- Verdict: NO <promise>SHIPPED</promise>. Foundation complete (real harnesses, funded
  grader, real search backend, first numbers); beating Exa is the next multi-wave climb,
  starting with full-page enrichment.
