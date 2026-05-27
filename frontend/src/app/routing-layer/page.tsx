import type { Metadata } from "next";
import Link from "next/link";

const TITLE = "Google Indexed the Web for Humans. Who Indexes It for Agents?";
const SUBTITLE = "The Routing Layer of the Agentic Internet";
const CANONICAL_PATH = "/routing-layer";
const PUBLISHED_AT = "2026-04-02";
const ARXIV_URL = "https://arxiv.org/abs/2604.00694";

const description = `Google captured $2T in value by indexing HTML pages for human eyeballs. The agentic web — where AI agents interact with websites on behalf of humans — is growing exponentially and needs its own index. Not an index of pages, but an index of machine-readable API routes. Unbrowse is building it, collectively, through proof of indexing.`;

export const metadata: Metadata = {
  title: `${TITLE} | Unbrowse`,
  description,
  alternates: {
    canonical: `https://www.unbrowse.ai${CANONICAL_PATH}`,
  },
  authors: [{ name: "Lewis Tham", url: "https://www.unbrowse.ai" }],
  openGraph: {
    title: `${TITLE}`,
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
        alt: "The Routing Layer of the Agentic Internet",
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
    "agentic web",
    "AI agent infrastructure",
    "web index for AI",
    "routing layer",
    "shared route graph",
    "proof of indexing",
    "API discovery",
    "Unbrowse",
    "machine-readable web",
    "agent-native browser",
    "agent micropayments",
    "network effects",
  ],
};

export default function RoutingLayerPage() {
  const articleSchema = {
    "@context": "https://schema.org",
    "@type": "Article",
    headline: TITLE,
    alternativeHeadline: SUBTITLE,
    description,
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
    sameAs: [ARXIV_URL],
    about: [
      "Agentic web infrastructure",
      "AI agent routing",
      "Shared route graph",
      "Web index for AI agents",
      "Proof of indexing",
    ],
    keywords: metadata.keywords,
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
            Thesis
          </p>
          <h1 className="text-4xl sm:text-6xl font-bold tracking-tight text-balance leading-tight">
            {TITLE}
          </h1>
          <p className="mt-4 text-xl sm:text-2xl text-text-secondary font-medium text-balance">
            {SUBTITLE}
          </p>
          <div className="mt-6 text-sm text-text-secondary">
            <span className="font-semibold text-text-primary">Lewis Tham</span>
            <span className="mx-2">/</span>
            <time dateTime={PUBLISHED_AT}>April 2026</time>
          </div>
        </header>

        {/* --- Lede --- */}
        <section className="mb-12">
          <p className="text-base sm:text-lg leading-8 text-text-secondary">
            In 1998, two Stanford PhD students observed that the web was growing
            faster than any human could navigate it. Pages were multiplying by
            the millions. The information was there, but finding it was the
            bottleneck. They built an index &mdash; a map of the web organized by
            relevance &mdash; and that index became Google. It captured over $2
            trillion in value by solving a single problem:{" "}
            <strong className="text-text-primary">
              helping humans find what they need on the web.
            </strong>
          </p>
          <p className="mt-6 text-base sm:text-lg leading-8 text-text-secondary">
            Today, a new class of web user is emerging. Not humans &mdash;
            agents. AI agents that browse websites, extract data, fill out forms,
            and complete tasks on behalf of people. They are the fastest-growing
            category in software. OpenClaw has 344K GitHub stars. Claude Code, GPT
            agents, Cursor, Windsurf &mdash; millions of developers are building
            with autonomous agents that interact with the web every day.
          </p>
          <p className="mt-6 text-base sm:text-lg leading-8 text-text-secondary">
            These agents face the same bottleneck humans faced in 1998:{" "}
            <strong className="text-text-primary">
              the web has no index for them.
            </strong>
          </p>
        </section>

        {/* --- The wrong index --- */}
        <section className="mb-12">
          <h2 className="text-2xl font-semibold tracking-tight mb-4">
            Google&rsquo;s index is for human eyes
          </h2>
          <p className="text-base sm:text-lg leading-8 text-text-secondary">
            Google indexes HTML. It crawls pages, parses text, ranks relevance,
            and returns links that humans click. The entire pipeline assumes a
            human on the other end: someone who reads a snippet, clicks a blue
            link, scans a page, and extracts what they need visually.
          </p>
          <p className="mt-6 text-base sm:text-lg leading-8 text-text-secondary">
            Agents do not work this way. When an agent needs the price of a
            flight on United, it does not need a rendered page with hero images,
            navigation bars, and cookie consent banners. It needs a JSON object:{" "}
            <code className="text-sm bg-surface-sunken px-2 py-0.5 rounded font-mono">
              {"{ \"price\": 342, \"currency\": \"USD\", \"route\": \"SFO-NRT\" }"}
            </code>
            . That object already exists &mdash; it is the response from the
            internal API call that United&rsquo;s frontend makes to render the
            page. The data was structured before it became HTML. The HTML is a
            human convenience layer.
          </p>
          <p className="mt-6 text-base sm:text-lg leading-8 text-text-secondary">
            Google indexes the human convenience layer. Nobody indexes the
            machine-readable layer underneath it.
          </p>
        </section>

        {/* --- The discovery tax --- */}
        <section className="mb-12">
          <h2 className="text-2xl font-semibold tracking-tight mb-4">
            The discovery tax
          </h2>
          <p className="text-base sm:text-lg leading-8 text-text-secondary">
            Every time an agent visits a website today, it pays a{" "}
            <em>discovery tax</em>. It has to figure out, from scratch, how to
            get the data it needs. Open a headless browser. Render the page.
            Parse the DOM. Find the right button. Click it. Wait. Parse again.
            Extract text from pixels. This process takes 5 to 30 seconds and
            burns thousands of LLM tokens &mdash; per page, per visit.
          </p>
          <p className="mt-6 text-base sm:text-lg leading-8 text-text-secondary">
            Worse, every agent pays this tax independently. If a thousand agents
            need Airbnb pricing data today, a thousand agents will each spend 30
            seconds reverse-engineering the same page structure, finding the same
            API endpoints, and parsing the same response formats. The collective
            waste is staggering. Millions of redundant browser sessions. Billions
            of wasted tokens. All because there is no shared memory of what was
            already discovered.
          </p>
          <p className="mt-6 text-base sm:text-lg leading-8 text-text-secondary">
            Our paper,{" "}
            <a
              href={ARXIV_URL}
              target="_blank"
              rel="noopener"
              className="text-orange-600 hover:text-orange-500 font-medium"
            >
              Internal APIs Are All You Need
            </a>
            , benchmarks this across 94 live domains. The numbers are stark:
            browser-automated agents average 3,404 ms per task. Agents with
            access to cached routes average 950 ms &mdash; a 3.6x speedup and
            90&ndash;96% cost reduction. The discovery tax is not a minor
            inefficiency. It is the dominant cost of agentic web interaction.
          </p>
        </section>

        {/* --- What agents actually need --- */}
        <section className="mb-12">
          <h2 className="text-2xl font-semibold tracking-tight mb-4">
            What the agentic web actually needs
          </h2>
          <p className="text-base sm:text-lg leading-8 text-text-secondary">
            The agentic web needs what the human web got in 1998: an index. But a
            fundamentally different kind.
          </p>
          <div className="mt-6 overflow-x-auto">
            <table className="w-full text-sm sm:text-base text-text-secondary border-collapse">
              <thead>
                <tr className="border-b border-border text-left">
                  <th className="py-3 pr-6 font-semibold text-text-primary" />
                  <th className="py-3 pr-6 font-semibold text-text-primary">
                    Human web index
                  </th>
                  <th className="py-3 font-semibold text-text-primary">
                    Agent web index
                  </th>
                </tr>
              </thead>
              <tbody>
                <tr className="border-b border-border/50">
                  <td className="py-3 pr-6 font-medium text-text-primary">
                    Unit of indexing
                  </td>
                  <td className="py-3 pr-6">HTML pages</td>
                  <td className="py-3">API routes (endpoints + schemas)</td>
                </tr>
                <tr className="border-b border-border/50">
                  <td className="py-3 pr-6 font-medium text-text-primary">
                    Consumer
                  </td>
                  <td className="py-3 pr-6">Human eyeballs</td>
                  <td className="py-3">HTTP clients (agents)</td>
                </tr>
                <tr className="border-b border-border/50">
                  <td className="py-3 pr-6 font-medium text-text-primary">
                    Output format
                  </td>
                  <td className="py-3 pr-6">Ranked links + snippets</td>
                  <td className="py-3">Callable routes + structured data</td>
                </tr>
                <tr className="border-b border-border/50">
                  <td className="py-3 pr-6 font-medium text-text-primary">
                    Discovery method
                  </td>
                  <td className="py-3 pr-6">Crawling public HTML</td>
                  <td className="py-3">
                    Passive traffic capture from real usage
                  </td>
                </tr>
                <tr>
                  <td className="py-3 pr-6 font-medium text-text-primary">
                    Freshness
                  </td>
                  <td className="py-3 pr-6">Periodic recrawl</td>
                  <td className="py-3">
                    Continuous &mdash; every agent session updates the graph
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
          <p className="mt-6 text-base sm:text-lg leading-8 text-text-secondary">
            Google&rsquo;s index maps URLs to relevance scores. The agent index
            maps domains to callable routes &mdash; complete with endpoint URLs,
            request schemas, authentication patterns, and response structures. An
            agent does not search this index the way a human searches Google. It
            resolves an intent (&ldquo;get Airbnb pricing for Tokyo&rdquo;) and
            gets back a ready-to-call API route, or a prioritized shortlist of
            candidate routes.
          </p>
        </section>

        {/* --- Building it collectively --- */}
        <section className="mb-12">
          <h2 className="text-2xl font-semibold tracking-tight mb-4">
            Building the index collectively
          </h2>
          <p className="text-base sm:text-lg leading-8 text-text-secondary">
            Google built its index with crawlers &mdash; automated bots that
            systematically visit every page on the web. That approach does not
            work for API routes. Internal APIs are not linked from sitemaps. They
            are not exposed in HTML. They are hidden behind JavaScript execution,
            authentication walls, and dynamic rendering. You cannot crawl them.
            You can only observe them in use.
          </p>
          <p className="mt-6 text-base sm:text-lg leading-8 text-text-secondary">
            Unbrowse builds the index differently: through{" "}
            <strong className="text-text-primary">
              passive observation of real agent traffic
            </strong>
            . When any agent browses a website through Unbrowse, the network
            traffic is captured, the API endpoints are reverse-engineered, their
            schemas are extracted, and the routes are published to a shared
            graph. The agent that discovered the route gets credit. Every agent
            that uses the route afterward pays a micro-fee that flows back to the
            discoverer.
          </p>
          <p className="mt-6 text-base sm:text-lg leading-8 text-text-secondary">
            We call this{" "}
            <strong className="text-text-primary">proof of indexing</strong>. It
            is a contribution model where the act of using the web as an agent
            produces value for the entire network. No manual curation. No
            centralized crawling team. The index grows organically, driven by
            real demand. Routes that agents actually need get discovered first,
            because agents discover them by needing them.
          </p>
        </section>

        {/* --- Network effects --- */}
        <section className="mb-12">
          <h2 className="text-2xl font-semibold tracking-tight mb-4">
            The network effect
          </h2>
          <p className="text-base sm:text-lg leading-8 text-text-secondary">
            This is where the economics get interesting.
          </p>
          <p className="mt-6 text-base sm:text-lg leading-8 text-text-secondary">
            Every agent that joins the network makes the index more valuable.
            More agents means more browsing sessions. More sessions means more
            routes discovered. More routes means faster resolves for every agent.
            Faster resolves attract more agents. The flywheel is
            self-reinforcing.
          </p>
          <div className="mt-6 rounded-2xl border border-border bg-surface-sunken p-6 sm:p-8 font-mono text-sm sm:text-base text-text-secondary leading-relaxed">
            <p className="text-center">More agents</p>
            <p className="text-center text-orange-600">&darr;</p>
            <p className="text-center">More routes discovered</p>
            <p className="text-center text-orange-600">&darr;</p>
            <p className="text-center">Higher cache hit rate</p>
            <p className="text-center text-orange-600">&darr;</p>
            <p className="text-center">Faster, cheaper resolves</p>
            <p className="text-center text-orange-600">&darr;</p>
            <p className="text-center">More agents join</p>
          </div>
          <p className="mt-6 text-base sm:text-lg leading-8 text-text-secondary">
            Google had the same dynamic. More users searching meant more click
            data. More click data meant better rankings. Better rankings
            attracted more users. But Google&rsquo;s flywheel was powered by
            humans clicking links. Unbrowse&rsquo;s flywheel is powered by
            agents calling APIs. The cycle time is orders of magnitude faster,
            because agents operate at machine speed.
          </p>
        </section>

        {/* --- Economics --- */}
        <section className="mb-12">
          <h2 className="text-2xl font-semibold tracking-tight mb-4">
            Route-level economics
          </h2>
          <p className="text-base sm:text-lg leading-8 text-text-secondary">
            Google monetizes at the query level: advertisers pay per click on
            search results. Unbrowse monetizes at the route level: agents pay per
            use of a cached route. The difference matters because routes have
            transparent, measurable value. A cached route that saves an agent 12
            seconds and 8,000 tokens is worth a specific, calculable amount.
            There is no ambiguity about the value delivered.
          </p>
          <p className="mt-6 text-base sm:text-lg leading-8 text-text-secondary">
            Route fees are settled with HTTP-native micropayments &mdash; the
            cost of a route is embedded in the request itself, paid from the
            agent's wallet. An agent evaluates whether the route fee is lower than the
            expected cost of rediscovery. If yes, it pays the fee and gets
            instant structured data. If no, it falls back to browser-based
            discovery. The market is self-correcting: overpriced routes get
            bypassed, underpriced routes attract volume.
          </p>
          <p className="mt-6 text-base sm:text-lg leading-8 text-text-secondary">
            Contributors earn proportionally to the value their routes generate.
            Discover a high-traffic route &mdash; say, Amazon product pricing
            &mdash; and you earn every time an agent uses it. The incentive
            structure aligns contribution with actual utility, not speculation.
          </p>
        </section>

        {/* --- Why now --- */}
        <section className="mb-12">
          <h2 className="text-2xl font-semibold tracking-tight mb-4">
            Why now
          </h2>
          <p className="text-base sm:text-lg leading-8 text-text-secondary">
            Three things had to be true for this to work, and all three became
            true in the past 18 months.
          </p>
          <div className="mt-6 space-y-6">
            <div>
              <h3 className="text-lg font-semibold text-text-primary mb-2">
                1. Agents became real users of the web
              </h3>
              <p className="text-base sm:text-lg leading-8 text-text-secondary">
                Before 2025, AI agents were demos. Now they are production
                infrastructure. Claude Code writes and deploys software. GPT
                agents manage workflows. OpenClaw orchestrates multi-step tasks
                across dozens of websites. Agents are not a hypothetical user
                base &mdash; they are already here, already browsing, already
                paying the discovery tax millions of times per day.
              </p>
            </div>
            <div>
              <h3 className="text-lg font-semibold text-text-primary mb-2">
                2. Micropayments became protocol-native
              </h3>
              <p className="text-base sm:text-lg leading-8 text-text-secondary">
                HTTP-level micropayments now let a server price a route and a
                client pay for it in the same request-response cycle, signed by
                the agent's wallet. No subscriptions. No API keys. No billing dashboards.
                This makes per-route pricing viable at scale, which is what
                allows the contribution incentive to work.
              </p>
            </div>
            <div>
              <h3 className="text-lg font-semibold text-text-primary mb-2">
                3. The browser runtime shrank to near-zero
              </h3>
              <p className="text-base sm:text-lg leading-8 text-text-secondary">
                Kuri, the Zig-native CDP broker that powers Unbrowse, is 464 KB
                with a 3 ms cold start. It makes browser-based discovery cheap
                enough to use as a fallback. The three-path execution model
                &mdash; local cache, shared graph, or browser fallback &mdash;
                only works when the fallback is fast enough that agents do not
                avoid it.
              </p>
            </div>
          </div>
        </section>

        {/* --- The opportunity --- */}
        <section className="mb-12">
          <h2 className="text-2xl font-semibold tracking-tight mb-4">
            The infrastructure opportunity
          </h2>
          <p className="text-base sm:text-lg leading-8 text-text-secondary">
            Google is a $2 trillion company because it owns the routing layer
            between humans and information. It does not own the websites. It does
            not own the content. It owns the index &mdash; the map that tells you
            where to go. Whoever builds the equivalent index for the agentic web
            captures the routing layer between agents and the machine-readable
            internet.
          </p>
          <p className="mt-6 text-base sm:text-lg leading-8 text-text-secondary">
            This is not a feature. It is not a product. It is infrastructure. The
            kind of infrastructure that, once established, becomes the default
            path. Every agent that needs web data will either discover routes
            independently (slow, expensive, redundant) or consult the shared
            index (fast, cheap, improving). The economics always converge on the
            index.
          </p>
          <p className="mt-6 text-base sm:text-lg leading-8 text-text-secondary">
            We are early. The index today covers hundreds of domains and
            thousands of routes. The web has billions of both. But Google started
            with a graduate project indexing a fraction of the web, and the
            network effects did the rest. The same dynamics apply here, except
            the agents contributing to the index never sleep, never slow down,
            and operate at a pace no human crawler ever could.
          </p>
        </section>

        {/* --- CTA --- */}
        <section className="mb-12 rounded-2xl border border-orange-500/20 bg-orange-50/50 p-6 sm:p-8">
          <h2 className="text-2xl font-semibold tracking-tight mb-3">
            Contribute to the index
          </h2>
          <p className="text-base sm:text-lg leading-8 text-text-secondary mb-6">
            The index is being built right now, by agents and developers around
            the world. Every browsing session that discovers a new route makes
            the network more valuable for everyone. Read the paper, install
            Unbrowse, and start contributing.
          </p>
          <div className="flex flex-col sm:flex-row gap-3">
            <a
              href={ARXIV_URL}
              target="_blank"
              rel="noopener"
              className="inline-flex items-center justify-center rounded-lg bg-orange-500 px-5 py-3 font-medium text-white hover:bg-orange-600 transition-colors"
            >
              Read the paper on arXiv
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
          <p className="mt-4 text-sm text-text-secondary font-mono">
            curl -fsSL https://unbrowse.ai/install.sh | bash
          </p>
        </section>

        <footer className="border-t border-border pt-8 text-sm text-text-secondary">
          <p>
            <a
              href={ARXIV_URL}
              target="_blank"
              rel="noopener"
              className="text-orange-600 hover:text-orange-500"
            >
              Internal APIs Are All You Need
            </a>{" "}
            &mdash; Tham, Garcia, Hahn. arXiv 2604.00694, 2026.
          </p>
        </footer>
      </article>
    </div>
  );
}
