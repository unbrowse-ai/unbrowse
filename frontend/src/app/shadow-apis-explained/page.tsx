import type { Metadata } from "next";
import Link from "next/link";

const TITLE = "Shadow APIs: The Hidden API Layer Every Website Already Has";
const SUBTITLE = "What they are, how Unbrowse discovers them, and why they matter for AI agents";
const CANONICAL_PATH = "/shadow-apis-explained";
const PUBLISHED_AT = "2026-04-02";
const MODIFIED_AT = "2026-04-02";
const AUTHOR = {
  name: "Lewis Tham",
  affiliation: "Unbrowse AI",
  email: "lewis@unbrowse.ai",
};

const description = `Every modern website calls internal API endpoints behind its UI. These shadow APIs are not documented, not public, but fully functional. Unbrowse discovers them by intercepting network traffic during normal browsing. Across 94 domains tested, every single one had discoverable shadow APIs. This is the technical foundation of agent-native browsing.`;

export const metadata: Metadata = {
  title: `${TITLE} | Unbrowse`,
  description,
  alternates: {
    canonical: `https://www.unbrowse.ai${CANONICAL_PATH}`,
  },
  authors: [{ name: AUTHOR.name, url: `mailto:${AUTHOR.email}` }],
  openGraph: {
    title: `${TITLE}`,
    description,
    url: `https://www.unbrowse.ai${CANONICAL_PATH}`,
    siteName: "Unbrowse",
    type: "article",
    publishedTime: PUBLISHED_AT,
    modifiedTime: MODIFIED_AT,
    authors: [AUTHOR.name],
    images: [
      {
        url: "https://www.unbrowse.ai/og-image.png",
        alt: "Shadow APIs — The Hidden API Layer Every Website Already Has",
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
    "shadow APIs",
    "internal APIs",
    "API discovery",
    "web agents",
    "undocumented APIs",
    "browser automation",
    "network interception",
    "Unbrowse",
    "agent-native browsing",
    "fetch interception",
    "XHR interception",
    "HAR recording",
    "reverse engineering APIs",
  ],
};

export default function ShadowApisExplainedPage() {
  const articleSchema = {
    "@context": "https://schema.org",
    "@type": "TechArticle",
    headline: TITLE,
    alternativeHeadline: SUBTITLE,
    description,
    author: {
      "@type": "Person",
      name: AUTHOR.name,
      email: AUTHOR.email,
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
    dateModified: MODIFIED_AT,
    url: `https://www.unbrowse.ai${CANONICAL_PATH}`,
    about: [
      "Shadow APIs",
      "Internal APIs",
      "API discovery",
      "Web automation",
      "Agent-native browsing",
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
            Technical Deep Dive
          </p>
          <h1 className="text-4xl sm:text-6xl font-bold tracking-tight text-balance leading-tight">
            {TITLE}
          </h1>
          <p className="mt-4 text-xl sm:text-2xl text-text-secondary font-medium text-balance">
            {SUBTITLE}
          </p>
          <div className="mt-8 text-sm sm:text-base text-text-secondary">
            <div className="font-semibold text-text-primary">{AUTHOR.name}</div>
            <div>{AUTHOR.affiliation}</div>
            <div className="mt-1 text-text-muted">{PUBLISHED_AT}</div>
          </div>
        </header>

        {/* ── Introduction ── */}
        <section className="mb-12">
          <p className="text-base sm:text-lg leading-8 text-text-secondary mb-6">
            Open any modern website. Search for something. Filter results. Load a profile page.
            Every one of those actions triggers network requests behind the scenes &mdash; HTTP calls
            from the site&rsquo;s own JavaScript to its own backend. These are not public APIs. They
            are not documented in any developer portal. But they are fully functional, structured,
            and callable.
          </p>
          <p className="text-base sm:text-lg leading-8 text-text-secondary mb-6">
            We call them <strong className="text-text-primary">shadow APIs</strong>.
          </p>
          <p className="text-base sm:text-lg leading-8 text-text-secondary">
            In our paper{" "}
            <a
              href="/internal-apis-are-all-you-need"
              className="text-orange-600 hover:text-orange-500 font-medium"
            >
              Internal APIs Are All You Need
            </a>{" "}
            (arXiv:{" "}
            <a
              href="https://arxiv.org/abs/2604.00694"
              target="_blank"
              rel="noopener"
              className="text-orange-600 hover:text-orange-500 font-medium"
            >
              2604.00694
            </a>
            ), we tested 94 live domains. Every single one had discoverable shadow APIs. This post
            explains what they are, how Unbrowse finds them, and what the capture pipeline looks
            like end to end.
          </p>
        </section>

        {/* ── What Are Shadow APIs? ── */}
        <section className="mb-12">
          <h2 className="text-2xl font-semibold tracking-tight mb-4">
            What exactly is a shadow API?
          </h2>
          <p className="text-base sm:text-lg leading-8 text-text-secondary mb-6">
            A shadow API is a first-party HTTP endpoint that a website calls from its own frontend
            JavaScript to fetch or mutate data. The term &ldquo;shadow&rdquo; captures two
            properties: the endpoints exist in the shadow of the visible UI, and they are invisible
            to anyone who does not inspect network traffic.
          </p>
          <p className="text-base sm:text-lg leading-8 text-text-secondary mb-6">
            They are distinct from:
          </p>
          <ul className="space-y-3 text-base sm:text-lg leading-8 text-text-secondary list-disc pl-5 mb-6">
            <li>
              <strong className="text-text-primary">Public APIs</strong> &mdash; documented
              endpoints with published schemas, API keys, and rate limit contracts (e.g. the
              Twitter/X API, Stripe API).
            </li>
            <li>
              <strong className="text-text-primary">Third-party APIs</strong> &mdash; calls to
              external services like analytics, ad networks, or CDNs. These are not the
              site&rsquo;s own data.
            </li>
            <li>
              <strong className="text-text-primary">Server-side rendering</strong> &mdash; some
              frameworks embed data directly in the initial HTML payload. Shadow APIs are the
              subsequent fetch/XHR calls that load dynamic content after the page renders.
            </li>
          </ul>
          <p className="text-base sm:text-lg leading-8 text-text-secondary">
            Shadow APIs are the site talking to itself. The frontend is the client; the backend is
            the server. The browser is just a middleman rendering the response for human eyes.
          </p>
        </section>

        {/* ── Real Examples ── */}
        <section className="mb-12">
          <h2 className="text-2xl font-semibold tracking-tight mb-4">
            Real examples from 94 domains
          </h2>
          <p className="text-base sm:text-lg leading-8 text-text-secondary mb-6">
            When you use a website, the browser&rsquo;s DevTools Network tab reveals what is really
            happening. Here are representative shadow API patterns we captured across different
            categories of sites:
          </p>

          {/* Search */}
          <div className="mb-8">
            <h3 className="text-lg font-semibold text-text-primary mb-3">Search endpoints</h3>
            <p className="text-base leading-7 text-text-secondary mb-3">
              Nearly every site with a search bar calls a JSON endpoint behind the scenes. The user
              types a query; the frontend calls an API; the response is structured data that gets
              rendered into the result list.
            </p>
            <div className="rounded-xl border border-border bg-code-bg p-4 sm:p-6 overflow-x-auto font-mono text-sm leading-6">
              <div className="text-text-muted mb-1"># Reddit — subreddit search</div>
              <div className="text-orange-600">GET /search/suggestions?q=machine+learning&include_over_18=false</div>
              <div className="text-text-muted mt-1 mb-4">→ {"{"} suggestions: [{"{"} name: &quot;r/MachineLearning&quot;, subscriber_count: 3200000 {"}"}...] {"}"}</div>

              <div className="text-text-muted mb-1"># Amazon — product search with autocomplete</div>
              <div className="text-orange-600">GET /api/suggestions?prefix=mechanical+keyboard&mid=ATVPDKIKX0DER</div>
              <div className="text-text-muted mt-1 mb-4">→ {"{"} suggestions: [&quot;mechanical keyboard wireless&quot;, &quot;mechanical keyboard 60%&quot;...] {"}"}</div>

              <div className="text-text-muted mb-1"># Hacker News — Algolia-powered search</div>
              <div className="text-orange-600">GET /api/v1/search?query=shadow+api&tags=story&hitsPerPage=30</div>
              <div className="text-text-muted mt-1">→ {"{"} hits: [{"{"} title: &quot;...&quot;, url: &quot;...&quot;, points: 142 {"}"}...] {"}"}</div>
            </div>
          </div>

          {/* Content feeds */}
          <div className="mb-8">
            <h3 className="text-lg font-semibold text-text-primary mb-3">Content feed endpoints</h3>
            <p className="text-base leading-7 text-text-secondary mb-3">
              Infinite scroll, pagination, and &ldquo;load more&rdquo; buttons all fetch content from
              paginated API endpoints. The data is JSON before it becomes HTML cards.
            </p>
            <div className="rounded-xl border border-border bg-code-bg p-4 sm:p-6 overflow-x-auto font-mono text-sm leading-6">
              <div className="text-text-muted mb-1"># YouTube — video recommendations</div>
              <div className="text-orange-600">POST /youtubei/v1/browse?key=AIza...</div>
              <div className="text-text-muted mt-1 mb-4">→ {"{"} contents: {"{"} richGridRenderer: {"{"} contents: [{"{"} videoRenderer: {"{"} videoId, title, viewCount {"}"} {"}"}...] {"}"} {"}"} {"}"}</div>

              <div className="text-text-muted mb-1"># GitHub — repository file listing</div>
              <div className="text-orange-600">GET /repos/unbrowse-ai/unbrowse/contents/src?ref=main</div>
              <div className="text-text-muted mt-1 mb-4">→ [{"{"} name: &quot;cli.ts&quot;, type: &quot;file&quot;, size: 4521 {"}"}...]</div>

              <div className="text-text-muted mb-1"># Airbnb — listing details</div>
              <div className="text-orange-600">GET /api/v3/StaysPdpSections?operationName=StaysPdpSections&variables=...</div>
              <div className="text-text-muted mt-1">→ {"{"} data: {"{"} presentation: {"{"} stayProductDetailPage: {"{"} sections: [...] {"}"} {"}"} {"}"} {"}"}</div>
            </div>
          </div>

          {/* Authentication-gated */}
          <div className="mb-8">
            <h3 className="text-lg font-semibold text-text-primary mb-3">Authentication-gated endpoints</h3>
            <p className="text-base leading-7 text-text-secondary mb-3">
              Logged-in actions &mdash; viewing your dashboard, posting a comment, checking
              notifications &mdash; use shadow APIs authenticated via session cookies or bearer
              tokens that the browser already holds.
            </p>
            <div className="rounded-xl border border-border bg-code-bg p-4 sm:p-6 overflow-x-auto font-mono text-sm leading-6">
              <div className="text-text-muted mb-1"># LinkedIn — notifications feed</div>
              <div className="text-orange-600">GET /voyager/api/dash/notifications?decorationId=...&count=20</div>
              <div className="text-text-muted mt-1 mb-1">Headers: csrf-token: ajax:123..., cookie: li_at=AQE...</div>
              <div className="text-text-muted mb-4">→ {"{"} elements: [{"{"} actor: &quot;...&quot;, notificationType: &quot;PROFILE_VIEW&quot; {"}"}...] {"}"}</div>

              <div className="text-text-muted mb-1"># Notion — page content</div>
              <div className="text-orange-600">POST /api/v3/loadPageChunk</div>
              <div className="text-text-muted mt-1 mb-1">Body: {"{"} pageId: &quot;abc-123&quot;, limit: 50, chunkNumber: 0 {"}"}</div>
              <div className="text-text-muted">→ {"{"} recordMap: {"{"} block: {"{"} &quot;abc-123&quot;: {"{"} value: {"{"} type: &quot;page&quot;, properties: {"{"} title: [[&quot;My Doc&quot;]] {"}"} {"}"} {"}"} {"}"} {"}"} {"}"}</div>
            </div>
          </div>

          {/* GraphQL */}
          <div className="mb-8">
            <h3 className="text-lg font-semibold text-text-primary mb-3">GraphQL endpoints</h3>
            <p className="text-base leading-7 text-text-secondary mb-3">
              Many modern sites use GraphQL internally. A single endpoint handles all queries,
              differentiated by <code className="bg-code-bg px-1.5 py-0.5 rounded text-orange-600 text-sm">operationName</code>.
              These are particularly information-dense shadow APIs.
            </p>
            <div className="rounded-xl border border-border bg-code-bg p-4 sm:p-6 overflow-x-auto font-mono text-sm leading-6">
              <div className="text-text-muted mb-1"># X/Twitter — timeline (GraphQL)</div>
              <div className="text-orange-600">POST /i/api/graphql/abc123/HomeTimeline</div>
              <div className="text-text-muted mt-1 mb-4">Body: {"{"} variables: {"{"} count: 20 {"}"}, features: {"{"} ... {"}"} {"}"}</div>

              <div className="text-text-muted mb-1"># Shopify storefront — product query</div>
              <div className="text-orange-600">POST /api/2024-01/graphql.json</div>
              <div className="text-text-muted mt-1">Body: {"{"} query: &quot;{"{"} product(handle: \\&quot;widget\\&quot;) {"{"} title, price {"}"} {"}"}&quot; {"}"}</div>
            </div>
          </div>
        </section>

        {/* ── Why They Exist ── */}
        <section className="mb-12">
          <h2 className="text-2xl font-semibold tracking-tight mb-4">
            Why every website has shadow APIs
          </h2>
          <p className="text-base sm:text-lg leading-8 text-text-secondary mb-6">
            This is not a quirk of certain frameworks. It is a structural consequence of how the
            modern web works.
          </p>
          <p className="text-base sm:text-lg leading-8 text-text-secondary mb-6">
            In the early web, servers rendered full HTML pages on every request. Click a link, get a
            new page. There was no separation between data and presentation &mdash; the API was the
            HTML.
          </p>
          <p className="text-base sm:text-lg leading-8 text-text-secondary mb-6">
            Starting around 2010, the industry shifted to single-page applications (SPAs) and
            client-side rendering. React, Angular, Vue, and their successors all follow the same
            architectural pattern: the browser loads a JavaScript shell, then the shell calls backend
            APIs to fetch data and renders it into the DOM.
          </p>
          <p className="text-base sm:text-lg leading-8 text-text-secondary mb-6">
            That architectural shift created a universal invariant:
          </p>
          <div className="rounded-2xl border border-orange-500/20 bg-orange-50/50 p-6 sm:p-8 mb-6">
            <p className="text-base sm:text-lg leading-8 text-text-primary font-medium">
              Every interactive website must have an internal API. The frontend needs structured data
              from the backend. The only transport is HTTP. Therefore, every site has callable HTTP
              endpoints that return structured data.
            </p>
          </div>
          <p className="text-base sm:text-lg leading-8 text-text-secondary">
            Even server-rendered frameworks like Next.js and Remix create API routes for client-side
            data fetching, form submissions, and real-time updates. The architectural style varies
            &mdash; REST, GraphQL, tRPC, custom JSON-RPC &mdash; but the invariant holds. If the page
            is interactive, there is an API underneath.
          </p>
        </section>

        {/* ── The Capture Pipeline ── */}
        <section className="mb-12">
          <h2 className="text-2xl font-semibold tracking-tight mb-4">
            How Unbrowse discovers shadow APIs
          </h2>
          <p className="text-base sm:text-lg leading-8 text-text-secondary mb-6">
            Unbrowse uses a dual-layer interception strategy: passive HAR recording via the Chrome
            DevTools Protocol (CDP), plus an active JavaScript interceptor injected into the page.
            Together, they capture every network request the site makes.
          </p>

          <h3 className="text-lg font-semibold text-text-primary mb-3 mt-8">
            Layer 1: CDP network recording
          </h3>
          <p className="text-base sm:text-lg leading-8 text-text-secondary mb-4">
            Unbrowse runs a lightweight CDP broker called Kuri (464 KB, ~3 ms cold start, written in
            Zig). Kuri attaches to Chrome and enables{" "}
            <code className="bg-code-bg px-1.5 py-0.5 rounded text-orange-600 text-sm">Network.enable</code>
            {" "}to record every HTTP request and response into a HAR (HTTP Archive) log. This catches
            standard page loads, XHR, and fetch calls at the protocol level.
          </p>
          <div className="rounded-xl border border-border bg-code-bg p-4 sm:p-6 overflow-x-auto font-mono text-sm leading-6 mb-6">
            <div className="text-text-muted mb-2"># Simplified CDP capture flow</div>
            <div><span className="text-orange-600">Kuri</span> → Chrome DevTools Protocol</div>
            <div className="ml-4">→ Network.enable</div>
            <div className="ml-4">→ Network.requestWillBeSent  <span className="text-text-muted"># capture request</span></div>
            <div className="ml-4">→ Network.responseReceived    <span className="text-text-muted"># capture response headers</span></div>
            <div className="ml-4">→ Network.getResponseBody     <span className="text-text-muted"># capture response body</span></div>
            <div className="ml-4">→ HAR entry assembled</div>
          </div>

          <h3 className="text-lg font-semibold text-text-primary mb-3 mt-8">
            Layer 2: JavaScript fetch/XHR interceptor
          </h3>
          <p className="text-base sm:text-lg leading-8 text-text-secondary mb-4">
            CDP&rsquo;s HAR recording misses some requests on SPAs &mdash; particularly those fired
            during rapid client-side navigation or from Web Workers. To close this gap, Unbrowse
            injects a small JavaScript interceptor that monkey-patches{" "}
            <code className="bg-code-bg px-1.5 py-0.5 rounded text-orange-600 text-sm">window.fetch</code> and{" "}
            <code className="bg-code-bg px-1.5 py-0.5 rounded text-orange-600 text-sm">XMLHttpRequest</code>.
            Every outbound request and its response are captured in-page before the site&rsquo;s own
            code sees the response.
          </p>
          <div className="rounded-xl border border-border bg-code-bg p-4 sm:p-6 overflow-x-auto font-mono text-sm leading-6 mb-6">
            <div className="text-text-muted mb-2">// Interceptor pseudocode (injected into page)</div>
            <div><span className="text-orange-600">const</span> originalFetch = window.fetch;</div>
            <div><span className="text-orange-600">window.fetch</span> = async (url, opts) =&gt; {"{"}</div>
            <div className="ml-4"><span className="text-orange-600">const</span> response = await originalFetch(url, opts);</div>
            <div className="ml-4"><span className="text-orange-600">const</span> clone = response.clone();</div>
            <div className="ml-4"><span className="text-orange-600">const</span> body = await clone.text();</div>
            <div className="ml-4">capturedRequests.push({"{"}</div>
            <div className="ml-8">url, method: opts?.method || &quot;GET&quot;,</div>
            <div className="ml-8">requestHeaders: opts?.headers,</div>
            <div className="ml-8">status: response.status,</div>
            <div className="ml-8">responseBody: body</div>
            <div className="ml-4">{"}"});</div>
            <div className="ml-4"><span className="text-orange-600">return</span> response;</div>
            <div>{"}"};</div>
          </div>

          <h3 className="text-lg font-semibold text-text-primary mb-3 mt-8">
            Merging and deduplication
          </h3>
          <p className="text-base sm:text-lg leading-8 text-text-secondary mb-4">
            When a browse session ends, Unbrowse merges entries from both sources. Requests are
            deduplicated by URL + method + status code. The interceptor layer fills gaps the HAR
            missed; the HAR layer provides precise timing and size data the interceptor cannot
            access.
          </p>

          <h3 className="text-lg font-semibold text-text-primary mb-3 mt-8">
            The full enrichment pipeline
          </h3>
          <p className="text-base sm:text-lg leading-8 text-text-secondary mb-4">
            Raw captured traffic goes through a multi-stage pipeline that transforms it from noisy
            network logs into clean, callable API skills:
          </p>
          <div className="rounded-xl border border-border bg-code-bg p-4 sm:p-6 overflow-x-auto font-mono text-sm leading-7 mb-4">
            <div className="text-text-muted mb-3"># Unbrowse enrichment pipeline</div>
            <div><span className="text-orange-600">1.</span> extractEndpoints      <span className="text-text-muted"># Filter noise: strip analytics, ads, static assets</span></div>
            <div>                          <span className="text-text-muted"># Keep only first-party JSON/API endpoints</span></div>
            <div className="mt-2"><span className="text-orange-600">2.</span> extractAuthHeaders    <span className="text-text-muted"># Identify auth patterns: cookies, bearer tokens,</span></div>
            <div>                          <span className="text-text-muted"># CSRF tokens, API keys in headers/query params</span></div>
            <div className="mt-2"><span className="text-orange-600">3.</span> storeCredential       <span className="text-text-muted"># Save auth credentials to local encrypted vault</span></div>
            <div className="mt-2"><span className="text-orange-600">4.</span> mergeEndpoints        <span className="text-text-muted"># Merge with any existing skill for this domain</span></div>
            <div>                          <span className="text-text-muted"># Deduplicate, update schemas, preserve history</span></div>
            <div className="mt-2"><span className="text-orange-600">5.</span> generateDescription   <span className="text-text-muted"># LLM generates human-readable descriptions</span></div>
            <div>                          <span className="text-text-muted"># from URL patterns, params, response shapes</span></div>
            <div className="mt-2"><span className="text-orange-600">6.</span> augmentWithAgent      <span className="text-text-muted"># LLM adds semantic metadata: what does this</span></div>
            <div>                          <span className="text-text-muted"># endpoint actually do? What are the params?</span></div>
            <div className="mt-2"><span className="text-orange-600">7.</span> buildOperationGraph   <span className="text-text-muted"># Map dependencies between endpoints</span></div>
            <div>                          <span className="text-text-muted"># (e.g., search → detail → checkout)</span></div>
            <div className="mt-2"><span className="text-orange-600">8.</span> publishSkill          <span className="text-text-muted"># Cache locally + publish to shared marketplace</span></div>
          </div>
          <p className="text-base sm:text-lg leading-8 text-text-secondary">
            The output is a &ldquo;skill&rdquo; &mdash; a structured document containing every
            discovered endpoint for a domain, with schemas, auth requirements, descriptions, and
            an operation graph. Any agent can use this skill to call the site&rsquo;s shadow APIs
            directly, without ever opening a browser.
          </p>
        </section>

        {/* ── What Gets Filtered Out ── */}
        <section className="mb-12">
          <h2 className="text-2xl font-semibold tracking-tight mb-4">
            Separating signal from noise
          </h2>
          <p className="text-base sm:text-lg leading-8 text-text-secondary mb-6">
            A single page load can generate 50 to 200+ network requests. Most of them are not shadow
            APIs. The <code className="bg-code-bg px-1.5 py-0.5 rounded text-orange-600 text-sm">extractEndpoints</code>{" "}
            stage applies several filters:
          </p>
          <div className="overflow-x-auto mb-6">
            <table className="w-full text-sm sm:text-base border-collapse">
              <thead>
                <tr className="border-b border-border">
                  <th className="text-left py-3 pr-4 font-semibold text-text-primary">Filtered out</th>
                  <th className="text-left py-3 font-semibold text-text-primary">Why</th>
                </tr>
              </thead>
              <tbody className="text-text-secondary">
                <tr className="border-b border-border/50">
                  <td className="py-3 pr-4 font-mono text-sm">*.google-analytics.com/*</td>
                  <td className="py-3">Third-party analytics &mdash; not the site&rsquo;s data</td>
                </tr>
                <tr className="border-b border-border/50">
                  <td className="py-3 pr-4 font-mono text-sm">*.cloudfront.net/*.js</td>
                  <td className="py-3">Static assets &mdash; JavaScript bundles, CSS, images</td>
                </tr>
                <tr className="border-b border-border/50">
                  <td className="py-3 pr-4 font-mono text-sm">*.doubleclick.net/*</td>
                  <td className="py-3">Ad network calls</td>
                </tr>
                <tr className="border-b border-border/50">
                  <td className="py-3 pr-4 font-mono text-sm">*/favicon.ico</td>
                  <td className="py-3">Browser chrome, not data</td>
                </tr>
                <tr>
                  <td className="py-3 pr-4 font-mono text-sm">*/socket.io/*</td>
                  <td className="py-3">WebSocket handshakes (tracked separately)</td>
                </tr>
              </tbody>
            </table>
          </div>
          <p className="text-base sm:text-lg leading-8 text-text-secondary">
            What remains are first-party endpoints returning JSON (or occasionally XML/protobuf)
            responses. These are the shadow APIs &mdash; the actual data layer powering the site.
          </p>
        </section>

        {/* ── 94 Domains ── */}
        <section className="mb-12">
          <h2 className="text-2xl font-semibold tracking-tight mb-4">
            94 domains, 100% discovery rate
          </h2>
          <p className="text-base sm:text-lg leading-8 text-text-secondary mb-6">
            For the paper, we benchmarked Unbrowse against 94 live domains spanning e-commerce,
            social media, developer tools, news, travel, finance, and more. The key finding:
          </p>
          <div className="rounded-2xl border border-orange-500/20 bg-orange-50/50 p-6 sm:p-8 mb-6">
            <p className="text-base sm:text-lg leading-8 text-text-primary font-medium">
              Every single domain had at least one discoverable shadow API endpoint. The median
              domain exposed 6 distinct endpoints from a single browse session. Some domains
              exposed 20+.
            </p>
          </div>
          <p className="text-base sm:text-lg leading-8 text-text-secondary mb-6">
            The distribution across categories:
          </p>
          <div className="overflow-x-auto mb-6">
            <table className="w-full text-sm sm:text-base border-collapse">
              <thead>
                <tr className="border-b border-border">
                  <th className="text-left py-3 pr-4 font-semibold text-text-primary">Category</th>
                  <th className="text-left py-3 pr-4 font-semibold text-text-primary">Example domains</th>
                  <th className="text-left py-3 font-semibold text-text-primary">Typical pattern</th>
                </tr>
              </thead>
              <tbody className="text-text-secondary">
                <tr className="border-b border-border/50">
                  <td className="py-3 pr-4 font-medium text-text-primary">E-commerce</td>
                  <td className="py-3 pr-4">Amazon, eBay, Etsy</td>
                  <td className="py-3">Search, product detail, pricing, reviews</td>
                </tr>
                <tr className="border-b border-border/50">
                  <td className="py-3 pr-4 font-medium text-text-primary">Social</td>
                  <td className="py-3 pr-4">Reddit, LinkedIn, X</td>
                  <td className="py-3">Feed, profile, search, notifications</td>
                </tr>
                <tr className="border-b border-border/50">
                  <td className="py-3 pr-4 font-medium text-text-primary">Developer tools</td>
                  <td className="py-3 pr-4">GitHub, npm, Stack Overflow</td>
                  <td className="py-3">Repo contents, package metadata, Q&amp;A</td>
                </tr>
                <tr className="border-b border-border/50">
                  <td className="py-3 pr-4 font-medium text-text-primary">News / media</td>
                  <td className="py-3 pr-4">HN, TechCrunch, Reuters</td>
                  <td className="py-3">Article feed, search, comments</td>
                </tr>
                <tr className="border-b border-border/50">
                  <td className="py-3 pr-4 font-medium text-text-primary">Travel</td>
                  <td className="py-3 pr-4">Airbnb, Booking.com</td>
                  <td className="py-3">Listing detail, availability, pricing</td>
                </tr>
                <tr>
                  <td className="py-3 pr-4 font-medium text-text-primary">Finance</td>
                  <td className="py-3 pr-4">Yahoo Finance, CoinGecko</td>
                  <td className="py-3">Quotes, charts, portfolio</td>
                </tr>
              </tbody>
            </table>
          </div>
        </section>

        {/* ── From Shadow API to Agent Skill ── */}
        <section className="mb-12">
          <h2 className="text-2xl font-semibold tracking-tight mb-4">
            From shadow API to agent skill
          </h2>
          <p className="text-base sm:text-lg leading-8 text-text-secondary mb-6">
            Discovering an endpoint is only the first step. To be useful to an AI agent, the
            endpoint needs context: what does it do, what parameters does it accept, what does
            the response look like, and how does it relate to other endpoints on the same domain?
          </p>
          <p className="text-base sm:text-lg leading-8 text-text-secondary mb-6">
            Here is what a single captured endpoint looks like after the full enrichment pipeline:
          </p>
          <div className="rounded-xl border border-border bg-code-bg p-4 sm:p-6 overflow-x-auto font-mono text-sm leading-6 mb-6">
            <div>{"{"}</div>
            <div className="ml-4"><span className="text-orange-600">&quot;method&quot;</span>: &quot;GET&quot;,</div>
            <div className="ml-4"><span className="text-orange-600">&quot;url_template&quot;</span>: &quot;/search/suggestions?q={"{"}query{"}"}&amp;include_over_18={"{"}nsfw{"}"}&quot;,</div>
            <div className="ml-4"><span className="text-orange-600">&quot;description&quot;</span>: &quot;Search Reddit for subreddit suggestions matching a query&quot;,</div>
            <div className="ml-4"><span className="text-orange-600">&quot;params&quot;</span>: {"{"}</div>
            <div className="ml-8">&quot;q&quot;: {"{"} &quot;type&quot;: &quot;string&quot;, &quot;required&quot;: true, &quot;description&quot;: &quot;Search query&quot; {"}"},</div>
            <div className="ml-8">&quot;include_over_18&quot;: {"{"} &quot;type&quot;: &quot;boolean&quot;, &quot;default&quot;: false {"}"}</div>
            <div className="ml-4">{"}"},</div>
            <div className="ml-4"><span className="text-orange-600">&quot;auth&quot;</span>: {"{"} &quot;type&quot;: &quot;cookie&quot;, &quot;keys&quot;: [&quot;reddit_session&quot;] {"}"},</div>
            <div className="ml-4"><span className="text-orange-600">&quot;response_schema&quot;</span>: {"{"}</div>
            <div className="ml-8">&quot;suggestions&quot;: [{"{"} &quot;name&quot;: &quot;string&quot;, &quot;subscriber_count&quot;: &quot;number&quot; {"}"}]</div>
            <div className="ml-4">{"}"},</div>
            <div className="ml-4"><span className="text-orange-600">&quot;observed_latency_ms&quot;</span>: 142,</div>
            <div className="ml-4"><span className="text-orange-600">&quot;last_verified&quot;</span>: &quot;2026-04-01T12:00:00Z&quot;</div>
            <div>{"}"}</div>
          </div>
          <p className="text-base sm:text-lg leading-8 text-text-secondary">
            An agent seeing this skill knows exactly how to call the endpoint, what to pass, what to
            expect back, and how to authenticate. No browser needed. No DOM parsing. No screenshots.
            Just an HTTP call that returns structured data in ~140 ms.
          </p>
        </section>

        {/* ── Performance ── */}
        <section className="mb-12">
          <h2 className="text-2xl font-semibold tracking-tight mb-4">
            The performance case
          </h2>
          <p className="text-base sm:text-lg leading-8 text-text-secondary mb-6">
            Calling shadow APIs directly versus automating a browser is not a marginal improvement.
            It is a category change in execution characteristics:
          </p>
          <div className="overflow-x-auto mb-6">
            <table className="w-full text-sm sm:text-base border-collapse">
              <thead>
                <tr className="border-b border-border">
                  <th className="text-left py-3 pr-4 font-semibold text-text-primary">Metric</th>
                  <th className="text-left py-3 pr-4 font-semibold text-text-primary">Browser automation</th>
                  <th className="text-left py-3 font-semibold text-text-primary">Shadow API (cached)</th>
                </tr>
              </thead>
              <tbody className="text-text-secondary">
                <tr className="border-b border-border/50">
                  <td className="py-3 pr-4 font-medium text-text-primary">Latency (mean)</td>
                  <td className="py-3 pr-4">3,404 ms</td>
                  <td className="py-3 font-semibold text-orange-600">950 ms</td>
                </tr>
                <tr className="border-b border-border/50">
                  <td className="py-3 pr-4 font-medium text-text-primary">Tokens per task</td>
                  <td className="py-3 pr-4">~8,000</td>
                  <td className="py-3 font-semibold text-orange-600">~200</td>
                </tr>
                <tr className="border-b border-border/50">
                  <td className="py-3 pr-4 font-medium text-text-primary">Mean speedup</td>
                  <td className="py-3 pr-4">1x (baseline)</td>
                  <td className="py-3 font-semibold text-orange-600">3.6x</td>
                </tr>
                <tr className="border-b border-border/50">
                  <td className="py-3 pr-4 font-medium text-text-primary">Median speedup</td>
                  <td className="py-3 pr-4">1x (baseline)</td>
                  <td className="py-3 font-semibold text-orange-600">5.4x</td>
                </tr>
                <tr>
                  <td className="py-3 pr-4 font-medium text-text-primary">Cost reduction</td>
                  <td className="py-3 pr-4">Baseline</td>
                  <td className="py-3 font-semibold text-orange-600">90-96%</td>
                </tr>
              </tbody>
            </table>
          </div>
          <p className="text-base sm:text-lg leading-8 text-text-secondary">
            Cold-start discovery (first time seeing a domain) averages 12.4 seconds. But that cost
            amortizes within 3-5 reuses. After that, every subsequent agent call to that domain hits
            the cache and executes in under a second.
          </p>
        </section>

        {/* ── Implications ── */}
        <section className="mb-12">
          <h2 className="text-2xl font-semibold tracking-tight mb-4">
            Why this matters for AI agents
          </h2>
          <p className="text-base sm:text-lg leading-8 text-text-secondary mb-6">
            The existence of universal shadow APIs has a direct consequence for agent architecture.
            The dominant approach today &mdash; launching a headless browser, rendering pages,
            taking screenshots, sending pixels to an LLM &mdash; is doing unnecessary work. The
            data was structured JSON before the browser rendered it into pixels. The entire rendering
            pipeline exists only because agents are using human interfaces instead of machine
            interfaces.
          </p>
          <p className="text-base sm:text-lg leading-8 text-text-secondary mb-6">
            Shadow APIs are the machine-native interface layer. They already exist on every website.
            The only missing piece was infrastructure to discover, index, and share them.
          </p>
          <p className="text-base sm:text-lg leading-8 text-text-secondary">
            That is what Unbrowse provides: a system that passively captures shadow APIs from real
            browsing, enriches them into structured skills, caches them locally, and publishes them
            to a shared marketplace so every agent on the network benefits from every discovery.
          </p>
        </section>

        {/* ── CTA ── */}
        <section className="mb-12 rounded-2xl border border-orange-500/20 bg-orange-50/50 p-6 sm:p-8">
          <h2 className="text-2xl font-semibold tracking-tight mb-3">Read the paper. Try it yourself.</h2>
          <p className="text-base sm:text-lg leading-8 text-text-secondary mb-6">
            The full research paper covers the shared route graph architecture, benchmark
            methodology across 94 domains, the three-path execution model, and economic analysis
            of route-level pricing.
          </p>
          <div className="flex flex-col sm:flex-row gap-3">
            <a
              href="https://arxiv.org/abs/2604.00694"
              target="_blank"
              rel="noopener"
              className="inline-flex items-center justify-center rounded-lg bg-orange-500 px-5 py-3 font-medium text-white hover:bg-orange-600 transition-colors"
            >
              Read the paper on arXiv
            </a>
            <a
              href="/internal-apis-are-all-you-need"
              className="inline-flex items-center justify-center rounded-lg border border-border bg-surface-sunken px-5 py-3 font-medium text-text-primary hover:border-orange-500/30 hover:bg-orange-50/40 transition-colors"
            >
              Paper summary page
            </a>
            <a
              href="https://github.com/unbrowse-ai/unbrowse"
              target="_blank"
              rel="noopener"
              className="inline-flex items-center justify-center rounded-lg border border-border bg-surface-sunken px-5 py-3 font-medium text-text-primary hover:border-orange-500/30 hover:bg-orange-50/40 transition-colors"
            >
              GitHub repository
            </a>
          </div>
          <div className="mt-6 rounded-xl border border-border bg-code-bg p-4 sm:p-6 font-mono text-sm">
            <div className="text-text-muted mb-1"># Install Unbrowse and discover your first shadow APIs</div>
            <div className="text-orange-600">npm install -g unbrowse</div>
            <div className="text-orange-600 mt-1">unbrowse go https://example.com</div>
            <div className="text-text-muted mt-1"># Browse normally. Close the tab. Unbrowse captures everything.</div>
          </div>
        </section>
      </article>
    </div>
  );
}
