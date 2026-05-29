# WAVE-04 — jesus-loop `exa-browsecomp` Day-1 Light (2026-05-29)

Session: `.codex/jesus-loop.exa-browsecomp.local.md` · branch `jl/exa-browsecomp`
(based on `feat/v7-covenant-cdp` HEAD after konmari).

North star = the completion promise: two-witness reproducible beat of Exa on every
targeted benchmark AND BrowseComp > 0.336; whitepaper evaled + benchmarked to spec
(paper-gate + leak-guard green); obsolete guardrails gone; 10-commandments seal
honored (no fake-green); ship to prod via npm AND an auditable OSS GitHub client
matching the whitepaper without leaking the moat (capture/RE/economic engine + zk
kept as moat & auth); every value flow toll-boothed via a fair game-theoretic
x402 split. **Release actions (npm/github/prod) are CONFIRM-GATED.**

## The six completion gates and their honest Day-1 state

| # | gate | state | witness |
|---|---|---|---|
| 1 | unbrowse > Exa published on EVERY targeted Exa benchmark | ⏳ running | bg agent: clone exa-labs/benchmarks, run `evals.rag --limit 10` → first real groundedness vs 79.4 |
| 2 | BrowseComp accuracy > 0.336 reproduced | ⏳ running | bg agent: clone perplexityai/search_evals, wire real search(), run suite=browsecomp --limit 10 → first real number |
| 3 | whitepaper reflects code + no moat leak + benchmark-backed | 🟡 partial | `paper-gate.sh` PASS (25 anchors, 0 leaks) + `leak-guard.sh` clean — STRUCTURAL green; benchmark-backing waits on gates 1–2 |
| 4 | obsolete guardrails removed + 10-commandments seal | 🟢 advanced | konmari commit removed 21 obsolete `bench-*.sh` + per-dir CLAUDE.md; precommit seal (leak-guard + contract-leak + paper-gate) passing |
| 5 | OSS GitHub client auditable vs whitepaper, zero moat leak | ⬜ not started | needs the public `@unbrowse/client` surface mapped claim-by-claim to the paper |
| 6 | toll/x402 fair-split wired in code | 🟢 witness-1 | `bun test x402-gate + flex-owner-bps + pricing + x402-end-to-end` = 51/51 pass; `covenant-seed.ts` meter()/tollNode() shipped (operator cut + first-discoverer reward + site absorbs rounding, sums exactly, no leak) |

## The load-bearing blocker (named, from WAVE-02/03)

`extract()` (via `unbrowse fetch`) WORKS and yields markdown. **`search()` is NOT a
real SERP ranker** — `unbrowse resolve` returns API endpoints for an intent, not a
ranked list of content URLs from a cold query. Every search-shaped benchmark
(BrowseComp, SimpleQA, FRAMES, RAG-discovery, People/Company SERP) is gated on this.
The moat-aligned fix (task #3): drive unbrowse's own browse layer (go → snap →
extract links) as the query→ranked-URLs engine — the node-7 agentic retrieve loop.
Wave-1 agents are probing whether a search-engine-via-browse path returns real URLs.

## Wave-1 honest verdict (no box ticked without a real number)

Day-1 settled the cheap, real, non-benchmark gates (3 structural, 4, 6-witness-1).
The two headline benchmark numbers (gates 1, 2) are being produced by background
agents against the real harnesses — those numbers, agent-judged, are what tick
gates 1 and 2. Nothing fabricated. WAVE-05 will record the real numbers + the
search() verdict and re-cost the walk.
