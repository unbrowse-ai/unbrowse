# Evaluation and Benchmarks

This page separates the paper's results from evaluations run against the current hosted service. Keep the two apart when citing numbers.

## Paper results

From *Internal APIs Are All You Need* (arXiv:2604.00694):

- 94 production domains; every observed task sat on a JSON or GraphQL endpoint the front end already called
- 3.6x mean and 5.4x median speedup on warmed cached routes versus Playwright
- 90–96% per-task cost reduction for warmed-cache execution
- about 8,000 tokens of DOM reduced to about 200 tokens of structured JSON on typical reads

These are paper results. They have not been re-run against the current service. Cite them as the paper's.

## Current service evaluations

The service's own evaluations run against production (`unbrowse.ai`). The numbers below come from the service's evaluation reports (`docs/eval/*latest.json` and matching reports in the closed-source service repo) and its acceptance ledger. Dates are when each was run.

### Lean evaluation (2026-09-24)

A scripted agent on the service's bundled demo booking site, plus Wikipedia. Five hypotheses, fixed before the run. All five validated:

| | Criterion | Result |
| --- | --- | --- |
| H1 | An agent with only MCP browse tools completes a task on an unseen site in the cloud browser | 2/2 sessions confirmed, recorded with patchright |
| H2 | Finishing the second session indexes a callable capability with no learn call | 4 inputs, 1 choice, network-callable |
| H3 | Warm replay over HTTP, 5/5, median ≤ 25% of browse | 5/5; median warm 1,974 ms vs median browse 36,723 ms (5.4%) |
| H4 | Survives replacing the server | warm run succeeded after restart |
| H5 | Same loop on Wikipedia | one search input; 3/3 warm runs with new terms |

This is one demo site plus one real site. It is not a benchmark across the web.

### Real LLM agent (2026-09-24)

Claude Code headless (Sonnet), given only the Unbrowse MCP tools and the public SKILL.md, fresh user. All four hypotheses validated:

- Books on a site it has never seen by browsing (2/2 cold runs confirmed by a server tool result).
- Its browsing is indexed passively, with the field names it chose.
- 3/3 warm runs book through replay with 0 browser opens. A warm run took 4 tool calls; the first cold run took 12.
- Reuses a replayed capability on Wikipedia with 0 browser opens.

### 100 real sites (2026-09-23)

A generic scripted driver: find the search box, type, press Enter, finish. Twice per site with different queries, then one warm replay with a third query by capability id. `warm_ok` requires `succeeded` and the third query in the result. Criteria fixed before the run.

| Outcome | Sites |
| --- | --- |
| warm_ok | 42 |
| warm_wrong (claimed success without the query) | 2 |
| warm_failed | 22 |
| not_learned | 21 |
| cold_fail | 7 |
| no_search_box | 5 |
| blocked | 1 |

Median cold session 17 s; median warm replay 1,318 ms. Plain-language routing reached the learned capability for 40 of the 42. The bar (≥ 40/100 warm, ≤ 2 false successes) was met.

### Registry crawl (2026-09-25)

The Tranco top-10k list (L5PV4) was crawled on production for site search. Every one of the 10,000 domains ended in a named outcome. Most common: homepage unreachable or erroring (3,705), no search found (3,513), no probe words (1,250), query not shown in results (541), robots.txt disallowed (474), clean replay failed (254). 57 were newly published and 195 were already published.

### Registry sample (2026-09-26)

200 randomly sampled published tools, called from a fresh workspace with inputs they were never verified with:

- 166 ok (83%)
- 0 false successes
- 19 failed, 15 had no fresh input to try

The bar is 85% (170/200) with at most 2% false successes. **Not met yet.** The false-success bar holds.

## How to talk about results

- Paper numbers: say "the paper reports".
- Service numbers: name the evaluation and its date.
- Do not combine them. The paper's 5.4x median speedup and the lean evaluation's 5.4% warm/browse ratio are different measurements on different setups.
