# TARGETS.md -- node 1 (root) settled: the reproducible Exa numbers to beat

Pinned from a cited web inventory (2026-05-29). Only REPRODUCIBLE targets listed;
marketing-only claims are recorded at the bottom so we never chase a number with
no public harness. This is the axiom the whole walk measures against.

## Tier 1 -- Exa's OWN open harness (github:exa-labs/benchmarks, MIT)

Plug a `Searcher` (search() + extract()) and you compete head-to-head with Exa's
published columns. Requires Python 3.11+, EXA_API_KEY + OPENAI_API_KEY (grader).

| rank | suite | metric | BEAT (Exa published) | dir / command |
|---|---|---|---|---|
| 1 | WebCode RAG | groundedness | > 79.4 (cite-prec 0.259; Brave 0.328 already > Exa) | webcode-benchmark `python -m evals.rag` |
| 2 | Company RAG | fact-extract accuracy | > 79% | simple-company-benchmark `cbench --track rag` |
| 3 | People Search | R@1 / R@10 / precision | > 72.0 / 94.5 / 63.3 | simple-people-benchmark `pbench` |
| 4 | Company Retrieval | R@1 / precision | > 61.8 / 65.9 (softest target) | simple-company-benchmark `cbench --track retrieval` |
| ~~5~~ | ~~WebCode Contents~~ | **NOT REPRODUCIBLE** | golden_markdown licensing-excluded (WAVE-02) | non-comparable to 82.8 — do NOT chase |
| 6 | WebCode Highlights | groundedness / correctness | > 94.8 / 93.2 (hardest) | webcode-benchmark `python -m evals.highlights` |

## Tier 2 -- public dataset + public neutral harness (Exa shown mid-pack = winnable)

| rank | suite | metric | BEAT (Exa 3rd-party rerun) | harness |
|---|---|---|---|---|
| 7 | SimpleQA | accuracy | > 0.874 (perplexity harness) or > 0.7124 (tavily) | github:perplexityai/search_evals / tavily-ai/tavily-search-evals |
| 8 | FRAMES | multi-hop accuracy | > 0.881 | perplexityai/search_evals (suite=frames); data hf:google/frames-benchmark, arxiv:2409.12941 |
| 9 | BrowseComp | accuracy | > 0.336 (most winnable headline) | perplexityai/search_evals (suite=browsecomp); arxiv:2504.12516 |
| 10 | DSQA / HLE / SEAL-0 | accuracy | > 0.420 / 0.314 / 0.243 | perplexityai/search_evals |

## DO NOT CHASE (marketing, no public harness -- counter-position only)

- Exa Fast/Instant latency (exa.ai/blog/exa-instant, fastest-search-api)
- exa-code hallucination (exa.ai/blog/exa-code)
- Websets vs Google 320x (exa.ai/blog/websets-evals -- proprietary 200-query set)
- Exa Deep / Deep Max 90/94/80% (exa.ai/blog/deep-max -- harness private)
- versus/perplexity 64.8% (private customer eval)

Sources: github:exa-labs/benchmarks ; exa.ai/blog/webcode ; exa.ai/blog/people-search-benchmark ;
exa.ai/blog/api-evals ; github:perplexityai/search_evals ; github:tavily-ai/tavily-search-evals ;
arxiv:2409.12941 ; arxiv:2504.12516
