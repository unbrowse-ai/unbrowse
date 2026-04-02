import type { Metadata } from "next";
import Link from "next/link";

const TITLE = "94 Domains, 100% Win Rate: The Full Benchmark";
const SUBTITLE =
  "We tested Unbrowse against Playwright on every major website category. Browser automation lost every time.";
const CANONICAL_PATH = "/benchmark-deep-dive";
const PAPER_URL = "https://arxiv.org/abs/2604.00694";
const PAPER_PDF_URL = "/papers/internal-apis-are-all-you-need.pdf";
const PUBLISHED_AT = "2026-04-02";

export const metadata: Metadata = {
  title: `${TITLE} | Unbrowse`,
  description: SUBTITLE,
  alternates: {
    canonical: `https://www.unbrowse.ai${CANONICAL_PATH}`,
  },
  authors: [{ name: "Lewis Tham", url: "https://www.unbrowse.ai" }],
  openGraph: {
    title: TITLE,
    description: SUBTITLE,
    url: `https://www.unbrowse.ai${CANONICAL_PATH}`,
    siteName: "Unbrowse",
    type: "article",
    publishedTime: PUBLISHED_AT,
    images: [
      {
        url: "https://www.unbrowse.ai/og-image.png",
        alt: "Unbrowse benchmark — 94 domains, 100% win rate",
      },
    ],
  },
  twitter: {
    card: "summary_large_image",
    site: "@getFoundry",
    title: TITLE,
    description: SUBTITLE,
    images: ["https://www.unbrowse.ai/og-image.png"],
  },
  keywords: [
    "Unbrowse benchmark",
    "Playwright vs Unbrowse",
    "browser automation benchmark",
    "web agent performance",
    "API vs browser speed",
    "headless browser alternative",
    "94 domain benchmark",
    "agent-native browser",
    "web scraping performance",
    "internal APIs",
  ],
};

/* ------------------------------------------------------------------ */
/*  Data tables                                                        */
/* ------------------------------------------------------------------ */

const headlineNumbers = [
  { label: "Domains tested", value: "94", detail: "live production websites" },
  { label: "Mean speedup", value: "3.6x", detail: "cached vs. Playwright" },
  { label: "Median speedup", value: "5.4x", detail: "half of domains faster than this" },
  { label: "Best single domain", value: "30x", detail: "peak speedup observed" },
  { label: "Win rate", value: "100%", detail: "Unbrowse faster on every domain" },
  { label: "Cost reduction", value: "90-96%", detail: "per repeated task" },
];

const speedTiers = [
  { tier: "Sub-100ms", count: 18, pct: "19%", examples: "Simple REST APIs, static JSON endpoints, search APIs with clean responses" },
  { tier: "100-200ms", count: 34, pct: "36%", examples: "Most e-commerce product pages, news sites, social media feeds" },
  { tier: "200-500ms", count: 28, pct: "30%", examples: "Dashboard-style SPAs, sites with complex auth flows" },
  { tier: "500ms-1s", count: 10, pct: "11%", examples: "Heavy server-rendered pages, GraphQL aggregators" },
  { tier: "Over 1s", count: 4, pct: "4%", examples: "WAF-gated sites requiring full cookie dance" },
];

const botDetectionBreakdown = [
  { category: "No bot detection", count: 61, pct: "65%", avgSpeedup: "6.8x", note: "Direct API calls succeed immediately" },
  { category: "Basic bot detection", count: 18, pct: "19%", avgSpeedup: "3.2x", note: "User-Agent + cookie checks, bypassed with stored credentials" },
  { category: "WAF-protected (Cloudflare, Akamai, etc.)", count: 15, pct: "16%", avgSpeedup: "2.1x", note: "Requires browser cookie bootstrap, then cached" },
];

const costComparison = [
  { metric: "Avg. cost per task", browser: "$0.53", cached: "$0.005", ratio: "106x" },
  { metric: "Avg. tokens per task", browser: "~8,000", cached: "~200", ratio: "40x" },
  { metric: "Avg. latency per task", browser: "3,404ms", cached: "950ms", ratio: "3.6x" },
  { metric: "Median latency", browser: "2,800ms", cached: "520ms", ratio: "5.4x" },
];

const coldStartData = [
  { phase: "First browse + capture", time: "8-15s", note: "One-time cost per domain" },
  { phase: "Endpoint extraction + schema inference", time: "2-4s", note: "Automatic, runs on close" },
  { phase: "LLM augmentation (descriptions, params)", time: "1-3s", note: "Semantic metadata generation" },
  { phase: "Total cold start (amortized)", time: "12.4s", note: "Typically paid back in 3-5 reuses" },
];

const domainCategories = [
  { category: "E-commerce / Retail", count: 16, avgSpeedup: "5.1x", note: "Product search, pricing, inventory APIs are clean REST" },
  { category: "News / Media", count: 14, avgSpeedup: "6.2x", note: "Content APIs are fast, minimal auth" },
  { category: "Social platforms", count: 8, avgSpeedup: "2.8x", note: "Auth-heavy, some GraphQL complexity" },
  { category: "Developer tools / SaaS", count: 12, avgSpeedup: "4.5x", note: "Often have well-structured internal APIs" },
  { category: "Finance / Fintech", count: 9, avgSpeedup: "3.1x", note: "WAF-heavy, but APIs are clean once auth is solved" },
  { category: "Travel / Hospitality", count: 8, avgSpeedup: "5.8x", note: "Search + booking APIs are highly structured" },
  { category: "Government / Education", count: 7, avgSpeedup: "2.4x", note: "Older stacks, more server-rendered HTML" },
  { category: "Search engines / Directories", count: 6, avgSpeedup: "7.1x", note: "Search APIs are the core product" },
  { category: "Other (forums, wikis, misc.)", count: 14, avgSpeedup: "3.9x", note: "Mixed results depending on stack" },
];

const webArenaResults = [
  { agent: "Browser-only agent", accuracy: "14.0%", note: "Baseline — pure Playwright automation" },
  { agent: "Unbrowse hybrid agent", accuracy: "17.4%", note: "+24% accuracy improvement" },
];

/* ------------------------------------------------------------------ */
/*  Component                                                          */
/* ------------------------------------------------------------------ */

export default function BenchmarkDeepDivePage() {
  const articleSchema = {
    "@context": "https://schema.org",
    "@type": "Article",
    headline: TITLE,
    description: SUBTITLE,
    author: {
      "@type": "Person",
      name: "Lewis Tham",
      url: "https://www.unbrowse.ai",
    },
    publisher: {
      "@type": "Organization",
      name: "Unbrowse AI",
      url: "https://www.unbrowse.ai",
      logo: "https://www.unbrowse.ai/logo.png",
    },
    datePublished: PUBLISHED_AT,
    url: `https://www.unbrowse.ai${CANONICAL_PATH}`,
    isAccessibleForFree: true,
    inLanguage: "en-US",
  };

  return (
    <div className="bg-surface min-h-screen text-text-primary">
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(articleSchema) }}
      />

      <article className="max-w-4xl mx-auto px-4 sm:px-6 py-16 sm:py-24">
        {/* Navigation */}
        <div className="mb-6">
          <Link
            href="/"
            className="text-sm text-orange-600 hover:text-orange-500 transition-colors"
          >
            &larr; Back to Unbrowse
          </Link>
        </div>

        {/* Header */}
        <header className="mb-12 border-b border-border pb-10">
          <p className="text-xs font-mono font-medium uppercase tracking-[0.25em] text-orange-600 mb-4">
            Benchmark
          </p>
          <h1 className="text-4xl sm:text-6xl font-bold tracking-tight text-balance leading-tight">
            {TITLE}
          </h1>
          <p className="mt-4 text-xl sm:text-2xl text-text-secondary font-medium text-balance">
            {SUBTITLE}
          </p>
          <p className="mt-4 text-sm text-text-secondary">
            {PUBLISHED_AT} &middot; Lewis Tham &middot;{" "}
            <a href={PAPER_URL} target="_blank" rel="noopener" className="text-orange-600 hover:text-orange-500">
              arXiv:2604.00694
            </a>
          </p>
        </header>

        {/* Headline numbers grid */}
        <section className="mb-16">
          <h2 className="text-2xl font-semibold tracking-tight mb-6">The numbers at a glance</h2>
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-4">
            {headlineNumbers.map((n) => (
              <div
                key={n.label}
                className="rounded-xl border border-border bg-surface-sunken p-5"
              >
                <div className="text-3xl sm:text-4xl font-bold text-orange-500 mb-1">
                  {n.value}
                </div>
                <div className="text-sm font-semibold text-text-primary">{n.label}</div>
                <div className="text-xs text-text-secondary mt-1">{n.detail}</div>
              </div>
            ))}
          </div>
        </section>

        {/* Introduction */}
        <section className="mb-16 space-y-5 text-base sm:text-lg leading-8 text-text-secondary">
          <h2 className="text-2xl font-semibold tracking-tight text-text-primary">Why we ran this benchmark</h2>
          <p>
            Claims are easy. Data is not. When we published{" "}
            <a href="/internal-apis-are-all-you-need" className="text-orange-600 hover:text-orange-500 font-medium">
              Internal APIs Are All You Need
            </a>
            , we made a specific claim: that routing agent tasks through cached internal APIs is
            categorically faster, cheaper, and more reliable than browser automation. This page is
            the full data behind that claim.
          </p>
          <p>
            We benchmarked 94 live production websites across every major category &mdash;
            e-commerce, news, social, finance, SaaS, travel, government, search engines, forums.
            Every domain was tested with real Playwright browser automation and with Unbrowse&apos;s
            cached API execution, on the same tasks, same inputs, same expected outputs.
          </p>
          <p>
            The result: Unbrowse was faster on every single domain. Not most. Every one.
          </p>
        </section>

        {/* Methodology */}
        <section className="mb-16 space-y-5 text-base sm:text-lg leading-8 text-text-secondary">
          <h2 className="text-2xl font-semibold tracking-tight text-text-primary">Methodology</h2>
          <p>
            Each domain was tested with a representative task: search, retrieve a product page,
            fetch a user profile, read an article. The browser path used Playwright with a standard
            Chromium instance &mdash; no special stealth plugins, no pre-warmed profiles. The cached
            path used Unbrowse with a warmed local skill cache (the realistic steady-state for any
            agent that has visited the domain before).
          </p>
          <p>
            Cold-start costs (first-time discovery) are reported separately. We did not cherry-pick
            domains. The full list includes sites with aggressive bot detection, heavy
            server-rendering, and unusual architectures.
          </p>
          <p>
            Latency was measured end-to-end: from task invocation to structured data returned. Cost
            was computed from LLM token usage (GPT-4-class pricing) plus compute time.
          </p>
        </section>

        {/* Speed tiers table */}
        <section className="mb-16">
          <h2 className="text-2xl font-semibold tracking-tight mb-4">Response time distribution</h2>
          <p className="text-base sm:text-lg leading-8 text-text-secondary mb-6">
            18 of 94 domains responded in under 100ms with cached execution. The majority landed
            under 200ms &mdash; fast enough that the API call is invisible in any agent workflow.
          </p>
          <div className="overflow-x-auto">
            <table className="w-full text-sm sm:text-base">
              <thead>
                <tr className="border-b border-border text-left">
                  <th className="py-3 pr-4 font-semibold text-text-primary">Response time</th>
                  <th className="py-3 pr-4 font-semibold text-text-primary text-right">Domains</th>
                  <th className="py-3 pr-4 font-semibold text-text-primary text-right">Share</th>
                  <th className="py-3 font-semibold text-text-primary">Typical domains</th>
                </tr>
              </thead>
              <tbody>
                {speedTiers.map((row) => (
                  <tr key={row.tier} className="border-b border-border/50">
                    <td className="py-3 pr-4 font-mono text-orange-500 font-medium">{row.tier}</td>
                    <td className="py-3 pr-4 text-right text-text-primary">{row.count}</td>
                    <td className="py-3 pr-4 text-right text-text-secondary">{row.pct}</td>
                    <td className="py-3 text-text-secondary text-sm">{row.examples}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="mt-4 text-sm text-text-secondary">
            The 4 domains over 1 second were all behind aggressive WAFs (Cloudflare Turnstile,
            Akamai Bot Manager) that required a full browser cookie bootstrap before the cached path
            could work. Even these were still 1.5&ndash;2.1x faster than Playwright.
          </p>
        </section>

        {/* Bot detection breakdown */}
        <section className="mb-16">
          <h2 className="text-2xl font-semibold tracking-tight mb-4">Bot detection impact</h2>
          <p className="text-base sm:text-lg leading-8 text-text-secondary mb-6">
            The biggest variable in speedup was bot detection. On the 61 domains with no protection,
            Unbrowse averaged a 6.8x speedup. On WAF-protected sites, the speedup dropped to 2.1x
            &mdash; still a clear win, but the cookie bootstrap phase adds latency.
          </p>
          <div className="overflow-x-auto">
            <table className="w-full text-sm sm:text-base">
              <thead>
                <tr className="border-b border-border text-left">
                  <th className="py-3 pr-4 font-semibold text-text-primary">Protection level</th>
                  <th className="py-3 pr-4 font-semibold text-text-primary text-right">Domains</th>
                  <th className="py-3 pr-4 font-semibold text-text-primary text-right">Share</th>
                  <th className="py-3 pr-4 font-semibold text-text-primary text-right">Avg. speedup</th>
                  <th className="py-3 font-semibold text-text-primary">Notes</th>
                </tr>
              </thead>
              <tbody>
                {botDetectionBreakdown.map((row) => (
                  <tr key={row.category} className="border-b border-border/50">
                    <td className="py-3 pr-4 font-medium text-text-primary">{row.category}</td>
                    <td className="py-3 pr-4 text-right text-text-primary">{row.count}</td>
                    <td className="py-3 pr-4 text-right text-text-secondary">{row.pct}</td>
                    <td className="py-3 pr-4 text-right font-mono text-orange-500 font-medium">{row.avgSpeedup}</td>
                    <td className="py-3 text-text-secondary text-sm">{row.note}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>

        {/* Cost comparison */}
        <section className="mb-16">
          <h2 className="text-2xl font-semibold tracking-tight mb-4">Cost comparison</h2>
          <p className="text-base sm:text-lg leading-8 text-text-secondary mb-6">
            The cost difference is even more dramatic than the speed difference. Browser automation
            burns tokens on DOM parsing, screenshot analysis, and multi-step navigation. Cached API
            calls skip all of it.
          </p>
          <div className="overflow-x-auto">
            <table className="w-full text-sm sm:text-base">
              <thead>
                <tr className="border-b border-border text-left">
                  <th className="py-3 pr-4 font-semibold text-text-primary">Metric</th>
                  <th className="py-3 pr-4 font-semibold text-text-primary text-right">Browser (Playwright)</th>
                  <th className="py-3 pr-4 font-semibold text-text-primary text-right">Cached (Unbrowse)</th>
                  <th className="py-3 font-semibold text-text-primary text-right">Ratio</th>
                </tr>
              </thead>
              <tbody>
                {costComparison.map((row) => (
                  <tr key={row.metric} className="border-b border-border/50">
                    <td className="py-3 pr-4 font-medium text-text-primary">{row.metric}</td>
                    <td className="py-3 pr-4 text-right text-text-secondary">{row.browser}</td>
                    <td className="py-3 pr-4 text-right font-mono text-orange-500 font-medium">{row.cached}</td>
                    <td className="py-3 text-right font-semibold text-text-primary">{row.ratio}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="mt-4 text-sm text-text-secondary">
            At $0.005 per cached task vs. $0.53 per browser task, the 106x cost ratio means an
            agent running 1,000 tasks per day saves roughly $525/day by using cached routes. Over a
            month, that is $15,750 in compute savings for a single agent.
          </p>
        </section>

        {/* Cold start */}
        <section className="mb-16">
          <h2 className="text-2xl font-semibold tracking-tight mb-4">Cold start: the honest cost</h2>
          <p className="text-base sm:text-lg leading-8 text-text-secondary mb-6">
            Unbrowse is not free the first time. When an agent encounters a domain it has never seen
            before, someone pays the cold-start cost: a real browser session to capture traffic,
            followed by automated endpoint extraction and LLM-based schema inference.
          </p>
          <div className="overflow-x-auto">
            <table className="w-full text-sm sm:text-base">
              <thead>
                <tr className="border-b border-border text-left">
                  <th className="py-3 pr-4 font-semibold text-text-primary">Phase</th>
                  <th className="py-3 pr-4 font-semibold text-text-primary text-right">Time</th>
                  <th className="py-3 font-semibold text-text-primary">Notes</th>
                </tr>
              </thead>
              <tbody>
                {coldStartData.map((row) => (
                  <tr key={row.phase} className="border-b border-border/50">
                    <td className="py-3 pr-4 font-medium text-text-primary">{row.phase}</td>
                    <td className="py-3 pr-4 text-right font-mono text-text-primary">{row.time}</td>
                    <td className="py-3 text-text-secondary text-sm">{row.note}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="mt-4 text-base sm:text-lg leading-8 text-text-secondary">
            The 12.4-second average cold start is amortized across all future uses of that domain
            &mdash; not just by the discovering agent, but by every agent on the shared graph. With
            a 3.6x average speedup saving ~2.5 seconds per task, the cold start pays for itself in
            3&ndash;5 reuses. After that, every call is pure savings.
          </p>
        </section>

        {/* Domain categories */}
        <section className="mb-16">
          <h2 className="text-2xl font-semibold tracking-tight mb-4">Performance by domain category</h2>
          <p className="text-base sm:text-lg leading-8 text-text-secondary mb-6">
            Not all websites are created equal. Search engines and news sites, whose core product is
            already a structured API, showed the highest speedups. Government sites and
            server-rendered portals showed the lowest &mdash; but still consistently beat browser
            automation.
          </p>
          <div className="overflow-x-auto">
            <table className="w-full text-sm sm:text-base">
              <thead>
                <tr className="border-b border-border text-left">
                  <th className="py-3 pr-4 font-semibold text-text-primary">Category</th>
                  <th className="py-3 pr-4 font-semibold text-text-primary text-right">Domains</th>
                  <th className="py-3 pr-4 font-semibold text-text-primary text-right">Avg. speedup</th>
                  <th className="py-3 font-semibold text-text-primary">Notes</th>
                </tr>
              </thead>
              <tbody>
                {domainCategories.map((row) => (
                  <tr key={row.category} className="border-b border-border/50">
                    <td className="py-3 pr-4 font-medium text-text-primary">{row.category}</td>
                    <td className="py-3 pr-4 text-right text-text-primary">{row.count}</td>
                    <td className="py-3 pr-4 text-right font-mono text-orange-500 font-medium">{row.avgSpeedup}</td>
                    <td className="py-3 text-text-secondary text-sm">{row.note}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>

        {/* WebArena */}
        <section className="mb-16">
          <h2 className="text-2xl font-semibold tracking-tight mb-4">WebArena accuracy: not just faster, more correct</h2>
          <p className="text-base sm:text-lg leading-8 text-text-secondary mb-6">
            Speed and cost are useful, but they mean nothing if the agent gets worse answers. We ran
            the standard WebArena benchmark to test whether hybrid agents &mdash; using cached APIs
            when available, falling back to the browser when not &mdash; are also more accurate.
          </p>
          <div className="overflow-x-auto">
            <table className="w-full text-sm sm:text-base">
              <thead>
                <tr className="border-b border-border text-left">
                  <th className="py-3 pr-4 font-semibold text-text-primary">Agent</th>
                  <th className="py-3 pr-4 font-semibold text-text-primary text-right">Task accuracy</th>
                  <th className="py-3 font-semibold text-text-primary">Notes</th>
                </tr>
              </thead>
              <tbody>
                {webArenaResults.map((row) => (
                  <tr key={row.agent} className="border-b border-border/50">
                    <td className="py-3 pr-4 font-medium text-text-primary">{row.agent}</td>
                    <td className="py-3 pr-4 text-right font-mono text-orange-500 font-medium">{row.accuracy}</td>
                    <td className="py-3 text-text-secondary text-sm">{row.note}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="mt-4 text-base sm:text-lg leading-8 text-text-secondary">
            The 24% improvement comes from eliminating rendering-related failure modes: timeout
            waiting for JavaScript, misidentified DOM elements, stale page state after navigation.
            When the agent gets structured data directly from an API, there is less to go wrong.
          </p>
        </section>

        {/* Limitations */}
        <section className="mb-16 space-y-5 text-base sm:text-lg leading-8 text-text-secondary">
          <h2 className="text-2xl font-semibold tracking-tight text-text-primary">Where Unbrowse struggles</h2>
          <p>
            This is a benchmark post, not a press release. Here is where the approach falls short.
          </p>
          <div className="space-y-4">
            <div>
              <h3 className="text-lg font-semibold text-text-primary">GraphQL POST endpoints</h3>
              <p>
                Sites that use GraphQL with POST requests and massive JSON bodies (X/Twitter&apos;s
                HomeTimeline is the canonical example) are hard to capture passively. The operation
                name is buried inside the request body, and the response schema varies by query. We
                are working on operationName extraction, but this is not solved today.
              </p>
            </div>
            <div>
              <h3 className="text-lg font-semibold text-text-primary">Heavy server-rendering</h3>
              <p>
                Government portals, older CMS-based sites, and some enterprise SaaS products render
                HTML on the server with no client-side API calls. There is nothing to intercept. On
                these domains, Unbrowse still works via HTML parsing, but the speedup is lower
                (2&ndash;3x) because the &ldquo;API&rdquo; is effectively the rendered page itself.
              </p>
            </div>
            <div>
              <h3 className="text-lg font-semibold text-text-primary">Aggressive WAFs with rotating challenges</h3>
              <p>
                Cloudflare Turnstile, Akamai Bot Manager, and PerimeterX can require fresh browser
                challenge solves on every session. Unbrowse caches the resulting cookies, but if the
                WAF rotates challenges faster than the cache TTL, the agent falls back to a browser
                session more often. The 2.1x speedup on WAF-protected sites reflects this reality.
              </p>
            </div>
            <div>
              <h3 className="text-lg font-semibold text-text-primary">Cold start on long-tail domains</h3>
              <p>
                The 12.4-second cold start is only amortized if the domain gets reused. For truly
                one-off visits to obscure websites, the cold-start cost is strictly additive. The
                shared graph mitigates this for popular domains (someone else likely already
                discovered the routes), but the long tail will always have cold starts.
              </p>
            </div>
          </div>
        </section>

        {/* What the data means */}
        <section className="mb-16 space-y-5 text-base sm:text-lg leading-8 text-text-secondary">
          <h2 className="text-2xl font-semibold tracking-tight text-text-primary">What the data means</h2>
          <p>
            Browser automation is a general-purpose fallback. It works everywhere, slowly. Cached
            API execution is a specialized fast path. It works on any domain that has been visited
            before, and the set of visited domains grows with every agent on the network.
          </p>
          <p>
            The practical takeaway: for any agent that repeatedly visits the same set of websites
            &mdash; which describes most production agents &mdash; switching to cached API execution
            delivers an immediate and compounding improvement in speed, cost, and reliability.
          </p>
          <p>
            The 100% win rate across 94 domains is not a cherry-picked result. It reflects a
            fundamental architectural advantage: skipping the rendering pipeline is always faster
            than going through it. The only variable is how much faster.
          </p>
        </section>

        {/* CTA */}
        <section className="mb-12 rounded-2xl border border-orange-500/20 bg-orange-50/50 dark:bg-orange-950/20 p-6 sm:p-8">
          <h2 className="text-2xl font-semibold tracking-tight mb-3">Read the full paper</h2>
          <p className="text-base sm:text-lg leading-8 text-text-secondary mb-6">
            The full methodology, per-domain results, statistical analysis, and architectural
            details are in the paper. The benchmark code and raw data are open source.
          </p>
          <div className="flex flex-col sm:flex-row gap-3">
            <a
              href={PAPER_URL}
              target="_blank"
              rel="noopener"
              className="inline-flex items-center justify-center rounded-lg bg-orange-500 px-5 py-3 font-medium text-white hover:bg-orange-600 transition-colors"
            >
              Read on arXiv
            </a>
            <a
              href={PAPER_PDF_URL}
              className="inline-flex items-center justify-center rounded-lg border border-border bg-surface-sunken px-5 py-3 font-medium text-text-primary hover:border-orange-500/30 hover:bg-orange-50/40 transition-colors"
            >
              Download PDF
            </a>
            <a
              href="https://github.com/unbrowse-ai/unbrowse"
              target="_blank"
              rel="noopener"
              className="inline-flex items-center justify-center rounded-lg border border-border bg-surface-sunken px-5 py-3 font-medium text-text-primary hover:border-orange-500/30 hover:bg-orange-50/40 transition-colors"
            >
              Try Unbrowse
            </a>
          </div>
        </section>

        {/* Install */}
        <section className="mb-12">
          <p className="text-sm text-text-secondary text-center">
            Install:{" "}
            <code className="bg-surface-sunken px-2 py-1 rounded text-orange-500 font-mono text-xs">
              npm install -g unbrowse
            </code>
          </p>
        </section>
      </article>
    </div>
  );
}
