# 94 Domains, 100% Win Rate: The Full Benchmark

*We tested Unbrowse against Playwright on every major website category. Browser automation lost every time.*

---

**Published:** 2026-04-02 | **Author:** Lewis Tham | **Paper:** [arXiv:2604.00694](https://arxiv.org/abs/2604.00694)

---

## The numbers at a glance

| Metric | Value |
|--------|-------|
| Domains tested | 94 live production websites |
| Mean speedup | 3.6x (cached vs. Playwright) |
| Median speedup | 5.4x |
| Best single domain | 30x |
| Win rate | 100% — Unbrowse faster on every domain |
| Cost reduction | 90-96% per repeated task |

## Why we ran this benchmark

Claims are easy. Data is not. When we published [Internal APIs Are All You Need](https://www.unbrowse.ai/internal-apis-are-all-you-need), we made a specific claim: that routing agent tasks through cached internal APIs is categorically faster, cheaper, and more reliable than browser automation. This page is the full data behind that claim.

We benchmarked 94 live production websites across every major category — e-commerce, news, social, finance, SaaS, travel, government, search engines, forums. Every domain was tested with real Playwright browser automation and with Unbrowse's cached API execution, on the same tasks, same inputs, same expected outputs.

The result: Unbrowse was faster on every single domain. Not most. Every one.

## Methodology

Each domain was tested with a representative task: search, retrieve a product page, fetch a user profile, read an article. The browser path used Playwright with a standard Chromium instance — no special stealth plugins, no pre-warmed profiles. The cached path used Unbrowse with a warmed local skill cache (the realistic steady-state for any agent that has visited the domain before).

Cold-start costs (first-time discovery) are reported separately. We did not cherry-pick domains. The full list includes sites with aggressive bot detection, heavy server-rendering, and unusual architectures.

Latency was measured end-to-end: from task invocation to structured data returned. Cost was computed from LLM token usage (GPT-4-class pricing) plus compute time.

## Response time distribution

18 of 94 domains responded in under 100ms with cached execution. The majority landed under 200ms — fast enough that the API call is invisible in any agent workflow.

| Response time | Domains | Share | Typical domains |
|--------------|---------|-------|-----------------|
| Sub-100ms | 18 | 19% | Simple REST APIs, static JSON endpoints, search APIs with clean responses |
| 100-200ms | 34 | 36% | Most e-commerce product pages, news sites, social media feeds |
| 200-500ms | 28 | 30% | Dashboard-style SPAs, sites with complex auth flows |
| 500ms-1s | 10 | 11% | Heavy server-rendered pages, GraphQL aggregators |
| Over 1s | 4 | 4% | WAF-gated sites requiring full cookie dance |

The 4 domains over 1 second were all behind aggressive WAFs (Cloudflare Turnstile, Akamai Bot Manager) that required a full browser cookie bootstrap before the cached path could work. Even these were still 1.5-2.1x faster than Playwright.

## Bot detection impact

The biggest variable in speedup was bot detection. On the 61 domains with no protection, Unbrowse averaged a 6.8x speedup. On WAF-protected sites, the speedup dropped to 2.1x — still a clear win, but the cookie bootstrap phase adds latency.

| Protection level | Domains | Share | Avg. speedup | Notes |
|-----------------|---------|-------|-------------|-------|
| No bot detection | 61 | 65% | 6.8x | Direct API calls succeed immediately |
| Basic bot detection | 18 | 19% | 3.2x | User-Agent + cookie checks, bypassed with stored credentials |
| WAF-protected (Cloudflare, Akamai, etc.) | 15 | 16% | 2.1x | Requires browser cookie bootstrap, then cached |

## Cost comparison

The cost difference is even more dramatic than the speed difference. Browser automation burns tokens on DOM parsing, screenshot analysis, and multi-step navigation. Cached API calls skip all of it.

| Metric | Browser (Playwright) | Cached (Unbrowse) | Ratio |
|--------|---------------------|-------------------|-------|
| Avg. cost per task | $0.53 | $0.005 | 106x |
| Avg. tokens per task | ~8,000 | ~200 | 40x |
| Avg. latency per task | 3,404ms | 950ms | 3.6x |
| Median latency | 2,800ms | 520ms | 5.4x |

At $0.005 per cached task vs. $0.53 per browser task, the 106x cost ratio means an agent running 1,000 tasks per day saves roughly $525/day by using cached routes. Over a month, that is $15,750 in compute savings for a single agent.

## Cold start: the honest cost

Unbrowse is not free the first time. When an agent encounters a domain it has never seen before, someone pays the cold-start cost: a real browser session to capture traffic, followed by automated endpoint extraction and LLM-based schema inference.

| Phase | Time | Notes |
|-------|------|-------|
| First browse + capture | 8-15s | One-time cost per domain |
| Endpoint extraction + schema inference | 2-4s | Automatic, runs on close |
| LLM augmentation (descriptions, params) | 1-3s | Semantic metadata generation |
| Total cold start (amortized) | 12.4s | Typically paid back in 3-5 reuses |

The 12.4-second average cold start is amortized across all future uses of that domain — not just by the discovering agent, but by every agent on the shared graph. With a 3.6x average speedup saving ~2.5 seconds per task, the cold start pays for itself in 3-5 reuses. After that, every call is pure savings.

## Performance by domain category

Not all websites are created equal. Search engines and news sites, whose core product is already a structured API, showed the highest speedups. Government sites and server-rendered portals showed the lowest — but still consistently beat browser automation.

| Category | Domains | Avg. speedup | Notes |
|----------|---------|-------------|-------|
| E-commerce / Retail | 16 | 5.1x | Product search, pricing, inventory APIs are clean REST |
| News / Media | 14 | 6.2x | Content APIs are fast, minimal auth |
| Social platforms | 8 | 2.8x | Auth-heavy, some GraphQL complexity |
| Developer tools / SaaS | 12 | 4.5x | Often have well-structured internal APIs |
| Finance / Fintech | 9 | 3.1x | WAF-heavy, but APIs are clean once auth is solved |
| Travel / Hospitality | 8 | 5.8x | Search + booking APIs are highly structured |
| Government / Education | 7 | 2.4x | Older stacks, more server-rendered HTML |
| Search engines / Directories | 6 | 7.1x | Search APIs are the core product |
| Other (forums, wikis, misc.) | 14 | 3.9x | Mixed results depending on stack |

## WebArena accuracy: not just faster, more correct

Speed and cost are useful, but they mean nothing if the agent gets worse answers. We ran the standard WebArena benchmark to test whether hybrid agents — using cached APIs when available, falling back to the browser when not — are also more accurate.

| Agent | Task accuracy | Notes |
|-------|-------------|-------|
| Browser-only agent | 14.0% | Baseline — pure Playwright automation |
| Unbrowse hybrid agent | 17.4% | +24% accuracy improvement |

The 24% improvement comes from eliminating rendering-related failure modes: timeout waiting for JavaScript, misidentified DOM elements, stale page state after navigation. When the agent gets structured data directly from an API, there is less to go wrong.

## Where Unbrowse struggles

This is a benchmark post, not a press release. Here is where the approach falls short.

### GraphQL POST endpoints

Sites that use GraphQL with POST requests and massive JSON bodies (X/Twitter's HomeTimeline is the canonical example) are hard to capture passively. The operation name is buried inside the request body, and the response schema varies by query. We are working on operationName extraction, but this is not solved today.

### Heavy server-rendering

Government portals, older CMS-based sites, and some enterprise SaaS products render HTML on the server with no client-side API calls. There is nothing to intercept. On these domains, Unbrowse still works via HTML parsing, but the speedup is lower (2-3x) because the "API" is effectively the rendered page itself.

### Aggressive WAFs with rotating challenges

Cloudflare Turnstile, Akamai Bot Manager, and PerimeterX can require fresh browser challenge solves on every session. Unbrowse caches the resulting cookies, but if the WAF rotates challenges faster than the cache TTL, the agent falls back to a browser session more often. The 2.1x speedup on WAF-protected sites reflects this reality.

### Cold start on long-tail domains

The 12.4-second cold start is only amortized if the domain gets reused. For truly one-off visits to obscure websites, the cold-start cost is strictly additive. The shared graph mitigates this for popular domains (someone else likely already discovered the routes), but the long tail will always have cold starts.

## What the data means

Browser automation is a general-purpose fallback. It works everywhere, slowly. Cached API execution is a specialized fast path. It works on any domain that has been visited before, and the set of visited domains grows with every agent on the network.

The practical takeaway: for any agent that repeatedly visits the same set of websites — which describes most production agents — switching to cached API execution delivers an immediate and compounding improvement in speed, cost, and reliability.

The 100% win rate across 94 domains is not a cherry-picked result. It reflects a fundamental architectural advantage: skipping the rendering pipeline is always faster than going through it. The only variable is how much faster.

## Read the full paper

The full methodology, per-domain results, statistical analysis, and architectural details are in the paper. The benchmark code and raw data are open source.

- [Read on arXiv](https://arxiv.org/abs/2604.00694)
- [Download PDF](https://www.unbrowse.ai/papers/internal-apis-are-all-you-need.pdf)
- [Try Unbrowse](https://github.com/unbrowse-ai/unbrowse)

---

Install: `npm install -g unbrowse`
