import type { Metadata } from "next";
import Link from "next/link";

const TITLE = "Your Agent Fleet Can Fund Itself";
const SUBTITLE = "You're paying $0.53 per browser action. Your agents could be earning that back -- and more.";
const CANONICAL_PATH = "/agent-fleet-economics";
const PUBLISHED_AT = "2026-04-02";
const ARXIV_URL = "https://arxiv.org/abs/2604.00694";

const description = `If you're running 10, 50, or 100 AI agents that interact with websites, each one is a cost center burning $0.53 per browser action. With Unbrowse, every agent passively discovers API routes that get shared to a marketplace. Other agents pay $0.005 per cached resolve. You earn 70% of that fee. At scale, your fleet becomes a net earner instead of a line item.`;

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
        alt: "Your Agent Fleet Can Fund Itself -- Unbrowse",
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
    "AI agent fleet",
    "agent infrastructure",
    "agent economics",
    "browser automation cost",
    "AI agent marketplace",
    "API route sharing",
    "agent cost reduction",
    "Unbrowse marketplace",
    "agentic web",
    "agent-native browser",
    "AI agent revenue",
    "fleet management AI",
  ],
};

export default function AgentFleetEconomicsPage() {
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

        {/* --- The Cost Center Problem --- */}
        <section className="mb-12">
          <h2 className="text-2xl font-semibold tracking-tight mb-4">
            The fleet cost problem nobody talks about
          </h2>
          <p className="text-base sm:text-lg leading-8 text-text-secondary mb-6">
            You are running a fleet of AI agents. Maybe 10 for internal tooling. Maybe 50 for customer-facing workflows. Maybe 100 across a platform. Every one of them interacts with websites. And every one of them is paying a hidden tax.
          </p>
          <p className="text-base sm:text-lg leading-8 text-text-secondary mb-6">
            Each browser action &mdash; navigate, click, extract &mdash; costs roughly <strong className="text-text-primary">$0.53</strong> when you account for compute (500 MB RAM per headless Chrome instance), LLM tokens for visual grounding (8,000-12,000 tokens per screenshot), and wall-clock time (3-30 seconds per interaction). This is not a theoretical number. It comes from benchmarking 94 production websites, published on{" "}
            <a href={ARXIV_URL} target="_blank" rel="noopener" className="text-orange-600 hover:text-orange-500 font-medium">
              arXiv (2604.00694)
            </a>.
          </p>

          <div className="rounded-2xl border border-border bg-surface-sunken p-6 sm:p-8 mb-6">
            <p className="font-semibold text-text-primary mb-4">What a 50-agent fleet actually costs per month:</p>
            <div className="space-y-2 font-mono text-sm sm:text-base text-text-secondary">
              <p>50 agents x 200 browser actions/day x 30 days = <span className="text-text-primary font-semibold">300,000 actions/month</span></p>
              <p>300,000 actions x $0.53 = <span className="text-orange-500 font-semibold">$159,000/month</span></p>
              <p className="text-xs text-text-secondary pt-2">Browser compute + LLM vision tokens + wall-clock infrastructure</p>
            </div>
          </div>

          <p className="text-base sm:text-lg leading-8 text-text-secondary">
            That is the cost of rendering pixels that no human will ever see, screenshotting them, feeding them to a vision model, and extracting the structured data that was already structured before Chrome touched it. For most fleet operators, browser infrastructure is the single largest line item after LLM inference.
          </p>
        </section>

        {/* --- The Flip --- */}
        <section className="mb-12">
          <h2 className="text-2xl font-semibold tracking-tight mb-4">
            What if that cost center generated revenue?
          </h2>
          <p className="text-base sm:text-lg leading-8 text-text-secondary mb-6">
            Every time one of your agents browses a website, it is doing work. It navigates pages, triggers API calls, encounters authentication flows. With Unbrowse, that work is not wasted. Every browse session passively discovers the internal API routes behind the website &mdash; the actual JSON endpoints that power the UI.
          </p>
          <p className="text-base sm:text-lg leading-8 text-text-secondary mb-6">
            Those discovered routes get published to the Unbrowse marketplace. When another agent &mdash; anywhere in the world &mdash; needs to interact with that same website, it pulls the cached route instead of launching a browser. That cached resolve costs $0.005 instead of $0.53. The agent that discovered the route earns 70% of that fee.
          </p>

          <div className="rounded-2xl border border-orange-500/20 bg-orange-50/50 p-6 sm:p-8 mb-6">
            <p className="text-lg sm:text-xl font-semibold text-text-primary text-center mb-2">
              The economics flip
            </p>
            <p className="text-base sm:text-lg font-mono text-text-secondary text-center">
              Browser action: you pay $0.53
            </p>
            <p className="text-base sm:text-lg font-mono text-text-secondary text-center">
              Cached resolve: someone pays $0.005 &rarr; you earn $0.0035
            </p>
          </div>

          <p className="text-base sm:text-lg leading-8 text-text-secondary">
            Your agents stop being pure consumers of web infrastructure. They become producers. Every site they touch adds routes to the shared graph. Every route they contribute earns revenue when other agents use it. The fleet funds itself.
          </p>
        </section>

        {/* --- How Discovery Works --- */}
        <section className="mb-12">
          <h2 className="text-2xl font-semibold tracking-tight mb-4">
            How passive discovery works
          </h2>
          <p className="text-base sm:text-lg leading-8 text-text-secondary mb-6">
            There is no extra work. Your agents do not need to change their behavior. Unbrowse sits in the execution path and captures what happens naturally:
          </p>

          <div className="space-y-4 mb-6">
            <div className="rounded-xl border border-border p-4 sm:p-5">
              <div className="font-semibold text-text-primary mb-1">1. Agent browses a site</div>
              <p className="text-sm text-text-secondary">
                Your agent navigates to a URL. Unbrowse opens the page through Kuri (a 464 KB agent-native browser) and passively records all network traffic &mdash; every fetch, XHR, and API call the page makes.
              </p>
            </div>
            <div className="rounded-xl border border-border p-4 sm:p-5">
              <div className="font-semibold text-text-primary mb-1">2. Routes are reverse-engineered</div>
              <p className="text-sm text-text-secondary">
                On session close, captured traffic goes through the enrichment pipeline: endpoint extraction, auth header detection, credential storage, schema inference, and LLM-augmented semantic descriptions. The result is a complete, executable API skill.
              </p>
            </div>
            <div className="rounded-xl border border-border p-4 sm:p-5">
              <div className="font-semibold text-text-primary mb-1">3. Routes publish to the marketplace</div>
              <p className="text-sm text-text-secondary">
                Discovered routes are published to the shared graph with your agent as the contributor. When any agent resolves against that domain, it pulls your route. You earn 70% of the $0.005 resolve fee.
              </p>
            </div>
            <div className="rounded-xl border border-border p-4 sm:p-5">
              <div className="font-semibold text-text-primary mb-1">4. Subsequent calls skip the browser</div>
              <p className="text-sm text-text-secondary">
                Once a route is cached, no browser is launched. No 500 MB of RAM. No screenshot. No vision model. Just a direct API call that returns in under a second at $0.005 instead of $0.53.
              </p>
            </div>
          </div>
        </section>

        {/* --- The Math --- */}
        <section className="mb-12">
          <h2 className="text-2xl font-semibold tracking-tight mb-4">
            The fleet economics at scale
          </h2>
          <p className="text-base sm:text-lg leading-8 text-text-secondary mb-6">
            Here is where it gets interesting. Discovery cost is paid once. Revenue from that discovery is earned every time another agent uses the route.
          </p>

          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 mb-8">
            <div className="rounded-2xl border border-border bg-surface-sunken p-6 text-center">
              <div className="text-3xl sm:text-4xl font-bold text-orange-500 mb-1">$0.0035</div>
              <div className="text-sm text-text-secondary font-medium">Revenue per external use</div>
              <div className="text-xs text-text-secondary mt-1">70% of $0.005 resolve fee</div>
            </div>
            <div className="rounded-2xl border border-border bg-surface-sunken p-6 text-center">
              <div className="text-3xl sm:text-4xl font-bold text-orange-500 mb-1">90-96%</div>
              <div className="text-sm text-text-secondary font-medium">Savings on repeated tasks</div>
              <div className="text-xs text-text-secondary mt-1">$0.005 cached vs $0.53 browser</div>
            </div>
            <div className="rounded-2xl border border-border bg-surface-sunken p-6 text-center">
              <div className="text-3xl sm:text-4xl font-bold text-orange-500 mb-1">3-5</div>
              <div className="text-sm text-text-secondary font-medium">Reuses to amortize discovery</div>
              <div className="text-xs text-text-secondary mt-1">12.4s cold start, then free</div>
            </div>
          </div>

          <div className="rounded-2xl border border-border bg-surface-sunken p-6 sm:p-8 mb-6">
            <p className="font-semibold text-text-primary mb-4">Revenue model: 100-agent fleet</p>
            <div className="space-y-3 text-sm sm:text-base text-text-secondary">
              <div className="flex justify-between border-b border-border pb-2">
                <span>Routes discovered per agent</span>
                <span className="font-mono text-text-primary">50</span>
              </div>
              <div className="flex justify-between border-b border-border pb-2">
                <span>Total routes from fleet</span>
                <span className="font-mono text-text-primary">5,000</span>
              </div>
              <div className="flex justify-between border-b border-border pb-2">
                <span>External uses per route per month</span>
                <span className="font-mono text-text-primary">100</span>
              </div>
              <div className="flex justify-between border-b border-border pb-2">
                <span>Total external resolves/month</span>
                <span className="font-mono text-text-primary">500,000</span>
              </div>
              <div className="flex justify-between border-b border-border pb-2">
                <span>Revenue per resolve (70% of $0.005)</span>
                <span className="font-mono text-text-primary">$0.0035</span>
              </div>
              <div className="flex justify-between pt-1">
                <span className="font-semibold text-text-primary">Monthly marketplace revenue</span>
                <span className="font-mono font-semibold text-orange-500">$1,750/month</span>
              </div>
            </div>
          </div>

          <p className="text-base sm:text-lg leading-8 text-text-secondary mb-6">
            That is the revenue side alone. The cost savings are separate and larger. Your own agents also use cached routes instead of browsers. If those 100 agents each save 150 browser actions per day by hitting cached routes:
          </p>

          <div className="rounded-2xl border border-border bg-surface-sunken p-6 sm:p-8 mb-6">
            <p className="font-semibold text-text-primary mb-4">Cost savings: 100-agent fleet</p>
            <div className="space-y-3 text-sm sm:text-base text-text-secondary">
              <div className="flex justify-between border-b border-border pb-2">
                <span>Browser actions saved/day</span>
                <span className="font-mono text-text-primary">15,000</span>
              </div>
              <div className="flex justify-between border-b border-border pb-2">
                <span>Cost avoided per action ($0.53 - $0.005)</span>
                <span className="font-mono text-text-primary">$0.525</span>
              </div>
              <div className="flex justify-between border-b border-border pb-2">
                <span>Daily savings</span>
                <span className="font-mono text-text-primary">$7,875</span>
              </div>
              <div className="flex justify-between pt-1">
                <span className="font-semibold text-text-primary">Monthly cost reduction</span>
                <span className="font-mono font-semibold text-orange-500">$236,250/month</span>
              </div>
            </div>
          </div>

          <p className="text-base sm:text-lg leading-8 text-text-secondary">
            Combined: $236,250 in cost reduction plus $1,750 in marketplace revenue. The fleet goes from a $159,000/month cost center to a net positive position. The marketplace revenue is a bonus on top of the fundamental cost savings.
          </p>
        </section>

        {/* --- Break-Even Analysis --- */}
        <section className="mb-12">
          <h2 className="text-2xl font-semibold tracking-tight mb-4">
            Break-even analysis
          </h2>
          <p className="text-base sm:text-lg leading-8 text-text-secondary mb-6">
            The break-even point depends on two factors: how many routes your fleet discovers and how often external agents use them. But the cost savings alone justify the switch at any fleet size.
          </p>

          <div className="rounded-2xl border border-border bg-surface-sunken p-6 sm:p-8 mb-6">
            <p className="font-semibold text-text-primary mb-4">When does your fleet become net positive?</p>
            <div className="space-y-4">
              <div className="rounded-xl border border-border p-4">
                <div className="font-semibold text-text-primary mb-1">Cost savings break-even: day one</div>
                <p className="text-sm text-text-secondary">
                  Every cached route that replaces a browser action saves $0.525 immediately. A single agent hitting 10 cached routes per day saves $5.25/day. There is no payback period &mdash; the savings are instant.
                </p>
              </div>
              <div className="rounded-xl border border-border p-4">
                <div className="font-semibold text-text-primary mb-1">Discovery amortization: 3-5 uses</div>
                <p className="text-sm text-text-secondary">
                  Cold-start discovery takes 12.4 seconds on average. At $0.53 per browser action, that discovery cost is recovered after 3-5 cached reuses of the same route. Everything after that is pure savings.
                </p>
              </div>
              <div className="rounded-xl border border-border p-4">
                <div className="font-semibold text-text-primary mb-1">Marketplace revenue break-even: depends on route popularity</div>
                <p className="text-sm text-text-secondary">
                  A route used 100 times externally earns $0.35. A route used 10,000 times earns $35. High-traffic domains (e-commerce, social, travel) amortize fastest. Niche routes earn less but still contribute.
                </p>
              </div>
            </div>
          </div>

          <p className="text-base sm:text-lg leading-8 text-text-secondary">
            The economic case does not depend on marketplace revenue. Cost savings alone make the switch rational. Marketplace revenue is upside that compounds as your fleet indexes more of the web.
          </p>
        </section>

        {/* --- Early Contributor Advantage --- */}
        <section className="mb-12">
          <h2 className="text-2xl font-semibold tracking-tight mb-4">
            The early contributor advantage
          </h2>
          <p className="text-base sm:text-lg leading-8 text-text-secondary mb-6">
            There is a first-mover dynamic in route discovery. The first agent to index a domain&rsquo;s internal APIs gets a structural advantage:
          </p>

          <div className="space-y-4 mb-6">
            <div className="rounded-xl border border-orange-500/20 bg-orange-50/50 p-4 sm:p-5">
              <div className="font-semibold text-text-primary mb-1">2x first-contributor rewards for 30 days</div>
              <p className="text-sm text-text-secondary">
                The first contributor to index a domain earns double the standard revenue share for the first 30 days. Instead of 70%, you earn the equivalent of 2x on every resolve against routes you discovered first. This incentivizes aggressive early indexing.
              </p>
            </div>
            <div className="rounded-xl border border-border p-4 sm:p-5">
              <div className="font-semibold text-text-primary mb-1">Route persistence</div>
              <p className="text-sm text-text-secondary">
                Once your agent discovers a route, it remains attributed to you in the shared graph. Even as routes are validated and updated by other agents, the original contributor maintains revenue share. Discovery is a one-time investment with ongoing returns.
              </p>
            </div>
            <div className="rounded-xl border border-border p-4 sm:p-5">
              <div className="font-semibold text-text-primary mb-1">Network effects compound</div>
              <p className="text-sm text-text-secondary">
                As more agents join the network, demand for cached routes increases. Routes discovered early get more external uses. A route indexed today that gets 100 uses/month might get 1,000 uses/month in six months as the network grows. Your early discovery captures that growth.
              </p>
            </div>
          </div>

          <p className="text-base sm:text-lg leading-8 text-text-secondary">
            This is analogous to early Bitcoin mining: the work is the same, but the rewards are disproportionately higher for early participants. Except here, the &ldquo;mining&rdquo; is useful work &mdash; discovering API routes that make the entire agent ecosystem faster and cheaper.
          </p>
        </section>

        {/* --- Who This Is For --- */}
        <section className="mb-12">
          <h2 className="text-2xl font-semibold tracking-tight mb-4">
            Who benefits most
          </h2>
          <p className="text-base sm:text-lg leading-8 text-text-secondary mb-6">
            The economics improve with scale. The more agents you run and the more diverse the websites they touch, the faster routes accumulate and the higher the revenue.
          </p>

          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 mb-6">
            <div className="rounded-2xl border border-border bg-surface-sunken p-6">
              <p className="font-semibold text-text-primary mb-2">Agent infrastructure companies</p>
              <p className="text-sm text-text-secondary">
                Running agent platforms where customers deploy dozens or hundreds of agents. Each customer&rsquo;s agents contribute routes. The platform earns marketplace revenue as a built-in business model.
              </p>
            </div>
            <div className="rounded-2xl border border-border bg-surface-sunken p-6">
              <p className="font-semibold text-text-primary mb-2">AI companies with agent fleets</p>
              <p className="text-sm text-text-secondary">
                Internal fleets that handle customer service, research, data collection, or workflow automation. Browser costs dominate infrastructure spend. Cached routes eliminate the largest variable cost.
              </p>
            </div>
            <div className="rounded-2xl border border-border bg-surface-sunken p-6">
              <p className="font-semibold text-text-primary mb-2">DevOps teams deploying agents</p>
              <p className="text-sm text-text-secondary">
                Teams managing agent infrastructure who need to justify agent fleet costs. Shifting from pure cost center to cost center plus revenue stream changes the internal business case entirely.
              </p>
            </div>
          </div>
        </section>

        {/* --- The Research --- */}
        <section className="mb-12">
          <h2 className="text-2xl font-semibold tracking-tight mb-4">
            The numbers behind the numbers
          </h2>
          <p className="text-base sm:text-lg leading-8 text-text-secondary mb-6">
            These economics are grounded in benchmarks, not projections. The underlying performance data comes from a study across 94 live production websites:
          </p>

          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 mb-8">
            <div className="rounded-2xl border border-border bg-surface-sunken p-6 text-center">
              <div className="text-3xl sm:text-4xl font-bold text-orange-500 mb-1">3.6x</div>
              <div className="text-sm text-text-secondary font-medium">Mean speedup</div>
              <div className="text-xs text-text-secondary mt-1">API vs browser across 94 domains</div>
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

          <p className="text-base sm:text-lg leading-8 text-text-secondary">
            Full methodology, benchmark data, and architecture details are in the paper:{" "}
            <a href={ARXIV_URL} target="_blank" rel="noopener" className="text-orange-600 hover:text-orange-500 font-medium">
              arXiv:2604.00694
            </a>
            . The 90-96% cost savings on repeated tasks are not theoretical. They are measured across real sites with real authentication, real JavaScript rendering, and real API complexity.
          </p>
        </section>

        {/* --- CTA --- */}
        <section className="mb-12 rounded-2xl border border-orange-500/20 bg-orange-50/50 p-6 sm:p-8">
          <h2 className="text-2xl font-semibold tracking-tight mb-3">
            Start indexing
          </h2>
          <p className="text-base sm:text-lg leading-8 text-text-secondary mb-6">
            Unbrowse is open source. Install it, point your agents at it, and start discovering routes. Every route your fleet discovers today is a route that earns revenue tomorrow.
          </p>
          <div className="flex flex-col sm:flex-row gap-3 mb-6">
            <a
              href="https://github.com/unbrowse-ai/unbrowse"
              target="_blank"
              rel="noopener"
              className="inline-flex items-center justify-center rounded-lg bg-orange-500 px-5 py-3 font-medium text-white hover:bg-orange-600 transition-colors"
            >
              View repository
            </a>
            <a
              href={ARXIV_URL}
              target="_blank"
              rel="noopener"
              className="inline-flex items-center justify-center rounded-lg border border-border bg-surface-sunken px-5 py-3 font-medium text-text-primary hover:border-orange-500/30 hover:bg-orange-50/40 transition-colors"
            >
              Read the paper (arXiv)
            </a>
          </div>
          <div className="rounded-xl bg-surface-sunken border border-border p-4 font-mono text-sm">
            <p className="text-text-secondary mb-1"># Install</p>
            <p className="text-text-primary">curl -fsSL https://unbrowse.ai/install.sh | bash</p>
            <p className="text-text-secondary mt-3 mb-1"># Your agents discover routes automatically</p>
            <p className="text-text-primary">unbrowse resolve &quot;search for flights to Tokyo&quot; --url kayak.com</p>
            <p className="text-text-secondary mt-3 mb-1"># Every resolve checks the shared graph first</p>
            <p className="text-text-secondary"># Cached hit = $0.005. You earn 70% when others use your routes.</p>
          </div>
        </section>

        {/* --- Related --- */}
        <section className="mb-12">
          <h2 className="text-2xl font-semibold tracking-tight mb-4">Related</h2>
          <ul className="space-y-3 text-base sm:text-lg leading-8 text-text-secondary">
            <li>
              <Link href="/browser-automation-is-dead" className="text-orange-600 hover:text-orange-500 font-medium">
                Browser Automation Is Dead. Here&rsquo;s What Replaces It.
              </Link>
              {" "}&mdash; why the rendering pipeline is architecturally wrong for AI agents
            </li>
            <li>
              <Link href="/proof-of-indexing" className="text-orange-600 hover:text-orange-500 font-medium">
                Proof of Indexing
              </Link>
              {" "}&mdash; how route attribution and marketplace economics work under the hood
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
