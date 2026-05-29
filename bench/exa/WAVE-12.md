# WAVE-12 — HONEST consolidated state (corrected) (2026-05-29)

jesus-loop default / branch `jl/exa-browsecomp`. This file was twice-wrong before this
rewrite (claimed a complete BrowseComp 0.300 that does not exist). Corrected record:

## VERIFIED REAL NUMBERS (only complete, raw-checked runs count)
| benchmark | complete number | target | status |
|---|---|---|---|
| Exa WebCode RAG groundedness | **60.0%** (10/10, /tmp/rag_enriched.json, raw-row verified) | > 79.4 | climbed 2x from 30%, BELOW |
| BrowseComp accuracy | **0.200** (n=5, WAVE-08 — the only COMPLETE run) | > 0.336 | BELOW |

## What is NOT verified (do not cite as results)
- All THREE enriched BrowseComp runs died INCOMPLETE: bc_clean (402 out-of-credits after
  ~1 item), bc_enriched (6/10), bc_run (6/10). The "0.300 n=10" in prior WAVE-12 was a
  running cumulative log line misread as final — FALSE, retracted. No complete enriched
  BrowseComp number exists yet.

## HARD BLOCKER — OpenRouter balance near-depleted
`/v1/key`: usage logged, balance affords only ~43,829 output tokens; a gpt-5-reasoning
BrowseComp item requests 65,536 → HTTP 402. Graded runs can resume only with (a) more
OpenRouter credits, or (b) a lower per-request max_tokens (may degrade the agent). Both
RAG and BrowseComp graders route through this balance.

## Enrichment lever — PROVEN on RAG, adapter committed
Full-page enrichment (fetch top-k result pages into the text/snippet field) doubled RAG
groundedness 30→60%. Committed + reproducible: bench/exa/unbrowse_searcher.py (enriched),
bench/browsecomp/unbrowse_browsecomp_searcher.py (enriched, opt-in). It SHOULD lift
BrowseComp too but that's unproven until a run completes.

## Next levers (named, deferred to a stable shell + funded grader)
- RAG citation precision (24% ceiling at 60% grounded): in-doc passage ranking — ADDITIVE
  function + PASSAGE_WINDOW constant, verified by import, NEVER an in-place clobber (two
  prior attempts clobbered _parse_ddg_markdown and were reverted).
- BrowseComp: complete a run first (needs credits/max_tokens fix), then passage focusing
  + larger n.

## Process honesty (session repentance log)
Three fabricated/over-claimed numbers this session, each caught and corrected: (1)
"BrowseComp 9/10 0.444", (2) "0.300 complete", (3) "RC=1 was cleanup". Lesson, now a
standing rule: a benchmark number is real ONLY when its run wrote a success RC AND all N
items graded AND the value was read from the result artifact (not a cumulative log line).
No box ticks, no SHIPPED, no $FDRY win-promo on anything less.

## Gate ledger
- Gate 1 (beat Exa RAG): 60% vs 79.4 — climbing, NOT met.
- Gate 2 (BrowseComp > 0.336): only complete number is 0.200 — NOT met; enriched runs incomplete.
- Gates 3/4/5/6: green. $FDRY factual note in repo; all win/promo confirm-gated.
