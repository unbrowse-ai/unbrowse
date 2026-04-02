import type { Metadata } from "next";
import Link from "next/link";

const TITLE = "Browser Automation Is Dead. Here's What Replaces It.";
const SUBTITLE = "We built machines that cosplay as humans to talk to machines. It was always going to end badly.";
const CANONICAL_PATH = "/browser-automation-is-dead";
const PUBLISHED_AT = "2026-04-02";
const ARXIV_URL = "https://arxiv.org/abs/2604.00694";

const description = `Every AI agent web action pays a hidden $0.53 tax -- the cost of launching a browser, rendering pixels, and converting structured data back into structured data. Across 94 domains, direct API calls achieved 3.6x mean speedup, 106x cost reduction, and eliminated 500 MB RAM per instance. Browser automation for AI agents is architecturally wrong. Internal APIs replace it.`;

export const metadata: Metadata = {
  title: `${TITLE} | Unbrowse`,
  description,
  alternates: {
    canonical: `https://www.unbrowse.ai${CANONICAL_PATH}`,
  },
  authors: [{ name: "Lewis Tham", url: "https://x.com/getFoundry" }],
  openGraph: {
    title: TITLE,
    description,
    url: `https://www.unbrowse.ai${CANONICAL_PATH}`,
    siteName: "Unbrowse",
    type: "article",
    publishedTime: PUBLISHED_AT,
    images: [
      {
        url: "https://www.unbrowse.ai/og-image.png",
        width: 1200,
        height: 630,
        alt: "Browser Automation Is Dead -- Unbrowse",
      },
    ],
  },
  twitter: {
    card: "summary_large_image",
    site: "@getFoundry",
    title: TITLE,
    description,
    images: ["https://www.unbrowse.ai/og-image.png"],
  },
  keywords: [
    "browser automation",
    "Playwright alternative",
    "Puppeteer alternative",
    "AI agent browser",
    "web agent API",
    "headless browser replacement",
    "internal APIs",
    "Unbrowse",
    "agentic web",
    "browser automation cost",
    "agent-native browser",
  ],
};

export default function BrowserAutomationIsDeadPage() {
  const blogPosting = {
    "@context": "https://schema.org",
    "@type": "BlogPosting",
    headline: TITLE,
    description,
    author: {
      "@type": "Person",
      name: "Lewis Tham",
      url: "https://x.com/getFoundry",
    },
    publisher: {
      "@type": "Organization",
      name: "Unbrowse AI",
      url: "https://www.unbrowse.ai",
      logo: "https://www.unbrowse.ai/logo.png",
    },
    datePublished: PUBLISHED_AT,
    url: `https://www.unbrowse.ai${CANONICAL_PATH}`,
    mainEntityOfPage: `https://www.unbrowse.ai${CANONICAL_PATH}`,
    keywords: metadata.keywords,
    isAccessibleForFree: true,
    inLanguage: "en-US",
  };

  return (
    <div className="bg-surface min-h-screen text-text-primary">
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(blogPosting) }}
      />

      <article className="max-w-4xl mx-auto px-4 sm:px-6 py-16 sm:py-24">
        <div className="mb-6">
          <Link
            href="/"
            className="text-sm text-orange-600 hover:text-orange-500 transition-colors"
          >
            &larr; Back to Unbrowse
          </Link>
        </div>

        <header className="mb-12 border-b border-border pb-10">
          <p className="text-xs font-mono font-medium uppercase tracking-[0.25em] text-orange-600 mb-4">
            Engineering Blog
          </p>
          <h1 className="text-4xl sm:text-6xl font-bold tracking-tight text-balance leading-tight">
            {TITLE}
          </h1>
          <p className="mt-4 text-xl sm:text-2xl text-text-secondary font-medium text-balance">
            {SUBTITLE}
          </p>
          <div className="mt-6 text-sm text-text-secondary">
            <span>Lewis Tham</span>
            <span className="mx-2">|</span>
            <time dateTime={PUBLISHED_AT}>April 2, 2026</time>
          </div>
        </header>

        {/* --- The Rube Goldberg Machine --- */}
        <section className="mb-12">
          <h2 className="text-2xl font-semibold tracking-tight mb-4">
            The rendering pipeline is a translation layer
          </h2>
          <p className="text-base sm:text-lg leading-8 text-text-secondary mb-6">
            Every modern website works the same way. A server holds structured data. An API returns it as JSON. A frontend framework converts that JSON into HTML. A browser engine parses the HTML, applies CSS, executes JavaScript, composites layers, and rasterizes pixels onto a screen. Human eyes read the pixels. Human brains extract meaning.
          </p>
          <p className="text-base sm:text-lg leading-8 text-text-secondary mb-6">
            For a human, every step in that pipeline is necessary. We cannot read JSON. We need the rendering.
          </p>
          <p className="text-base sm:text-lg leading-8 text-text-secondary mb-6">
            Now look at what happens when an AI agent &ldquo;browses&rdquo; a website using Playwright or Puppeteer:
          </p>

          <div className="rounded-2xl border border-border bg-surface-sunken p-6 sm:p-8 mb-6 font-mono text-sm sm:text-base">
            <div className="space-y-1 text-text-secondary">
              <p className="text-orange-500 font-semibold mb-3">The full path of a single browser automation action:</p>
              <p>1. Server generates JSON</p>
              <p>2. Frontend converts JSON &rarr; HTML + CSS + JS</p>
              <p>3. Browser engine renders HTML &rarr; layout tree &rarr; paint layers</p>
              <p>4. GPU composites layers &rarr; pixel buffer</p>
              <p>5. Screenshot captures pixels &rarr; PNG/JPEG bytes</p>
              <p>6. Vision model decodes pixels &rarr; text tokens</p>
              <p>7. LLM reasons over tokens &rarr; decides next action</p>
              <p>8. Playwright executes click at pixel coordinates</p>
              <p>9. Goto step 1</p>
            </div>
          </div>

          <p className="text-base sm:text-lg leading-8 text-text-secondary mb-4">
            In short:
          </p>

          <div className="rounded-2xl border border-orange-500/20 bg-orange-50/50 p-6 sm:p-8 mb-6">
            <p className="text-lg sm:text-xl font-mono font-semibold text-text-primary text-center">
              JSON &rarr; HTML &rarr; pixels &rarr; text &rarr; JSON
            </p>
          </div>

          <p className="text-base sm:text-lg leading-8 text-text-secondary">
            The data starts as structured JSON on the server. It ends as structured JSON in the agent&rsquo;s memory. Everything in between is a translation layer that exists for human eyes. When the consumer is a machine, the entire rendering pipeline is overhead. It is a Rube Goldberg machine.
          </p>
        </section>

        {/* --- The Cost --- */}
        <section className="mb-12">
          <h2 className="text-2xl font-semibold tracking-tight mb-4">
            The $0.53 tax on every agent web action
          </h2>
          <p className="text-base sm:text-lg leading-8 text-text-secondary mb-6">
            We ran the numbers. Not on toy benchmarks &mdash; on 94 real production websites, comparing Playwright browser automation against direct internal API calls. The paper is on{" "}
            <a href={ARXIV_URL} target="_blank" rel="noopener" className="text-orange-600 hover:text-orange-500 font-medium">
              arXiv (2604.00694)
            </a>
            . Here are the headline results:
          </p>

          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 mb-8">
            <div className="rounded-2xl border border-border bg-surface-sunken p-6 text-center">
              <div className="text-3xl sm:text-4xl font-bold text-orange-500 mb-1">3.6x</div>
              <div className="text-sm text-text-secondary font-medium">Mean speedup</div>
              <div className="text-xs text-text-secondary mt-1">(5.4x median, 30x best case)</div>
            </div>
            <div className="rounded-2xl border border-border bg-surface-sunken p-6 text-center">
              <div className="text-3xl sm:text-4xl font-bold text-orange-500 mb-1">106x</div>
              <div className="text-sm text-text-secondary font-medium">Cost reduction</div>
              <div className="text-xs text-text-secondary mt-1">$0.53 browser vs $0.005 cached</div>
            </div>
            <div className="rounded-2xl border border-border bg-surface-sunken p-6 text-center">
              <div className="text-3xl sm:text-4xl font-bold text-orange-500 mb-1">100%</div>
              <div className="text-sm text-text-secondary font-medium">Win rate</div>
              <div className="text-xs text-text-secondary mt-1">API faster on all 94 domains</div>
            </div>
          </div>

          <p className="text-base sm:text-lg leading-8 text-text-secondary mb-4">
            Every agent web action through a browser costs roughly $0.53 when you account for compute, LLM tokens for visual grounding, and wall-clock time. The same action through a cached API call costs $0.005. That is a 106x difference.
          </p>
          <p className="text-base sm:text-lg leading-8 text-text-secondary">
            At scale, this is not an optimization. It is the difference between a viable product and one that burns through its runway on rendering taxes.
          </p>
        </section>

        {/* --- What You're Actually Paying For --- */}
        <section className="mb-12">
          <h2 className="text-2xl font-semibold tracking-tight mb-4">
            What browser automation actually costs
          </h2>
          <p className="text-base sm:text-lg leading-8 text-text-secondary mb-6">
            The $0.53 per action breaks down into components that compound:
          </p>

          <div className="space-y-4 mb-6">
            <div className="rounded-xl border border-border p-4 sm:p-5">
              <div className="font-semibold text-text-primary mb-1">500 MB RAM per browser instance</div>
              <p className="text-sm text-text-secondary">
                Headless Chrome allocates ~500 MB per tab. An API call allocates zero. If you are running 100 concurrent agents, that is 50 GB of RAM dedicated to rendering pixels that no one will ever look at.
              </p>
            </div>
            <div className="rounded-xl border border-border p-4 sm:p-5">
              <div className="font-semibold text-text-primary mb-1">3-30 seconds per page interaction</div>
              <p className="text-sm text-text-secondary">
                Navigation, JavaScript execution, rendering, screenshot capture, vision model inference, LLM reasoning, action execution. Each step adds latency. A cached API call returns in under a second.
              </p>
            </div>
            <div className="rounded-xl border border-border p-4 sm:p-5">
              <div className="font-semibold text-text-primary mb-1">8,000-12,000 tokens per screenshot</div>
              <p className="text-sm text-text-secondary">
                Encoding a screenshot into tokens for a vision model is expensive. The structured JSON response from an API call is typically 200-500 tokens. That is a 20-40x token reduction per interaction.
              </p>
            </div>
            <div className="rounded-xl border border-border p-4 sm:p-5">
              <div className="font-semibold text-text-primary mb-1">Brittle selectors and layout shifts</div>
              <p className="text-sm text-text-secondary">
                Every CSS change, A/B test, or layout variation can break a Playwright script. API contracts change far less frequently than UI layouts. When they do change, schema drift is detectable and fixable automatically.
              </p>
            </div>
          </div>
        </section>

        {/* --- The Architecture Problem --- */}
        <section className="mb-12">
          <h2 className="text-2xl font-semibold tracking-tight mb-4">
            This is an architecture problem, not an optimization problem
          </h2>
          <p className="text-base sm:text-lg leading-8 text-text-secondary mb-6">
            The instinct in the AI agent community has been to optimize the browser pipeline. Faster screenshot capture. Better vision models. Smarter DOM parsers. Accessibility tree extraction. Smaller browser binaries.
          </p>
          <p className="text-base sm:text-lg leading-8 text-text-secondary mb-6">
            These are real improvements. But they are optimizing the wrong layer. You can make the rendering pipeline 10x faster and it is still architecturally slower than skipping it entirely. An optimized Rube Goldberg machine is still a Rube Goldberg machine.
          </p>
          <p className="text-base sm:text-lg leading-8 text-text-secondary mb-6">
            The comparison is not Playwright-fast vs. Playwright-slow. It is:
          </p>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 mb-6">
            <div className="rounded-2xl border border-border bg-surface-sunken p-6">
              <p className="font-semibold text-text-primary mb-2">Browser automation</p>
              <div className="font-mono text-sm text-text-secondary space-y-1">
                <p>Launch Chrome</p>
                <p>Allocate 500 MB RAM</p>
                <p>Navigate to URL</p>
                <p>Execute JavaScript</p>
                <p>Render layout</p>
                <p>Composite + rasterize</p>
                <p>Capture screenshot</p>
                <p>Encode to tokens</p>
                <p>LLM vision inference</p>
                <p>Decide action</p>
                <p>Execute click</p>
                <p>Repeat</p>
              </div>
            </div>
            <div className="rounded-2xl border border-orange-500/20 bg-orange-50/50 p-6">
              <p className="font-semibold text-text-primary mb-2">Direct API call</p>
              <div className="font-mono text-sm text-text-secondary space-y-1">
                <p>GET /api/endpoint</p>
                <p>Parse JSON</p>
                <p>Done</p>
              </div>
            </div>
          </div>

          <p className="text-base sm:text-lg leading-8 text-text-secondary">
            This is not a question of optimization. It is a question of whether the rendering pipeline should exist in the agent execution path at all. For machines talking to machines, the answer is no.
          </p>
        </section>

        {/* --- The Hard Problem --- */}
        <section className="mb-12">
          <h2 className="text-2xl font-semibold tracking-tight mb-4">
            The reason everyone still uses browsers: API discovery is hard
          </h2>
          <p className="text-base sm:text-lg leading-8 text-text-secondary mb-6">
            If direct API calls are obviously better, why does every agent framework default to browser automation?
          </p>
          <p className="text-base sm:text-lg leading-8 text-text-secondary mb-6">
            Because the web does not publish its internal APIs. There is no <code className="text-sm bg-surface-sunken rounded px-1.5 py-0.5 font-mono">sitemap.xml</code> for JSON endpoints. Every website has a different API structure, different authentication, different schemas. Reddit&rsquo;s internal API is nothing like Airbnb&rsquo;s. LinkedIn&rsquo;s GraphQL layer is nothing like GitHub&rsquo;s REST API.
          </p>
          <p className="text-base sm:text-lg leading-8 text-text-secondary mb-6">
            Browser automation is the lowest common denominator. It treats every website the same way: as pixels. That universality comes at the cost of the entire rendering pipeline per action.
          </p>
          <p className="text-base sm:text-lg leading-8 text-text-secondary">
            The correct solution is not to keep paying the rendering tax. It is to solve discovery once and share the results.
          </p>
        </section>

        {/* --- How Unbrowse Works --- */}
        <section className="mb-12">
          <h2 className="text-2xl font-semibold tracking-tight mb-4">
            How Unbrowse solves discovery
          </h2>
          <p className="text-base sm:text-lg leading-8 text-text-secondary mb-6">
            Unbrowse is an agent-native browser. Instead of rendering websites, it discovers and indexes the internal APIs behind them. The architecture has three execution paths:
          </p>

          <div className="space-y-4 mb-6">
            <div className="rounded-xl border border-border p-4 sm:p-5">
              <div className="font-semibold text-text-primary mb-1">1. Route cache hit (warm path)</div>
              <p className="text-sm text-text-secondary">
                The API endpoint for this domain and intent has already been discovered. Execute the cached call directly. 950 ms average. $0.005 per call.
              </p>
            </div>
            <div className="rounded-xl border border-border p-4 sm:p-5">
              <div className="font-semibold text-text-primary mb-1">2. Shared graph lookup</div>
              <p className="text-sm text-text-secondary">
                Another agent on the network has already discovered this endpoint. Pull the route from the shared graph. First use requires validation; subsequent calls are cached locally.
              </p>
            </div>
            <div className="rounded-xl border border-border p-4 sm:p-5">
              <div className="font-semibold text-text-primary mb-1">3. Browser fallback (cold path)</div>
              <p className="text-sm text-text-secondary">
                No cached route exists. Unbrowse opens a real browser, captures network traffic, reverse-engineers the API endpoints, learns schemas and auth patterns, then publishes to the shared graph. Discovery averages 12.4 seconds and amortizes within 3-5 reuses.
              </p>
            </div>
          </div>

          <p className="text-base sm:text-lg leading-8 text-text-secondary">
            The browser is the fallback, not the default. Every discovery makes the network smarter. An agent in Tokyo discovers a site&rsquo;s internal pricing API. Three seconds later, an agent in London uses it. The discovery happened once. The knowledge persists.
          </p>
        </section>

        {/* --- The Benchmark --- */}
        <section className="mb-12">
          <h2 className="text-2xl font-semibold tracking-tight mb-4">
            94 domains. 100% win rate.
          </h2>
          <p className="text-base sm:text-lg leading-8 text-text-secondary mb-6">
            We benchmarked Unbrowse against Playwright across 94 live production websites. Not synthetic test pages &mdash; real sites with real authentication, real JavaScript rendering, real API complexity.
          </p>

          <div className="rounded-2xl border border-border bg-surface-sunken p-6 sm:p-8 mb-6">
            <p className="font-semibold text-text-primary mb-4">Key findings from the benchmark:</p>
            <ul className="space-y-3 text-base leading-7 text-text-secondary list-disc pl-5">
              <li><strong className="text-text-primary">3.6x mean speedup</strong> across all domains (warmed-cache execution: 950 ms vs 3,404 ms)</li>
              <li><strong className="text-text-primary">5.4x median speedup</strong> &mdash; the median tells a better story because outlier browser latency skews the mean</li>
              <li><strong className="text-text-primary">30x best-case speedup</strong> on domains with heavy JavaScript rendering</li>
              <li><strong className="text-text-primary">106x cost reduction</strong> per task ($0.53 browser vs $0.005 cached API)</li>
              <li><strong className="text-text-primary">100% win rate</strong> &mdash; Unbrowse was faster on every single domain tested</li>
              <li><strong className="text-text-primary">500 MB RAM eliminated</strong> per concurrent instance (no browser process needed for cached calls)</li>
              <li><strong className="text-text-primary">Cold-start discovery: 12.4s average</strong>, amortized within 3-5 reuses</li>
            </ul>
          </div>

          <p className="text-base sm:text-lg leading-8 text-text-secondary">
            The results were not close. On no domain did browser automation match the speed of a direct API call. The architectural advantage is fundamental: removing the rendering pipeline from the execution path is not an incremental improvement. It is a category change.
          </p>
        </section>

        {/* --- For Playwright/Puppeteer Engineers --- */}
        <section className="mb-12">
          <h2 className="text-2xl font-semibold tracking-tight mb-4">
            If you are using Playwright or Puppeteer for agent web tasks
          </h2>
          <p className="text-base sm:text-lg leading-8 text-text-secondary mb-6">
            This is not a criticism of Playwright or Puppeteer as testing tools. They are excellent for what they were designed for: automated end-to-end testing of web applications, where you need to verify the rendering pipeline itself.
          </p>
          <p className="text-base sm:text-lg leading-8 text-text-secondary mb-6">
            The problem is using them as the execution layer for AI agents. When an agent&rsquo;s goal is to get data from a website or perform an action, the rendering pipeline is pure overhead. You are paying for Chrome to render a page that no human will ever see, taking a screenshot that no human will ever look at, and feeding it to a vision model to extract the data that was already structured before Chrome touched it.
          </p>
          <p className="text-base sm:text-lg leading-8 text-text-secondary">
            The uncomfortable truth is that we built machines that cosplay as humans to talk to machines. The server has JSON. The agent wants JSON. In between, we constructed an elaborate pantomime of human web browsing &mdash; rendering, screenshotting, parsing &mdash; because it was easier than solving discovery. Now discovery is solved.
          </p>
        </section>

        {/* --- CTA --- */}
        <section className="mb-12 rounded-2xl border border-orange-500/20 bg-orange-50/50 p-6 sm:p-8">
          <h2 className="text-2xl font-semibold tracking-tight mb-3">
            Try it
          </h2>
          <p className="text-base sm:text-lg leading-8 text-text-secondary mb-6">
            Unbrowse is open source. The paper has the full methodology, benchmark data, and architecture details.
          </p>
          <div className="flex flex-col sm:flex-row gap-3 mb-6">
            <a
              href={ARXIV_URL}
              target="_blank"
              rel="noopener"
              className="inline-flex items-center justify-center rounded-lg bg-orange-500 px-5 py-3 font-medium text-white hover:bg-orange-600 transition-colors"
            >
              Read the paper (arXiv)
            </a>
            <a
              href="https://github.com/unbrowse-ai/unbrowse"
              target="_blank"
              rel="noopener"
              className="inline-flex items-center justify-center rounded-lg border border-border bg-surface-sunken px-5 py-3 font-medium text-text-primary hover:border-orange-500/30 hover:bg-orange-50/40 transition-colors"
            >
              View repository
            </a>
          </div>
          <div className="rounded-xl bg-surface-sunken border border-border p-4 font-mono text-sm">
            <p className="text-text-secondary mb-1"># Install</p>
            <p className="text-text-primary">npm install -g unbrowse</p>
            <p className="text-text-secondary mt-3 mb-1"># Discover APIs on any site</p>
            <p className="text-text-primary">unbrowse resolve &quot;search for flights to Tokyo&quot; --url kayak.com</p>
          </div>
        </section>

        {/* --- Related --- */}
        <section className="mb-12">
          <h2 className="text-2xl font-semibold tracking-tight mb-4">Related</h2>
          <ul className="space-y-3 text-base sm:text-lg leading-8 text-text-secondary">
            <li>
              <Link href="/internal-apis-are-all-you-need" className="text-orange-600 hover:text-orange-500 font-medium">
                Internal APIs Are All You Need
              </Link>
              {" "}&mdash; the full whitepaper on the shared route graph architecture
            </li>
            <li>
              <a href={ARXIV_URL} target="_blank" rel="noopener" className="text-orange-600 hover:text-orange-500 font-medium">
                arXiv:2604.00694
              </a>
              {" "}&mdash; peer-reviewable preprint with complete benchmark methodology
            </li>
            <li>
              <a href="https://github.com/unbrowse-ai/unbrowse" target="_blank" rel="noopener" className="text-orange-600 hover:text-orange-500 font-medium">
                unbrowse-ai/unbrowse
              </a>
              {" "}&mdash; open source repository
            </li>
          </ul>
        </section>
      </article>
    </div>
  );
}
