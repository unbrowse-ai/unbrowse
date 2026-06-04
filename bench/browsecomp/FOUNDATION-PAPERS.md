# BrowseComp foundation papers — what the competition actually published, and the cited route to beat it

**Lever (2026-06-04):** "Did Tavily/Exa/any search engine write an arXiv foundation paper for how they solved it — and can we do a way better via the route-graph thesis?" Answered by three independent web-research witnesses, every claim carrying a real source. This file is the cited roadmap the `jesus-ralph` BrowseComp loop walks.

## 1. Do the search vendors have arXiv foundation papers? — NO (verified)

| Vendor | arXiv paper? | What they published instead | BrowseComp method published? |
|---|---|---|---|
| **Exa** (ex-Metaphor) | **None** (arxiv.org returns 0 Exa/Metaphor-authored hits) | Engineering blog posts only — [exa.ai/research](https://exa.ai/research), [announcing-exa](https://exa.ai/blog/announcing-exa); richest method source is CEO Will Bryk on [Latent Space](https://www.latent.space/p/exa) | No. Headline number is **SimpleQA 94.9%**, not BrowseComp. |
| **Tavily** | **None** — no paper, no whitepaper | Marketing docs only ([tavily.com/blog](https://www.tavily.com/blog), docs.tavily.com). Appears in arXiv *only as a tool consumed by* others (DeepResearcher 2504.03160). | No. |
| **Brave** | **None on arXiv** | Self-published **Goggles whitepaper** (2021, [brave.com/.../goggles.pdf](https://brave.com/wp-content/uploads/2021/03/goggles.pdf)) + index/summarizer docs | No. Publishes only usage stats. |
| **Perplexity** | None describing the search method | Model cards / blog | No. |

**The only real academic foundation papers in this space are the open agentic-search papers** (below) and the benchmark itself: **BrowseComp — arXiv:2504.12516** (OpenAI), 1,266 hard obscure-entity multi-hop questions.

### Exa's actual method (verified from blog + Latent Space, not a paper)
1. **Next-link prediction** training objective ("neural PageRank"): hide a link in surrounding text, train the model to predict the target URL, billions of times — learns which page text refers to, across many phrasings.
2. Embedding + approximate-nearest-neighbor retrieval (meaning-based, full-sentence queries).
3. Self-hosted three-system stack (crawler / embedding models / custom vector DB) with Matryoshka embeddings, binary quantization, memory-reduced BM25, ~$5M H200 cluster.
4. LLM-labeled SFT on top of the base retriever.
5. An agentic deep-research loop wrapping the retriever (iterative search-synthesize → structured output).

## 2. What ACTUALLY moves BrowseComp accuracy (cited, ranked by evidence)

The decisive finding from the BrowseComp paper itself: **a flat search→LLM pipeline caps near 0.3–0.4** (GPT-4o+browsing = **1.9%**; Deep Research, an RL-trained browser = **51.5%**; human trainers = 29.2%). The gains are NOT a better single retrieval call. They are:

| # | Lever | Cite | Reported gain | Needs retraining? |
|---|---|---|---|---|
| 1 | **Parallel sampling + best-of-N / confidence aggregation** (N rollouts, aggregate by confidence) | arXiv:2504.12516; corroborated 2510.06135 | **+15–25%** on BrowseComp at N=64; best-of-N the top aggregator | **No** — pure orchestration |
| 2 | **Per-document retrieve→reason→distill→verify** (denoise each page before it enters the chain) | Search-o1 (2501.05366) "Reason-in-Documents"; Self-RAG (2310.11511) reflection/self-critique | +10–26% multi-hop QA | No (prompt/orchestration) |
| 3 | **Iterative multi-hop search policy** (query decomposition, reformulate on failure, cross-document corroboration) | Search-R1 (2503.09516) +10–26%; R1-Searcher (2503.05592) +21–48%; DeepResearcher (2504.03160) +28.9pts | large on multi-hop | RL ideally; **orchestration captures most** |
| 4 | **RL-trained browsing policy on hard synthesized data** (KG/graph-sampled, uncertainty-injected) | WebSailor (2507.02592) 12→35% BrowseComp; DeepDive (2509.10446) **14.8% @32B**, best open SOTA | best open numbers | **Yes** — out of loop scope |

## 3. The route-graph thesis advantage (why we can plausibly beat the flat pipeline)

Levers 1–3 need **no model retraining** — they are pure agentic orchestration, and orchestration is exactly what unbrowse's own paper already names as built-but-unwired nodes:
- **`witness . eval` — cross-document corroboration** ≙ lever 1 (best-of-N) + lever 3 (cross-doc verify).
- **`loop . build` — agentic retrieve-reflect loop = runtime DAG recompute** (the project NORTH STAR) ≙ lever 2 + lever 3.
- **content-addressed sealed cache** ≙ memoise each resolved sub-question so parallel rollouts and re-derivation are cheap (the paper's KV-cache-all-the-way-down).

So the honest competitive claim is NOT "our retriever beats Exa's neural PageRank." It is: **Exa/Tavily ship a single best retrieval call; the published SOTA is an agentic loop with best-of-N + per-document verification over retrieval. The route graph turns each resolved sub-question into a cached, content-addressed node, so the loop in lever 1–3 is cheaper to run wide (parallel) and deep (multi-hop) than on a metered per-call search API.** That is a route-graph-native version of the exact technique the leaderboard rewards.

## 4. Next build for the loop (highest evidence ÷ cost first)

Current harness = flat `unbrowse search → deep_research agent → grader`, scoring **0.0** on a 10-Q slice (real zero; agent answers are coherent but wrong on obscure gold). Ordered build plan:

1. **Best-of-N + confidence aggregation** over the existing agent (lever 1, +15–25%, no retraining) — run K independent rollouts per question, aggregate. Cheapest, highest-cited, model-agnostic. *Caveat: best-of-N amplifies a non-zero base rate; if a slice is 0/K single-shot it can stay 0 — so it pairs with (2).*
2. **Per-document reason-distill** (lever 2 / Search-o1): after retrieval, a reasoning pass extracts+verifies the target fact from each page before the agent commits — attacks the "coherent but wrong" failure directly.
3. **Multi-hop decomposition + reformulate-on-failure** (lever 3): decompose the question into sub-entities, resolve each through the route graph (cached), corroborate across documents before answering.

Each step adds a probe to the bench and is gated by `browsecomp-gate.sh` (> 0.336 = beat Exa). No fabricated green: a step ships only if the measured slice score rises.

## Measured trajectory (2026-06-04, gpt-4.1 agent + gpt-4.1 grader, source binary)

All real, each committed with its delta. No fabricated green.

| config | slice | score | lever |
|---|---|---|---|
| single-shot, snippets | first-10 | **0.0** | flat pipeline (= Exa/Tavily shape) |
| best-of-3, snippets | first-10 | 0.1 | #1 parallel vote (2504.12516) — weak: rollouts rarely agree on a ~0 base rate |
| **distill, single-shot** | first-10 | **0.2** | #2 reason-distill (2501.05366) — the big lever: full-page constraint-checked evidence |
| distill + best-of-3 | first-9 | ~0.22 | not additive on this slice; vote sometimes discards a correct rollout |

### Robust gate measurement (N=50, the honest number)

The first-10 slice was favorable noise. On a robust **N=50** slice, gpt-4.1 agent +
gpt-4.1 grader + unbrowse-search + distill, single-shot, scores **0.08 (4/50)**,
0 API errors. That is **~1/4 of Exa's 0.336** — the gate is NOT met, and not close.

| config | slice | score |
|---|---|---|
| distill, single-shot, gpt-4.1 | first-10 | 0.2 (noise) |
| distill, single-shot, gpt-4.1 | **N=50 (robust)** | **0.08** |
| distill, single-shot, Kimi-K2.6 | N=10 | 0.1 |
| **deep-agent** (decompose→verify→backtrack, 16 steps) + distill, gpt-4.1 | **N=50** | **0.10** (5/50) |

The deep-agent lever (the "push RL/deep-agent" direction) lifted 0.08 → 0.10 — real
but modest (+1 question), exactly the band open non-RL deep agents reach (~0.10–0.15
per WebSailor/DeepDive). Still ~3× short of Exa's 0.336. Confirms the honest ceiling:
test-time orchestration (distill + decompose-verify + best-of-N) caps ~0.1 on this
flat retrieval substrate; closing to 0.336 needs an RL-trained browsing policy, which
is out of scope for a prompt/orchestration loop.

**Honest conclusion:** the cited orchestration levers (distill, best-of-N) lift a
flat search+LLM pipeline from ~0 to ~0.08 — real but modest. Closing the gap to
0.336 is NOT a prompt/orchestration tweak: the published SOTA at this level comes
from RL-trained browsing policies (DeepResearcher 2504.03160, WebSailor 2507.02592)
and much deeper agentic loops, which this flat pipeline cannot reach. Beating Exa on
BrowseComp needs that class of system, not a better single retrieval call + N samples.

**Harness robustness fixed this session** (load-bearing for any full run): best-of-N
no longer raises on all-rollouts-fail; `_run_task` guards agent+grader independently
so a transient API error scores 0, never crashes a multi-hour eval.

**BLOCKER (2026-06-04): OpenRouter account out of credits** — `total_usage 6950.01`
vs `total_credits 6949.97` (≈$0, overdrawn). Agent+grader request `max_tokens=8192`
→ HTTP 402 "requires more credits". A near-zero balance reports a **false 0.0** (all
grader calls 402 → guarded to score 0). Detect via the per-run error count
(`grep -c 'grader failed|agent failed'` in the eval log) — a high count = INVALID run,
not a real benchmark number. **Resume the moment credits are added** at
[openrouter.ai/settings/credits]; the N=50 then full-1265 runs are the remaining steps.

## Sources (all verified this session)
BrowseComp 2504.12516 · Self-RAG 2310.11511 · Search-o1 2501.05366 · R1-Searcher 2503.05592 · Search-R1 2503.09516 · WebThinker 2504.21776 · DeepResearcher 2504.03160 · WebSailor 2507.02592 · DeepDive 2509.10446 · deep-search test-time scaling 2510.06135 · Exa: latent.space/p/exa, exa.ai/research · Brave Goggles whitepaper 2021 · Tavily docs.tavily.com (no paper).
