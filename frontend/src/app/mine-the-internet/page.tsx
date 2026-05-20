import type { Metadata } from "next";
import Link from "next/link";

const TITLE = "Mine the Internet";
const SUBTITLE =
  "Google indexed the web for humans and became worth $2T. The agentic web needs its own index. You can build it and get paid.";
const CANONICAL_PATH = "/mine-the-internet";
const PUBLISHED_AT = "2026-04-02";
const AUTHOR = {
  name: "Lewis Tham",
  affiliation: "Unbrowse AI",
  url: "https://x.com/lewistham",
};

const description = `The agentic web needs a new kind of index — not HTML pages, but machine-readable API routes. Unbrowse turns normal web browsing into mining: every site you visit contributes routes to a shared graph. When AI agents use those routes, you earn USDC micropayments. No GPUs. No staking. Just use the web and get paid.`;

export const metadata: Metadata = {
  title: `${TITLE} — Earn From Web Indexing for AI Agents | Unbrowse`,
  description,
  alternates: {
    canonical: `https://www.unbrowse.ai${CANONICAL_PATH}`,
  },
  authors: [{ name: AUTHOR.name, url: AUTHOR.url }],
  openGraph: {
    title: `${TITLE} — ${SUBTITLE}`,
    description,
    url: `https://www.unbrowse.ai${CANONICAL_PATH}`,
    siteName: "Unbrowse",
    type: "article",
    publishedTime: PUBLISHED_AT,
    images: [
      {
        url: "https://www.unbrowse.ai/og-image.png",
        alt: "Unbrowse — Mine the Internet",
      },
    ],
  },
  twitter: {
    card: "summary_large_image",
    site: "@unbrowse",
    title: `${TITLE} — Earn From Web Indexing for AI Agents`,
    description,
    images: ["https://www.unbrowse.ai/og-image.png"],
  },
  keywords: [
    "mine the internet",
    "web mining",
    "earn from AI agents",
    "proof of indexing",
    "earn from web indexing",
    "web mining for AI",
    "agentic web",
    "x402",
    "micropayments",
    "agent economy",
    "Unbrowse",
    "USDC",
    "Solana",
    "Base",
    "route graph",
    "API discovery",
    "shadow APIs",
    "earn crypto browsing",
    "mine web routes",
    "AI agent infrastructure",
    "web3 mining",
    "passive income crypto",
    "internet mining",
  ],
};

/* ------------------------------------------------------------------ */
/*  Prose sections                                                     */
/* ------------------------------------------------------------------ */

const sections: { title: string; body: string[] }[] = [
  {
    title: "What is web mining?",
    body: [
      "Every website you use runs on internal APIs. When you search GitHub, your browser calls a JSON endpoint. When you scroll Reddit, fetch requests pull post data from a backend service. When you check a price on Amazon, an XHR call returns structured product information. These internal APIs are the real interface layer of the web. Humans never see them. AI agents need them.",
      "Web mining is the act of discovering these internal APIs and contributing them to a shared index. With Unbrowse, mining is not a separate activity. It is what happens automatically when you browse. Visit a site, and Unbrowse captures the network traffic between your browser and the server. It identifies every fetch and XHR call, reverse-engineers the schema, authentication pattern, and parameters, and publishes the route to a shared graph.",
      "That is a mining event. You just indexed a piece of the internet that AI agents can now use directly instead of launching a headless browser, rendering JavaScript, and scraping pixels. Every route you contribute is attributed to your wallet. Every time an agent uses that route, you earn.",
    ],
  },
  {
    title: "How the economics work",
    body: [
      "When an AI agent resolves a task through the shared route graph, it pays $0.005 per cached route. That fee splits three ways: 70% to the route creator, 20% to the platform for infrastructure and quality verification, and 10% reserved for future site-owner royalties.",
      "Compare that to the alternative. A fresh browser-based resolve — launching headless Chrome, rendering the page, navigating the DOM, extracting data — costs $0.53 on average. That is a 106x cost difference. Agents are economically rational. Given a choice between $0.53 and $0.005 for the same result, they will choose the cached route every single time.",
      "This means demand is automatic. The moment your route exists in the graph, any agent that needs it will prefer it over browser automation. You do not need to market your routes or find buyers. The cost advantage does the selling for you.",
      "Your 70% share means you earn $0.0035 per resolve. One route on a popular domain, used 1,000 times per day, earns $3.50 daily. That is $105 per month from a single endpoint you discovered by browsing a website you were already going to visit.",
    ],
  },
  {
    title: "High-value domains to mine",
    body: [
      "Not all routes are equal. The most valuable routes are on domains that AI agents query most frequently. Developer tools, search engines, social platforms, and business infrastructure generate the highest agent traffic.",
      "GitHub is the most-queried domain in agent workflows. Every coding agent searches repos, reads files, checks issues, and reviews pull requests. GitHub's internal APIs handle repository search, code search, file content retrieval, issue listing, and pull request metadata. A complete index of GitHub's route surface is worth orders of magnitude more than a niche blog.",
      "Google Search, Reddit, StackOverflow, LinkedIn, Stripe, AWS, Hacker News, npm, PyPI — these are the domains where agent traffic concentrates. Each has dozens to hundreds of internal endpoints that power their frontends. Most have never been systematically indexed for machine consumption.",
      "The strategy is straightforward: mine where the agents go. If you were prospecting for gold, you would dig where the geological surveys say gold is. The geological survey for web mining is simple: look at what agents are already trying to do, and index the domains they need.",
    ],
  },
  {
    title: "First-mover advantage: 2x for 30 days",
    body: [
      "The first person to index a domain earns a 2x reward multiplier on all routes from that domain for 30 days. If you are the first to index Stripe's dashboard APIs, you earn $0.007 per resolve instead of $0.0035 for the first month. On a high-traffic domain, that bonus compounds fast.",
      "This creates a land-rush dynamic anchored to real utility. Your 2x bonus only matters if agents actually use the routes. Indexing a dead domain nobody queries earns nothing regardless of the multiplier. The incentive rewards useful work on high-value targets, not speculative squatting.",
      "The 30-day window also solves the cold-start problem. Early contributors take the most risk — they are indexing domains before agent traffic has fully materialized. The 2x multiplier compensates that risk. As the network matures and agent volume grows, the base 70% share becomes the dominant earning driver.",
      "After 30 days, the bonus expires and the domain enters open competition. Anyone can index better routes and capture traffic. First-movers keep earning on their routes as long as those routes remain the highest-quality version in the graph. Quality, not timing, determines long-term earnings.",
    ],
  },
  {
    title: "Getting started",
    body: [
      "Install Unbrowse with one command. No accounts, no API keys, no configuration. The CLI is all you need.",
      "Run your first resolve. Unbrowse will open a browser, navigate to GitHub, capture the search API call, index the route, and return the result. You just mined your first route. That endpoint is now in the shared graph, attributed to you, earning every time an agent uses it.",
      "Go deeper. Browse GitHub's issue pages, pull request views, code search, user profiles. Each page triggers different API endpoints. Each endpoint becomes a new route in the graph. A thorough session on one domain can yield 20 to 50 routes.",
      "Every resolve command you or any agent runs also contributes to the index. If the route is already cached, the resolve is instant and the original contributor earns. If it is not cached, Unbrowse falls back to a browser session, captures the traffic, indexes the routes, and publishes them. The agent itself becomes a contributor. Usage is contribution.",
    ],
  },
  {
    title: "Mining strategies",
    body: [
      "Go deep on one domain before going wide. A complete route surface for one high-value site is worth far more than scattered single-page indexes across hundreds of sites. Agents need complete flows — search, navigate to detail, extract structured data. If you only index the search endpoint but not the detail endpoint, the agent still has to fall back to a browser for the second step.",
      "Authentication flows are the highest-value routes. Any endpoint behind a login wall is expensive for agents to reach through browser automation — they have to manage cookies, handle CAPTCHAs, deal with session expiry. A cleanly indexed authenticated endpoint that handles auth headers properly is rare and commands premium traffic.",
      "GraphQL endpoints are particularly valuable. Many modern apps (GitHub, Reddit, Shopify, Airbnb) use GraphQL internally. A single GraphQL endpoint with the right operation names and variables can replace dozens of REST-style page scrapes. GraphQL routes are underrepresented in the graph because they require POST requests with specific payloads — standard crawlers miss them entirely.",
      "Watch for pagination patterns. An endpoint that returns page 1 of search results is useful. An endpoint with documented cursor or offset parameters that lets agents paginate through all results is far more useful. Index the full parameter space, not just the default call.",
    ],
  },
  {
    title: "The network effect",
    body: [
      "Web mining has a self-reinforcing flywheel. More contributors discover more routes. More routes mean faster, cheaper resolves for agents. Faster, cheaper resolves attract more agents to the network. More agents mean more resolve volume. More resolve volume means more earnings for contributors. More earnings attract more contributors.",
      "This is the same flywheel that made Google Search dominant, but with one critical difference: the value flows to contributors, not to a single corporation. Google's crawlers built the index and Google captured all the ad revenue. In the Unbrowse network, the contributors who build the index earn 70% of every transaction it generates.",
      "The flywheel also creates a quality ratchet. When two contributors index the same domain, the route graph serves the higher-quality version. Low-reliability routes get less traffic. High-reliability routes get more. Contributors are incentivized to maintain and improve their routes over time because stale routes lose traffic to better alternatives. The network self-improves.",
      "At critical mass, the shared route graph becomes the default way agents interact with the web. Every website effectively gets a machine-readable API layer maintained by the community that uses it. That is the endgame: a collectively built, usage-priced index of the entire callable web.",
    ],
  },
  {
    title: "Earnings calculator",
    body: [
      "The math is transparent. Take any domain you want to mine, estimate the agent traffic it receives, and multiply.",
      "Conservative scenario: you index 50 routes on 2 popular domains (100 total routes). Each route averages 20 resolves per day. At $0.0035 per resolve, that is $7 per day, $210 per month, $2,520 per year. With the first-mover 2x bonus on one domain, the first month jumps to $315.",
      "Moderate scenario: you index 100 routes across 5 high-traffic domains. Each route averages 50 resolves per day. That is $17.50 per day, $525 per month, $6,300 per year.",
      "Power contributor scenario: you systematically index 500 routes across 20 domains, focusing on the highest-traffic sites. Each route averages 100 resolves per day. That is $175 per day, $5,250 per month, $63,000 per year.",
      "These are not speculative projections based on token appreciation. They are arithmetic based on usage volume and a fixed fee. If agent traffic grows — and it is growing exponentially as Claude Code, Cursor, Windsurf, and other frameworks gain adoption — every number above scales proportionally.",
    ],
  },
  {
    title: "How this compares to crypto mining",
    body: [
      "Bitcoin mining requires specialized hardware (ASICs), significant electricity costs, and technical infrastructure. The resource being contributed is raw compute — SHA-256 hashes that secure the blockchain but produce nothing reusable. The value comes from scarcity and consensus, not from the utility of the work itself.",
      "Web mining requires a laptop and a web browser. The resource being contributed is knowledge — the discovery and documentation of callable web interfaces. Every unit of mining work produces a real, reusable API route that makes the internet more accessible to machines. The value comes from utility, not from artificial scarcity.",
      "No GPUs. No electricity bill. No mining pools. No hardware depreciation. No noise, no heat, no dedicated facility. You browse the websites you already use. Unbrowse captures the routes in the background. You earn when agents use them. The barrier to entry is npm install.",
      "There is also no Unbrowse token. Earnings are in USDC — a stablecoin pegged to the US dollar. There is no speculative asset to trade, no tokenomics to decode, no governance votes to track. Agents pay for routes. Contributors earn for indexing them. The economics are simple enough to fit on a napkin.",
    ],
  },
  {
    title: "x402: how the money moves",
    body: [
      "Payments use the x402 protocol — HTTP-native micropayments settled in USDC on Solana and Base. When an agent resolves a route, the payment happens inline with the HTTP request. No invoices. No billing cycles. No payment minimums. The agent's wallet signs the payment, the route serves the data, and the contributor's wallet receives the fee. One round trip.",
      "Solana and Base were chosen for fast finality and low gas costs. A $0.005 micropayment cannot work if the transaction fee is $2. On Solana, the settlement cost is a fraction of a cent. The full $0.0035 contributor share arrives in your wallet, not eaten by gas.",
      "Contributors can withdraw earnings to any wallet, swap to fiat through standard off-ramps, or let them accumulate. There is no lockup period, no vesting schedule, no minimum withdrawal. Your earnings are yours the moment agents use your routes.",
    ],
  },
  {
    title: "The research behind it",
    body: [
      "The technical foundations are documented in the peer-reviewed paper \"Internal APIs Are All You Need\" (arXiv:2604.00694). The paper benchmarks 94 live domains and shows a 3.6x mean speedup and 5.4x median speedup over Playwright browser automation, with 90-96% per-task cost reduction for warmed-cache execution.",
      "The shared route graph architecture, discovery tax analysis, three-path execution model (local cache, shared graph, browser fallback), and route-level economics are all covered in detail. The benchmark methodology is open and reproducible.",
      "This is not vaporware backed by a whitepaper. The system works today. Install Unbrowse, run a resolve, and verify the speedup yourself. The routes you discover in the process are real contributions that earn real USDC.",
    ],
  },
];

/* ------------------------------------------------------------------ */
/*  Component                                                          */
/* ------------------------------------------------------------------ */

export default function MineTheInternetPage() {
  const articleSchema = {
    "@context": "https://schema.org",
    "@type": "Article",
    headline: TITLE,
    alternativeHeadline: SUBTITLE,
    description,
    author: {
      "@type": "Person",
      name: AUTHOR.name,
      url: AUTHOR.url,
      affiliation: {
        "@type": "Organization",
        name: AUTHOR.affiliation,
      },
    },
    publisher: {
      "@type": "Organization",
      name: "Unbrowse AI",
      url: "https://www.unbrowse.ai",
      logo: "https://www.unbrowse.ai/logo.png",
    },
    datePublished: PUBLISHED_AT,
    url: `https://www.unbrowse.ai${CANONICAL_PATH}`,
    mainEntityOfPage: {
      "@type": "WebPage",
      "@id": `https://www.unbrowse.ai${CANONICAL_PATH}`,
    },
    keywords: (metadata.keywords as string[]).join(", "),
    isAccessibleForFree: true,
    inLanguage: "en-US",
  };

  const howToSchema = {
    "@context": "https://schema.org",
    "@type": "HowTo",
    name: "How to Mine the Internet with Unbrowse",
    description:
      "Start earning USDC by discovering API routes that AI agents pay to use.",
    step: [
      {
        "@type": "HowToStep",
        name: "Install Unbrowse",
        text: "Run curl -fsSL https://unbrowse.ai/install.sh | bash in your terminal.",
      },
      {
        "@type": "HowToStep",
        name: "Run your first resolve",
        text: 'Run unbrowse resolve "search github for openai" to discover and index your first API route.',
      },
      {
        "@type": "HowToStep",
        name: "Browse high-value domains",
        text: "Visit popular sites like GitHub, Reddit, StackOverflow. Unbrowse captures routes automatically.",
      },
      {
        "@type": "HowToStep",
        name: "Earn when agents use your routes",
        text: "Every time an AI agent resolves a task using a route you discovered, you earn $0.0035 in USDC.",
      },
    ],
  };

  const faqSchema = {
    "@context": "https://schema.org",
    "@type": "FAQPage",
    mainEntity: [
      {
        "@type": "Question",
        name: "What is web mining?",
        acceptedAnswer: {
          "@type": "Answer",
          text: "Web mining is the act of discovering internal website APIs and contributing them to a shared index. With Unbrowse, mining happens automatically as you browse. Routes are captured from network traffic, indexed, and published to a shared graph. When AI agents use those routes, you earn USDC micropayments.",
        },
      },
      {
        "@type": "Question",
        name: "How much can I earn mining the internet?",
        acceptedAnswer: {
          "@type": "Answer",
          text: "You earn $0.0035 per route resolve (70% of the $0.005 fee). A single popular route used 1,000 times per day earns $3.50 daily or $105 monthly. With 100 routes across popular domains averaging 50 resolves each, that is $525 per month. First-movers on new domains earn 2x for 30 days.",
        },
      },
      {
        "@type": "Question",
        name: "Do I need special hardware to mine the internet?",
        acceptedAnswer: {
          "@type": "Answer",
          text: "No. Web mining requires only a laptop and a web browser. There are no GPUs, no mining rigs, no electricity costs. You install Unbrowse with curl -fsSL https://unbrowse.ai/install.sh | bash and browse the web normally. Routes are captured automatically in the background.",
        },
      },
      {
        "@type": "Question",
        name: "How do I get paid for web mining?",
        acceptedAnswer: {
          "@type": "Answer",
          text: "Payments use the x402 protocol — HTTP-native micropayments settled in USDC on Solana and Base. When an AI agent uses your route, the payment happens inline with the HTTP request. No invoices, no billing cycles. Earnings arrive in your wallet in real time.",
        },
      },
      {
        "@type": "Question",
        name: "What domains should I mine first?",
        acceptedAnswer: {
          "@type": "Answer",
          text: "Focus on domains with high AI agent traffic: GitHub, Google, Reddit, StackOverflow, LinkedIn, Stripe, AWS, Hacker News, npm, and PyPI. Developer tools and search engines generate the most agent queries. The first contributor to index a domain earns a 2x bonus for 30 days.",
        },
      },
    ],
  };

  return (
    <div className="bg-surface min-h-screen text-text-primary">
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(articleSchema) }}
      />
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(howToSchema) }}
      />
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(faqSchema) }}
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
            Guide
          </p>
          <h1 className="text-4xl sm:text-6xl font-bold tracking-tight text-balance leading-tight">
            {TITLE}
          </h1>
          <p className="mt-4 text-xl sm:text-2xl text-text-secondary font-medium text-balance">
            {SUBTITLE}
          </p>
          <div className="mt-8 text-sm sm:text-base text-text-secondary">
            <div className="font-semibold text-text-primary">
              {AUTHOR.name}
            </div>
            <div>{AUTHOR.affiliation}</div>
            <div className="mt-2 text-text-secondary/60">{PUBLISHED_AT}</div>
          </div>
        </header>

        {/* Lede */}
        <section className="mb-12">
          <p className="text-base sm:text-lg leading-8 text-text-secondary">
            {description}
          </p>
        </section>

        {/* Key numbers */}
        <section className="mb-12 rounded-2xl border border-orange-500/20 bg-orange-50/50 dark:bg-orange-950/20 p-6 sm:p-8">
          <h2 className="text-2xl font-semibold tracking-tight mb-4">
            The economics at a glance
          </h2>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-6 text-base sm:text-lg">
            <div>
              <div className="text-3xl font-bold text-orange-600">70%</div>
              <div className="text-text-secondary mt-1">
                Revenue share to route creators
              </div>
            </div>
            <div>
              <div className="text-3xl font-bold text-orange-600">$0.005</div>
              <div className="text-text-secondary mt-1">
                Cost per cached resolve
              </div>
            </div>
            <div>
              <div className="text-3xl font-bold text-orange-600">2x</div>
              <div className="text-text-secondary mt-1">
                First-mover bonus for 30 days
              </div>
            </div>
            <div>
              <div className="text-3xl font-bold text-text-primary">$0.53</div>
              <div className="text-text-secondary mt-1">
                Cost per browser-based resolve
              </div>
            </div>
            <div>
              <div className="text-3xl font-bold text-text-primary">106x</div>
              <div className="text-text-secondary mt-1">
                Cost reduction vs browser automation
              </div>
            </div>
            <div>
              <div className="text-3xl font-bold text-text-primary">0</div>
              <div className="text-text-secondary mt-1">
                GPUs, tokens, or staking required
              </div>
            </div>
          </div>
        </section>

        {/* Quick start box */}
        <section className="mb-12 rounded-2xl border border-border bg-surface-sunken p-6 sm:p-8">
          <h2 className="text-2xl font-semibold tracking-tight mb-4">
            Mine your first route in 60 seconds
          </h2>
          <div className="space-y-3">
            <div className="rounded-lg bg-surface border border-border p-4 font-mono text-sm sm:text-base">
              <span className="text-text-secondary/60 select-none">$ </span>
              <span className="text-orange-600">curl -fsSL https://unbrowse.ai/install.sh | bash</span>
            </div>
            <div className="rounded-lg bg-surface border border-border p-4 font-mono text-sm sm:text-base">
              <span className="text-text-secondary/60 select-none">$ </span>
              <span className="text-orange-600">
                unbrowse resolve &quot;search github for openai&quot;
              </span>
            </div>
          </div>
          <p className="mt-4 text-sm sm:text-base text-text-secondary">
            That is it. Unbrowse opened a browser, navigated to GitHub, captured
            the search API, indexed the route, and returned the result. The
            endpoint is now in the shared graph, attributed to you, earning
            every time an agent uses it.
          </p>
        </section>

        {/* Body sections */}
        <section className="space-y-10 mb-12">
          {sections.map((section) => (
            <div key={section.title}>
              <h2 className="text-2xl font-semibold tracking-tight mb-3">
                {section.title}
              </h2>
              {section.body.map((paragraph, i) => (
                <p
                  key={i}
                  className="text-base sm:text-lg leading-8 text-text-secondary mb-4 last:mb-0"
                >
                  {paragraph}
                </p>
              ))}
            </div>
          ))}
        </section>

        {/* Earnings table */}
        <section className="mb-12 overflow-x-auto">
          <h2 className="text-2xl font-semibold tracking-tight mb-4">
            Earnings by mining intensity
          </h2>
          <table className="w-full text-sm sm:text-base border-collapse">
            <thead>
              <tr className="border-b border-border text-left">
                <th className="py-3 pr-4 font-semibold text-text-primary">
                  Strategy
                </th>
                <th className="py-3 pr-4 font-semibold text-text-primary">
                  Routes indexed
                </th>
                <th className="py-3 pr-4 font-semibold text-text-primary">
                  Avg resolves/day/route
                </th>
                <th className="py-3 pr-4 font-semibold text-text-primary">
                  Monthly earnings
                </th>
                <th className="py-3 font-semibold text-text-primary">
                  Annual earnings
                </th>
              </tr>
            </thead>
            <tbody className="text-text-secondary">
              <tr className="border-b border-border/50">
                <td className="py-3 pr-4">Casual</td>
                <td className="py-3 pr-4">100</td>
                <td className="py-3 pr-4">20</td>
                <td className="py-3 pr-4">$210</td>
                <td className="py-3">$2,520</td>
              </tr>
              <tr className="border-b border-border/50">
                <td className="py-3 pr-4">Focused</td>
                <td className="py-3 pr-4">250</td>
                <td className="py-3 pr-4">50</td>
                <td className="py-3 pr-4">$1,312</td>
                <td className="py-3">$15,750</td>
              </tr>
              <tr className="border-b border-border/50">
                <td className="py-3 pr-4">Power contributor</td>
                <td className="py-3 pr-4">500</td>
                <td className="py-3 pr-4">100</td>
                <td className="py-3 pr-4">$5,250</td>
                <td className="py-3">$63,000</td>
              </tr>
              <tr>
                <td className="py-3 pr-4">Network operator</td>
                <td className="py-3 pr-4">2,000</td>
                <td className="py-3 pr-4">200</td>
                <td className="py-3 pr-4">$42,000</td>
                <td className="py-3">$504,000</td>
              </tr>
            </tbody>
          </table>
          <p className="mt-3 text-sm text-text-secondary/60">
            At $0.0035 contributor share per resolve. First-mover 2x bonus not
            included. Actual earnings depend on route quality and domain
            traffic.
          </p>
        </section>

        {/* Network economics table */}
        <section className="mb-12 overflow-x-auto">
          <h2 className="text-2xl font-semibold tracking-tight mb-4">
            Network economics at scale
          </h2>
          <table className="w-full text-sm sm:text-base border-collapse">
            <thead>
              <tr className="border-b border-border text-left">
                <th className="py-3 pr-4 font-semibold text-text-primary">
                  Network agents
                </th>
                <th className="py-3 pr-4 font-semibold text-text-primary">
                  Daily resolves
                </th>
                <th className="py-3 pr-4 font-semibold text-text-primary">
                  Daily payout (all contributors)
                </th>
                <th className="py-3 font-semibold text-text-primary">
                  Annual payout
                </th>
              </tr>
            </thead>
            <tbody className="text-text-secondary">
              <tr className="border-b border-border/50">
                <td className="py-3 pr-4">1,000</td>
                <td className="py-3 pr-4">100,000</td>
                <td className="py-3 pr-4">$350</td>
                <td className="py-3">$127,750</td>
              </tr>
              <tr className="border-b border-border/50">
                <td className="py-3 pr-4">10,000</td>
                <td className="py-3 pr-4">1,000,000</td>
                <td className="py-3 pr-4">$3,500</td>
                <td className="py-3">$1,277,500</td>
              </tr>
              <tr className="border-b border-border/50">
                <td className="py-3 pr-4">100,000</td>
                <td className="py-3 pr-4">10,000,000</td>
                <td className="py-3 pr-4">$35,000</td>
                <td className="py-3">$12,775,000</td>
              </tr>
              <tr>
                <td className="py-3 pr-4">1,000,000</td>
                <td className="py-3 pr-4">100,000,000</td>
                <td className="py-3 pr-4">$350,000</td>
                <td className="py-3">$127,750,000</td>
              </tr>
            </tbody>
          </table>
          <p className="mt-3 text-sm text-text-secondary/60">
            Assumes 100 resolves per agent per day at $0.005 per resolve. Payout
            reflects the 70% contributor share.
          </p>
        </section>

        {/* CTA */}
        <section className="rounded-2xl border border-orange-500/20 bg-orange-50/50 dark:bg-orange-950/20 p-6 sm:p-8">
          <h2 className="text-2xl font-semibold tracking-tight mb-3">
            Start mining
          </h2>
          <p className="text-base sm:text-lg leading-8 text-text-secondary mb-6">
            Install Unbrowse, browse the web, and earn when agents use the
            routes you discover. No GPUs. No staking. No tokens. Just USDC for
            useful work.
          </p>
          <div className="rounded-lg bg-surface-sunken border border-border p-4 font-mono text-sm sm:text-base mb-6">
            <span className="text-text-secondary/60 select-none">$ </span>
            <span className="text-orange-600">curl -fsSL https://unbrowse.ai/install.sh | bash</span>
          </div>
          <div className="flex flex-col sm:flex-row gap-3">
            <a
              href="https://github.com/unbrowse-ai/unbrowse"
              target="_blank"
              rel="noopener"
              className="inline-flex items-center justify-center rounded-lg bg-orange-500 px-5 py-3 font-medium text-white hover:bg-orange-600 transition-colors"
            >
              View on GitHub
            </a>
            <a
              href="https://www.npmjs.com/package/unbrowse"
              target="_blank"
              rel="noopener"
              className="inline-flex items-center justify-center rounded-lg border border-border bg-surface-sunken px-5 py-3 font-medium text-text-primary hover:border-orange-500/30 hover:bg-orange-50/40 transition-colors"
            >
              View on npm
            </a>
            <Link
              href="/proof-of-indexing"
              className="inline-flex items-center justify-center rounded-lg border border-border bg-surface-sunken px-5 py-3 font-medium text-text-primary hover:border-orange-500/30 hover:bg-orange-50/40 transition-colors"
            >
              Proof of Indexing
            </Link>
            <Link
              href="/internal-apis-are-all-you-need"
              className="inline-flex items-center justify-center rounded-lg border border-border bg-surface-sunken px-5 py-3 font-medium text-text-primary hover:border-orange-500/30 hover:bg-orange-50/40 transition-colors"
            >
              Read the whitepaper
            </Link>
          </div>
        </section>
      </article>
    </div>
  );
}
