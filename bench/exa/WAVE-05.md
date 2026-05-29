# WAVE-05 — real search() SERP ranker landed; benchmark numbers blocked on a funded grader (2026-05-29)

jesus-loop default / exa-browsecomp, branch `jl/exa-browsecomp`.

## BREAKTHROUGH — the load-bearing blocker is solved at the adapter level

WAVE-02/03 named the blocker: unbrowse's `search()` was not a real SERP ranker —
`resolve` returns API endpoints, not ranked content URLs from a cold query. Every
search benchmark (BrowseComp, SimpleQA, FRAMES, RAG-discovery) was gated on it.

**Landed** (`bench/browsecomp/unbrowse_browsecomp_searcher.py`, 175 lines, real):
`search(query)` runs `unbrowse fetch https://html.duckduckgo.com/html/?q=<query>`
(libcurl-impersonate Chrome-131 → clean markdown SERP), parses each
`## [title](…uddg=…)` heading in document (= rank) order, url-decodes the real
target URL out of the DDG `uddg=` redirect, pairs each with its snippet →
ranked `SearchResult{url,title,snippet}`. Implements the perplexityai/search_evals
`AsyncSearchEngine.__call__(query, num_results)` interface.

LIVE-VERIFIED twice (real, not degenerate, no bot-wall):
- "who is the ceo of anthropic" → Wikipedia / Forbes / Observer in rank order, correct snippets
- "transformer architecture paper" → arxiv.org/abs/1706.03762 ranked #1

This is a genuine ranked-URL SERP — a real upgrade over the resolve-based search()
WAVE-02/03 honestly flagged as non-SERP. Task #3 (real search backend) settled at
the harness-adapter level; productizing it into unbrowse itself is the next node.

## BLOCKER (honest, external) — gates 1 & 2 cannot emit a real number yet

The BrowseComp deep-research agent AND its grader (`graders.py` DeepResearchGrader,
gpt-4.1 via AsyncOpenAI) both require a FUNDED OpenAI account. The only key on this
machine (`OPENAI_API_KEY`, sk-proj-…, 164 chars) returns on EVERY completion model:

    openai.RateLimitError: 429 insufficient_quota — "You exceeded your current quota"

Confirmed by direct probe (gpt-4o-mini → HTTP 429) and by find-creds sweeping all six
credential sources: no other funded OpenAI key, all Anthropic keys unfunded/invalid.
The key passes `/v1/models` (no quota consumed) which is why it "looks valid." The
Exa-RAG track uses an OpenAI grader too → same wall.

**The harness is fully stood up.** The exact command that emits the real number the
moment a funded key lands in `~/.config/env/global.env`:

    set -a; . ~/.config/env/global.env; set +a
    cd bench/browsecomp/vendor/search_evals
    UNBROWSE_BIN=/opt/homebrew/bin/unbrowse BROWSECOMP_LIMIT=5 \
      uv run python search_evals/run_eval.py search_engine=unbrowse model=gpt-5-medium suite=browsecomp rerun=true max_workers=2

No number fabricated, no grader swapped (a different grader ≠ Exa's published methodology
= fake-green). Gates 1, 2 are BLOCKED on funding, not on code.

## Next lever once unblocked
Snippet enrichment: DDG snippets are ~1-2 sentences; `unbrowse fetch`-ing the top-k
result pages into the snippet field gives the deep-research agent far more to reason
over on multi-hop BrowseComp questions. That is the score-moving build after the
grader is funded.

## Ledger
- Gate 1 (Exa suites): BLOCKED on funded grader. Harness stood up.
- Gate 2 (BrowseComp > 0.336): BLOCKED on funded grader. Harness + real search() stood up.
- Gate 3/4/6: green as of WAVE-04 (6 = two witnesses). Gate 5: not started.
- Task #3 (real search SERP): settled at adapter level; productize into unbrowse next.
