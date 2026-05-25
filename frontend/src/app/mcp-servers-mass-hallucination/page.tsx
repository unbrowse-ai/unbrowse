import type { Metadata } from "next";
import Link from "next/link";

const TITLE = "Every MCP Server Is a Mass Hallucination";
const SUBTITLE = "10,000 hand-written API wrappers. 99% of the web still uncovered. The APIs already exist — we just keep ignoring them.";
const CANONICAL_PATH = "/mcp-servers-mass-hallucination";
const PUBLISHED_AT = "2026-04-02";
const AUTHOR = {
  name: "Lewis Tham",
  role: "Founder, Unbrowse AI",
};

const description = `There are 10,000+ MCP servers on GitHub. Each is a hand-written wrapper around one API. But most websites don't have official APIs, and the ones that do change constantly. The entire approach doesn't scale. The APIs are already there — they're the internal endpoints every website calls behind its UI. Unbrowse discovers them automatically.`;

export const metadata: Metadata = {
  title: `${TITLE} | Unbrowse`,
  description,
  alternates: {
    canonical: `https://www.unbrowse.ai${CANONICAL_PATH}`,
  },
  authors: [{ name: AUTHOR.name }],
  openGraph: {
    title: TITLE,
    description,
    url: `https://www.unbrowse.ai${CANONICAL_PATH}`,
    siteName: "Unbrowse",
    type: "article",
    publishedTime: PUBLISHED_AT,
    authors: [AUTHOR.name],
    images: [
      {
        url: "https://www.unbrowse.ai/og-image.png",
        alt: "Unbrowse — The API layer for AI agents",
      },
    ],
  },
  twitter: {
    card: "summary_large_image",
    site: "@unbrowse",
    title: TITLE,
    description,
    images: ["https://www.unbrowse.ai/og-image.png"],
  },
  keywords: [
    "MCP servers",
    "Model Context Protocol",
    "API wrappers",
    "internal APIs",
    "shadow APIs",
    "web agents",
    "Unbrowse",
    "API discovery",
    "agent tools",
    "agentic web",
    "MCP server ecosystem",
    "browser automation",
  ],
};

export default function McpMassHallucinationPage() {
  const articleSchema = {
    "@context": "https://schema.org",
    "@type": "BlogPosting",
    headline: TITLE,
    description,
    author: {
      "@type": "Person",
      name: AUTHOR.name,
      jobTitle: AUTHOR.role,
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
    keywords: (metadata.keywords as string[]).join(", "),
    isAccessibleForFree: true,
    inLanguage: "en-US",
  };

  return (
    <div className="bg-surface min-h-screen text-text-primary">
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(articleSchema) }}
      />

      <article className="max-w-3xl mx-auto px-4 sm:px-6 py-16 sm:py-24">
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
            Blog
          </p>
          <h1 className="text-4xl sm:text-5xl font-bold tracking-tight text-balance leading-tight">
            {TITLE}
          </h1>
          <p className="mt-4 text-lg sm:text-xl text-text-secondary font-medium text-balance">
            {SUBTITLE}
          </p>
          <div className="mt-6 text-sm text-text-secondary">
            <span className="font-semibold text-text-primary">{AUTHOR.name}</span>
            <span className="mx-2">&middot;</span>
            <time dateTime={PUBLISHED_AT}>April 2, 2026</time>
          </div>
        </header>

        {/* --- The Hallucination --- */}
        <section className="mb-10">
          <p className="text-base sm:text-lg leading-8 text-text-secondary">
            Open GitHub and search for &ldquo;MCP server.&rdquo; You will find over ten thousand repositories. Each one is a hand-written wrapper around a single API. There is an MCP server for Stripe, one for Notion, one for Jira, one for Linear, one for GitHub, one for Slack. Someone wrote one for Hacker News. Someone else wrote a different one for Hacker News.
          </p>
          <p className="text-base sm:text-lg leading-8 text-text-secondary mt-4">
            It is one of the largest collective engineering efforts in the AI tool ecosystem. And it is almost entirely a waste of time.
          </p>
        </section>

        {/* --- The Problem Statement --- */}
        <section className="mb-10">
          <h2 className="text-2xl font-semibold tracking-tight mb-4">The wrapper treadmill</h2>
          <p className="text-base sm:text-lg leading-8 text-text-secondary">
            The thesis behind MCP servers is straightforward: agents need structured tools, APIs provide structured interfaces, so we write wrappers that expose APIs as tools. Reasonable in theory. Broken in practice, for three reasons.
          </p>
          <ol className="mt-4 space-y-4 text-base sm:text-lg leading-8 text-text-secondary list-decimal pl-6">
            <li>
              <strong className="text-text-primary">Most of the web has no official API.</strong>{" "}
              The ten thousand MCP servers on GitHub cover maybe a few hundred services. There are hundreds of millions of websites. The overwhelming majority have zero documented API. No OpenAPI spec. No developer portal. No API key signup page. The entire MCP approach silently assumes the API exists and is documented. For 99% of the web, it does not.
            </li>
            <li>
              <strong className="text-text-primary">The APIs that exist change constantly.</strong>{" "}
              Stripe changes its API versioning. Notion adds new block types. Jira restructures its REST endpoints. Every change breaks the wrapper. Every broken wrapper requires a human to notice, diagnose, and fix. Multiply that by ten thousand repositories maintained by volunteers with day jobs. The median MCP server on GitHub has not been updated in months. Many are already broken.
            </li>
            <li>
              <strong className="text-text-primary">You cannot write your way to coverage.</strong>{" "}
              Even if every wrapper were perfect, the approach requires one hand-written integration per service. That is a linear scaling function against a web that grows exponentially. You will never catch up. You will never cover the long tail. You will certainly never cover the internal tools, admin panels, and niche SaaS products where agents could deliver the most value.
            </li>
          </ol>
        </section>

        {/* --- The Insight --- */}
        <section className="mb-10">
          <h2 className="text-2xl font-semibold tracking-tight mb-4">The APIs already exist</h2>
          <p className="text-base sm:text-lg leading-8 text-text-secondary">
            Here is the part that makes the MCP server treadmill especially absurd: every website already has APIs. They are the internal endpoints that power the UI.
          </p>
          <p className="text-base sm:text-lg leading-8 text-text-secondary mt-4">
            When you load a Reddit thread, your browser does not receive a pre-rendered HTML document. It calls <code className="text-sm bg-surface-sunken px-1.5 py-0.5 rounded font-mono">GET /api/v1/comments/t3_abc123</code> and gets back JSON. When you search Airbnb, your browser calls <code className="text-sm bg-surface-sunken px-1.5 py-0.5 rounded font-mono">GET /api/v3/StaysSearch</code>. When you check your bank balance, your browser calls an internal REST endpoint that returns structured account data.
          </p>
          <p className="text-base sm:text-lg leading-8 text-text-secondary mt-4">
            These are not theoretical APIs. They are production APIs that handle millions of requests per day. They have authentication. They have rate limits. They have schemas. They are the most battle-tested interfaces on the internet. The only difference from a &ldquo;public API&rdquo; is that nobody wrote documentation for them.
          </p>
          <p className="text-base sm:text-lg leading-8 text-text-secondary mt-4">
            The MCP ecosystem is an enormous effort to hand-write wrappers for the tiny fraction of the web that publishes API docs. Meanwhile, the actual API layer that powers the entire web sits right there, undiscovered, behind every single website.
          </p>
        </section>

        {/* --- What if you just... discovered them? --- */}
        <section className="mb-10">
          <h2 className="text-2xl font-semibold tracking-tight mb-4">What if you just discovered them?</h2>
          <p className="text-base sm:text-lg leading-8 text-text-secondary">
            This is the question we started with at Unbrowse. Instead of writing one wrapper per service, what if agents could discover the internal APIs automatically, from real browsing traffic?
          </p>
          <p className="text-base sm:text-lg leading-8 text-text-secondary mt-4">
            The approach is simple. Browse a website normally. Capture the network traffic. Extract the API endpoints, their request schemas, authentication headers, and response structures. Publish them as reusable skills. Every future agent on the network skips the discovery step entirely and calls the API directly.
          </p>
          <p className="text-base sm:text-lg leading-8 text-text-secondary mt-4">
            We tested this across 94 live domains and published the results in a peer-reviewed paper.
          </p>
        </section>

        {/* --- Numbers --- */}
        <section className="mb-10 rounded-2xl border border-orange-500/20 bg-orange-50/50 dark:bg-orange-950/10 p-6 sm:p-8">
          <h2 className="text-2xl font-semibold tracking-tight mb-4">The numbers</h2>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-6 mb-6">
            <div>
              <div className="text-3xl font-bold text-orange-600">3.6x</div>
              <div className="text-sm text-text-secondary mt-1">Mean speedup over Playwright browser automation</div>
            </div>
            <div>
              <div className="text-3xl font-bold text-orange-600">&lt;100ms</div>
              <div className="text-sm text-text-secondary mt-1">Cached API call latency</div>
            </div>
            <div>
              <div className="text-3xl font-bold text-orange-600">90-96%</div>
              <div className="text-sm text-text-secondary mt-1">Cost reduction per task</div>
            </div>
          </div>
          <p className="text-base leading-7 text-text-secondary">
            Warmed-cache execution averaged 950ms versus 3,404ms for Playwright. Median speedup was 5.4x. Cold-start discovery averaged 12.4 seconds and amortized within 3-5 reuses. Once a site is discovered, every subsequent agent call is a direct HTTP request.
          </p>
          <p className="text-sm text-text-secondary mt-3">
            Source:{" "}
            <a
              href="https://arxiv.org/abs/2604.00694"
              target="_blank"
              rel="noopener"
              className="text-orange-600 hover:text-orange-500"
            >
              Internal APIs Are All You Need
            </a>{" "}
            (arXiv:2604.00694), 94-domain benchmark.
          </p>
        </section>

        {/* --- Why MCP is a hallucination --- */}
        <section className="mb-10">
          <h2 className="text-2xl font-semibold tracking-tight mb-4">Why the MCP ecosystem is a hallucination</h2>
          <p className="text-base sm:text-lg leading-8 text-text-secondary">
            The word &ldquo;hallucination&rdquo; is not hyperbole. The MCP server ecosystem shares the same structural defect as LLM hallucinations: it looks correct, it feels productive, and it confidently produces output. But it is disconnected from ground truth.
          </p>
          <p className="text-base sm:text-lg leading-8 text-text-secondary mt-4">
            The ground truth is this: the web already has a machine-native interface layer. It is the internal API calls that every website makes on every page load. The MCP approach ignores this layer entirely and instead builds a parallel, manually maintained, perpetually incomplete replica of it.
          </p>
          <p className="text-base sm:text-lg leading-8 text-text-secondary mt-4">
            Consider what happens when someone wants their agent to interact with a new SaaS product:
          </p>
          <div className="mt-4 grid grid-cols-1 md:grid-cols-2 gap-4">
            <div className="rounded-xl border border-border bg-surface-sunken p-5">
              <div className="text-xs font-mono font-medium uppercase tracking-widest text-text-secondary mb-3">MCP approach</div>
              <ol className="space-y-2 text-sm text-text-secondary list-decimal pl-4">
                <li>Check if someone wrote an MCP server for it</li>
                <li>They probably did not</li>
                <li>Check if the service has a public API</li>
                <li>It probably does not, or it is incomplete</li>
                <li>Write a wrapper from the API docs</li>
                <li>Test it, debug it, maintain it</li>
                <li>Repeat for the next service</li>
              </ol>
              <div className="mt-3 text-xs text-text-secondary">Time to first call: hours to days</div>
            </div>
            <div className="rounded-xl border border-orange-500/30 bg-orange-50/30 dark:bg-orange-950/10 p-5">
              <div className="text-xs font-mono font-medium uppercase tracking-widest text-orange-600 mb-3">Unbrowse approach</div>
              <ol className="space-y-2 text-sm text-text-secondary list-decimal pl-4">
                <li>Browse the website once</li>
                <li>Internal APIs are discovered automatically</li>
                <li>Reusable route metadata is extracted</li>
                <li>Published to a shared index</li>
                <li>Every agent can call them directly</li>
              </ol>
              <div className="mt-3 text-xs text-orange-600">Time to first call: seconds</div>
            </div>
          </div>
        </section>

        {/* --- The scaling argument --- */}
        <section className="mb-10">
          <h2 className="text-2xl font-semibold tracking-tight mb-4">The scaling argument</h2>
          <p className="text-base sm:text-lg leading-8 text-text-secondary">
            There are roughly 200 million active websites. The MCP ecosystem covers a few hundred of them. That is not a rounding error. It is a coverage rate so low that the word &ldquo;coverage&rdquo; barely applies.
          </p>
          <p className="text-base sm:text-lg leading-8 text-text-secondary mt-4">
            The fundamental problem is that hand-written wrappers require human effort proportional to the number of services. That is an O(n) solution to an O(n) problem, which means you never get ahead. Every new SaaS product, every new internal tool, every new admin panel requires someone to sit down and write another wrapper.
          </p>
          <p className="text-base sm:text-lg leading-8 text-text-secondary mt-4">
            Automated discovery inverts this. The cost of discovery is paid once per site and amortized across every agent that uses it. The shared index grows with usage, not with human effort. When one agent discovers the APIs behind a niche HR tool, every agent on the network gains access. The more agents participate, the faster the index grows, and the less any individual agent needs to discover on its own.
          </p>
          <p className="text-base sm:text-lg leading-8 text-text-secondary mt-4">
            This is the difference between a library and a network. MCP servers are a library: someone has to write each book. Unbrowse is a network: every participant makes it more valuable for everyone else.
          </p>
        </section>

        {/* --- Objections --- */}
        <section className="mb-10">
          <h2 className="text-2xl font-semibold tracking-tight mb-4">Objections</h2>
          <div className="space-y-6">
            <div>
              <p className="text-base sm:text-lg leading-8 text-text-secondary">
                <strong className="text-text-primary">&ldquo;Internal APIs aren&rsquo;t stable. They change without notice.&rdquo;</strong>{" "}
                So do public APIs. The difference is that internal APIs are continuously validated by the website itself. If the internal API breaks, the website breaks. That makes them the most reliable interfaces available. And when they do change, traffic-based discovery detects the drift automatically and re-captures.
              </p>
            </div>
            <div>
              <p className="text-base sm:text-lg leading-8 text-text-secondary">
                <strong className="text-text-primary">&ldquo;MCP servers give you nice, typed tool definitions.&rdquo;</strong>{" "}
                So does automated schema extraction. Unbrowse extracts request and response shapes from observed traffic and generates typed interfaces. You get the same structured tool definitions without writing them by hand.
              </p>
            </div>
            <div>
              <p className="text-base sm:text-lg leading-8 text-text-secondary">
                <strong className="text-text-primary">&ldquo;This only works for websites with SPAs and JSON APIs.&rdquo;</strong>{" "}
                That describes approximately every website built in the last decade. Server-rendered HTML with no client-side API calls is increasingly rare. Even traditional sites make AJAX calls for search, pagination, and dynamic content.
              </p>
            </div>
          </div>
        </section>

        {/* --- What this means for MCP server builders --- */}
        <section className="mb-10">
          <h2 className="text-2xl font-semibold tracking-tight mb-4">What this means for MCP server builders</h2>
          <p className="text-base sm:text-lg leading-8 text-text-secondary">
            If you have spent weeks building MCP servers, your work was not wasted. You understand the problem better than most: agents need structured, callable interfaces to the web. That insight is correct.
          </p>
          <p className="text-base sm:text-lg leading-8 text-text-secondary mt-4">
            But the solution is not to keep writing wrappers. The solution is to automate discovery. The APIs your wrappers expose are a subset of the APIs that already exist inside every website. The hard part was never writing the wrapper. It was finding the endpoint, understanding its schema, and keeping it working as the service evolves. That is exactly the part that can be automated.
          </p>
          <p className="text-base sm:text-lg leading-8 text-text-secondary mt-4">
            The MCP protocol itself is fine. It is a reasonable standard for how agents communicate with tools. The hallucination is the ecosystem built on top of it: the assumption that the only way to give agents web access is to hand-write one integration at a time.
          </p>
        </section>

        {/* --- CTA --- */}
        <section className="mb-12 rounded-2xl border border-orange-500/20 bg-orange-50/50 dark:bg-orange-950/10 p-6 sm:p-8">
          <h2 className="text-2xl font-semibold tracking-tight mb-3">Stop writing wrappers. Start discovering APIs.</h2>
          <p className="text-base sm:text-lg leading-8 text-text-secondary mb-6">
            Unbrowse discovers the internal APIs behind any website automatically and makes them callable by any agent. One install. No wrappers. No maintenance.
          </p>
          <div className="rounded-lg bg-surface-sunken border border-border p-4 font-mono text-sm mb-6">
            <span className="text-text-secondary">$</span>{" "}
            <span className="text-text-primary">curl -fsSL https://unbrowse.ai/install.sh | bash</span>
          </div>
          <div className="flex flex-col sm:flex-row gap-3">
            <a
              href="https://arxiv.org/abs/2604.00694"
              target="_blank"
              rel="noopener"
              className="inline-flex items-center justify-center rounded-lg bg-orange-500 px-5 py-3 font-medium text-white hover:bg-orange-600 transition-colors"
            >
              Read the paper
            </a>
            <a
              href="https://github.com/unbrowse-ai/unbrowse"
              target="_blank"
              rel="noopener"
              className="inline-flex items-center justify-center rounded-lg border border-border bg-surface-sunken px-5 py-3 font-medium text-text-primary hover:border-orange-500/30 hover:bg-orange-50/40 transition-colors"
            >
              View on GitHub
            </a>
          </div>
        </section>
      </article>
    </div>
  );
}
