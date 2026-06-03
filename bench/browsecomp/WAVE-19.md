# WAVE-19 — implement the paper: search via the route graph (first-party Exa), not DDG (2026-05-31)

`/amen "implement the paper... walk the trees of the layer below the dns layer"`.
Pinned (user): **route-graph of first-party APIs** (sp-unbrowse `tree`+`verb`).
Every claim below verified by a real command read from an exited-0 process.

## What was built
Rewrote `bench/browsecomp/unbrowse_browsecomp_searcher.py` `__call__`: PRIMARY path
is now `unbrowse resolve --intent <query>` → the synthetic **exa-web-search** skill
(first-party neural search, the route graph's web-search endpoint), parsed into
ranked results. DDG SERP scrape is now only the last-resort fallback. This is the
paper's thesis: walk the endpoint tree to the first-party search API, don't scrape
the human SERP surface.

## Witness (read from real runs)
- **Easy/medium query** ("CEO of Anthropic + founding"): 5 results, **0 junk** —
  Anthropic & Dario Amodei Wikipedia, Forbes. (DDG gave the same on easy queries.)
- **Hard obscure query** ("graphic designer Malaria Consortium + Ogilvy"): the
  route-graph path, when Exa fires + passes the gate, returns **"Simon Cordery —
  Creative Designer at Malaria Consortium"** (theorg.com) — a real on-target entity.
  DDG returned only wordplays.com crossword / template / jobs junk.

## Two real orchestrator quirks found (honest)
1. **Routing was url-biased + non-deterministic.** `--url <domain>` makes resolve
   prefer (often junk) cached routes and blocks the Exa fallback. **Dropping
   `--url` routes deterministically to exa-web-search** (3/3 tries). Searcher fixed
   to omit `--url`.
2. **Quality gate discards hard-query Exa hits.** `src/orchestrator/index.ts` gates
   exa candidates (`maxScore>0 || hitRate>=0.34 || hasRichHit`); for obscure
   entities Exa's scores are low → discarded → 0 candidates → DDG fallback. So the
   HARDEST queries still degrade to DDG. The clean next node is an orchestrator
   path that returns RAW exa candidates (agent judges relevance), not a gate.
- Also fixed: `_clean` now strips bare `info:`/`warn:` kuri logs, and the JSON
  parse uses `raw_decode` (resolve prints JSON then trailing logs → "Extra data").

## In flight
BrowseComp eval, gpt-4.1 agent + gpt-4.1 grader + **route-graph searcher**, N=10,
vs the DDG baseline (gpt-4.1+DDG = 0/10, Kimi+DDG = 0.10). Measures whether
first-party Exa retrieval moves accuracy off 0.
