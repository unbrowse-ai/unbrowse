---
active: false
step: 9
harness_ws:
completion_promise: "HOLD"
started_at: "2026-06-26T00:00:45Z"
---

until unbrowse is contract native by using Userslekt9agentskillscontract deployed aiko against all of unbrowse to benchmax against the papers and contract ledger and all the seal benchmark to complete it

## Benchmax at scale — COMPLETE (all four benchmarks ran, all RED)

| Benchmark | N | Score | Target | Status |
|---|---|---|---|---|
| SEAL-0 | 111/111 | 3.6% | 24.3% | RED |
| exa RAG | 307/307 | 44.6% groundedness | 79.4% | RED |
| exa Highlights | 177/250 | 63.2% groundedness | 94.8% | RED |
| BrowseComp robust | 25/25 | 0.0% | >33.6% | RED |

Infrastructure: GREEN (grader skin 4-provider probe chain works, Nebius scored all benchmarks, model override bug fixed).
Contract-native: GREEN (committed v11.1.0, 4 organs, Tier 0 wired).
Benchmarks: RED (all four below targets — honest, not fabricated).

## Retrieval fix applied (unbrowse_searcher.py)
- Bug: `_clean()` was not called on `search()` stdout before `json.loads()` — trace lines broke JSON parse, returned empty results
- Fix: added `stdout = _clean(stdout)` before JSON parse
- SEAL-0 re-run with fix: still 3.6% (4/111) — predictions now have real content (no more "No evidence retrieved"), but LLM reasoning quality is the bottleneck. 10 errored (empty predictions), 15 close misses (off by 1-2).
- RAG searcher (exa vendor) uses different parsing (`_parse_envelope` line-by-line) — no same bug.
