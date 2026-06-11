# Exa webcode-RAG: our-own-pipeline rewire + lever investigation (2026-06-11)

Grader: OpenRouter `gpt-5.4-mini` (held fixed). RAG reader: `gpt-4o-mini` unless noted.
Dataset: `bench/exa/vendor/benchmarks/webcode-benchmark/data/rag/code_rag.jsonl` (307 queries; runs at n=30).
All numbers from real graded runs via the repo CLI (`unbrowse` = live source wrapper).

## What shipped (witnessed)

1. **Searcher runs unbrowse's OWN pipeline, zero exa / zero DuckDuckGo.**
   `search(query)` seeds the dataset `source_url` into `unbrowse search --intent <q> --url <url>`,
   so the orchestrator's `direct-document` path serves the page (beats exa) and the background
   capture pipeline indexes endpoints in during the run. Any `source==exa` envelope is dropped to
   honest-empty. (`shared/shared/searchers/unbrowse.py`)
2. **Extraction cap made env-configurable.** `direct-document.ts` markdown/excerpt budget was a hard
   12k chars (silently erased deep passages in 800KB+ specs). Now `UNBROWSE_MARKDOWN_BUDGET`
   (default 12k unchanged for agents; bench raises to 200k). Verified: full 190k-char page extracted.
3. **direct-document fetch ladder uses curl-impersonate.** The curl fallback used plain
   `curl -A unbrowse/1.0` and got 403'd by anti-bot hosts. Now: impersonate-direct (chrome131 JA4)
   then impersonate-via-proxy escalation. Verified in isolation: docs.redhat.com (403 -> recovered),
   262.ecma-international (recovered), gnu.org (via IPRoyal proxy -> recovered).
4. **Hybrid RRF tight-chunk retrieval** (`UNBROWSE_RETRIEVAL=hybrid|lexical|window`): chunk the page
   ~1200 chars, rank by RRF of rare-term lexical + Nebius `Qwen3-Embedding-8B` cosine, return top-4.
   Disciplines: batched embeds, failed-embedding-ranks-last, normalized url cache.

## The honest headline: groundedness is PINNED at 0.2667 across every lever

| run (n=30) | groundedness | correctness | served | grounded\|served |
|---|---|---|---|---|
| window (control) | 0.2667 | 0.2000 | 22/30 | 0.364 |
| hybrid chunks | 0.2667 | 0.2667 | 22/30 | 0.364 |
| reader = Claude Sonnet 4.6 | 0.2667 | 0.2667 | 23/30 | 0.348 |
| blanket proxy | 0.2333 | 0.2333 | 23/30 | 0.304 |
| direct->proxy ladder | 0.2667 | 0.2667 | 23/30 | 0.348 |
| ladder + budget 40s | 0.2667 | 0.2667 | 23/30 | 0.348 |

Six graded n=30 runs; every lever moved groundedness by <= the noise margin (0.05). Honest negatives.

## Why each lever was flat (the diagnosis)

- **Chunking flat:** `groundedness` is judged on the citations the agent passes, and `SimpleRAGAgent`
  passes ALL our returned chunks verbatim. So groundedness == retrieval recall over our citations,
  not synthesis quality. Tighter chunks put the answer in the passage more often (unit 3/5 -> 4/5)
  but did not move the graded metric.
- **Reader-model flat:** groundedness is reader-INDEPENDENT by construction (citations are our chunks,
  not the model's output). Only `correctness` depends on the reader (it ticked +0.067 both times).
- **Blanket proxy negative:** routing every fetch through the residential proxy recovered gnu.org but
  taxed the fast hosts with latency -> some timed out. Net wash/negative. Validates per-domain marking:
  proxy ONLY the hosts that need it.
- **Ladder + budget flat:** the fetch ladder recovers throttled hosts in ISOLATION, but through
  `unbrowse search` the resolve **budget race abandons no-probe-winner hosts to exa before the
  direct-document ladder fires**. The probe egresses DIRECT (no proxy), so gnu.org's probe times out,
  yields no winner, and the whole probe/direct-document section is skipped. redhat (probe 403s fast)
  recovers; gnu.org (probe times out) does not.

## Recall ceiling vs exa

- `gold-in-full-page` (substring lower bound) = **15/30 (50%)**; graded groundedness = 8/30 (0.267).
- Exa publishes ~0.79 on the SAME source_urls -> the gold IS in those pages; our ~50% is lost to
  (a) availability empties (8-10/30 guaranteed 0), (b) extraction completeness, (c) substring-undercount
  (the grader credits paraphrase our check does not).
- Exa's edge = crawl-cache (never live-fetches at query time -> no timeouts/blocks/races) + semantic
  chunk retrieval. Our "index-in-the-process" flywheel is the analog but is not yet a query-time cache.

## The one root-cause fix with headroom (scoped, NOT yet done)

Availability is the only lever with real headroom (8-10 empties + the 8->15 recall gap), but the fix is
resolve-path control-flow surgery, not an incremental tweak:

- In `orchestrator/index.ts` resolve race: when a seeded content URL is present and the race yields
  **no probe winner**, attempt the (now proxy-capable) `fetchDirectDocument` ladder in the no-winner
  branch BEFORE exa. Equivalent: make the probe phase proxy-capable so throttled hosts win their probe.
- Pair with the per-domain fetch-strategy mark on `domainSkillCache` (KV+TTL): record the winning rung
  (direct/impersonate/proxy) so the walk starts there and proxies ONLY the hosts that need it (avoids
  the blanket-proxy tax that regressed this run).

Two eager-insert attempts this session were misplaced (gated behind a probe winner) and reverted to keep
the change-set witnessed. The fix needs a focused read of the no-winner branch.

## Verdict

The rewire is done and honest: the bench runs unbrowse's own pipeline, no exa, indexes in. But on THIS
grader/dataset, groundedness is pinned at 0.2667 and none of chunking, reader-model, or blanket/ladder
proxy moved it. The bottleneck is availability (resolve-race abandons throttled hosts) plus extraction
recall, and closing it requires the scoped resolve-path fix above, not more reader/retrieval tweaks.
Do not claim a win against exa's 0.79; that gap is real and named.

## Update — availability fix witnessed (jesus-ralph gate green)

The resolve serial-path rescue (`curlRescueDirect`) used `forceDirect:true`, so anti-bot
hosts that 403 plain curl were never retried with impersonation/proxy and got dropped to exa.
Fixes (witnessed):
- `direct-document` curl fallback now ladders: impersonate-DIRECT (chrome131 JA4) -> impersonate-
  via-PROXY (resolveEgressProxy, 45s headroom). `curlRescueDirect` ladders the same way.
- Witness `bench/exa/gate_availability.sh` exits 0: docs.redhat.com (403 -> served by
  direct-document, 200k md, deterministic, no proxy) AND a healthy control still served.

Honest scope: redhat-class (anti-bot 403) empties recover RELIABLY via impersonation. IP-throttled
hosts (gnu.org) recover via the proxy rung but residential-proxy latency on multi-MB manuals is
variable (5s..>45s) — shipped best-effort, NOT gated (gating external proxy variance = green-by-luck).
Per-domain fetch-strategy marking on `domainSkillCache` (start at the known-good rung, skip dead
edges) remains the next optimization so throttled hosts skip the wasted direct rungs.
