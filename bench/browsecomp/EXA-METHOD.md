# How the SOTA actually beats BrowseComp — researched, cited (2026-06-05)

Published BrowseComp (OpenAI's open-web benchmark) accuracies:
- Parallel 58% · GPT-5 (model alone) 53% · Exa 29% · Tavily 23% · Perplexity 22%
  (source: exa.ai/versus/tavily; humai.blog AI-search comparison)
- Component analysis on BrowseComp-Plus (arXiv:2508.06600): Search-R1+BM25 = 3.86%;
  GPT-5 = 55.9%; GPT-5 + Qwen3-Embedding-8B retriever = 70.1%.

## The decisive lever = the AGENT MODEL (not caching, not rollout count)

Model quality dominates by an order of magnitude (3.86% weak → 55.9% GPT-5). A
GPT-5-class agent alone scores ~53% — already past the 0.336 target. The retriever
is the second lever (+14pts from a strong embedding retriever). Caching warms
latency; best-of-N adds ~+10pts (self-consistency). Our setup is capped at ~0.20
mainly because it runs gpt-4.1/Kimi, far weaker agents than GPT-5.

## The honest path to beat 0.336 (no memorization)
1. Swap the agent model to a GPT-5-class model (the dominant lever).
2. Keep our Exa-route deep retrieval (+ optionally a strong embedding re-rank).
3. Add modest best-of-N (self-consistency) on top.
4. Or: call Tavily's /research or Exa's deep-research endpoint directly (23-29%) as
   a baseline floor — they already built the pipeline.
