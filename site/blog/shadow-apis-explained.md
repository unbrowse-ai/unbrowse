# Shadow APIs: The Hidden API Layer Every Website Already Has

*What they are, how Unbrowse discovers them, and why they matter for AI agents.*

---

Open any modern website. Search for something. Filter results. Load a profile page. Every one of those actions triggers network requests behind the scenes -- HTTP calls from the site's own JavaScript to its own backend. These are not public APIs. They are not documented in any developer portal. But they are fully functional, structured, and callable.

We call them **shadow APIs**.

In our paper [Internal APIs Are All You Need](https://arxiv.org/abs/2604.00694), we tested 94 live domains. Every single one had discoverable shadow APIs. This post explains what they are, how Unbrowse finds them, and what the capture pipeline looks like end to end.

## What exactly is a shadow API?

A shadow API is a first-party HTTP endpoint that a website calls from its own frontend JavaScript to fetch or mutate data. The term "shadow" captures two properties: the endpoints exist in the shadow of the visible UI, and they are invisible to anyone who does not inspect network traffic.

They are distinct from:

- **Public APIs** -- documented endpoints with published schemas, API keys, and rate limit contracts (e.g. the Twitter/X API, Stripe API).
- **Third-party APIs** -- calls to external services like analytics, ad networks, or CDNs. These are not the site's own data.
- **Server-side rendering** -- some frameworks embed data directly in the initial HTML payload. Shadow APIs are the subsequent fetch/XHR calls that load dynamic content after the page renders.

Shadow APIs are the site talking to itself. The frontend is the client; the backend is the server. The browser is just a middleman rendering the response for human eyes.

## Real examples from 94 domains

When you use a website, the browser's DevTools Network tab reveals what is really happening. Here are representative shadow API patterns we captured across different categories of sites.

### Search endpoints

Nearly every site with a search bar calls a JSON endpoint behind the scenes. The user types a query; the frontend calls an API; the response is structured data that gets rendered into the result list.

```
# Reddit -- subreddit search
GET /search/suggestions?q=machine+learning&include_over_18=false
-> { suggestions: [{ name: "r/MachineLearning", subscriber_count: 3200000 }...] }

# Amazon -- product search with autocomplete
GET /api/suggestions?prefix=mechanical+keyboard&mid=ATVPDKIKX0DER
-> { suggestions: ["mechanical keyboard wireless", "mechanical keyboard 60%"...] }

# Hacker News -- Algolia-powered search
GET /api/v1/search?query=shadow+api&tags=story&hitsPerPage=30
-> { hits: [{ title: "...", url: "...", points: 142 }...] }
```

### Content feed endpoints

Infinite scroll, pagination, and "load more" buttons all fetch content from paginated API endpoints. The data is JSON before it becomes HTML cards.

```
# YouTube -- video recommendations
POST /youtubei/v1/browse?key=AIza...
-> { contents: { richGridRenderer: { contents: [{ videoRenderer: { videoId, title, viewCount } }...] } } }

# GitHub -- repository file listing
GET /repos/unbrowse-ai/unbrowse/contents/src?ref=main
-> [{ name: "cli.ts", type: "file", size: 4521 }...]

# Airbnb -- listing details
GET /api/v3/StaysPdpSections?operationName=StaysPdpSections&variables=...
-> { data: { presentation: { stayProductDetailPage: { sections: [...] } } } }
```

### Authentication-gated endpoints

Logged-in actions -- viewing your dashboard, posting a comment, checking notifications -- use shadow APIs authenticated via session cookies or bearer tokens that the browser already holds.

```
# LinkedIn -- notifications feed
GET /voyager/api/dash/notifications?decorationId=...&count=20
Headers: csrf-token: ajax:123..., cookie: li_at=AQE...
-> { elements: [{ actor: "...", notificationType: "PROFILE_VIEW" }...] }

# Notion -- page content
POST /api/v3/loadPageChunk
Body: { pageId: "abc-123", limit: 50, chunkNumber: 0 }
-> { recordMap: { block: { "abc-123": { value: { type: "page", properties: { title: [["My Doc"]] } } } } } }
```

### GraphQL endpoints

Many modern sites use GraphQL internally. A single endpoint handles all queries, differentiated by `operationName`. These are particularly information-dense shadow APIs.

```
# X/Twitter -- timeline (GraphQL)
POST /i/api/graphql/abc123/HomeTimeline
Body: { variables: { count: 20 }, features: { ... } }

# Shopify storefront -- product query
POST /api/2024-01/graphql.json
Body: { query: "{ product(handle: \"widget\") { title, price } }" }
```

## Why every website has shadow APIs

This is not a quirk of certain frameworks. It is a structural consequence of how the modern web works.

In the early web, servers rendered full HTML pages on every request. Click a link, get a new page. There was no separation between data and presentation -- the API was the HTML.

Starting around 2010, the industry shifted to single-page applications (SPAs) and client-side rendering. React, Angular, Vue, and their successors all follow the same architectural pattern: the browser loads a JavaScript shell, then the shell calls backend APIs to fetch data and renders it into the DOM.

That architectural shift created a universal invariant:

> **Every interactive website must have an internal API.** The frontend needs structured data from the backend. The only transport is HTTP. Therefore, every site has callable HTTP endpoints that return structured data.

Even server-rendered frameworks like Next.js and Remix create API routes for client-side data fetching, form submissions, and real-time updates. The architectural style varies -- REST, GraphQL, tRPC, custom JSON-RPC -- but the invariant holds. If the page is interactive, there is an API underneath.

## How Unbrowse discovers shadow APIs

Unbrowse uses a dual-layer interception strategy: passive HAR recording via the Chrome DevTools Protocol (CDP), plus an active JavaScript interceptor injected into the page. Together, they capture every network request the site makes.

### Layer 1: CDP network recording

Unbrowse runs a lightweight CDP broker called Kuri (464 KB, ~3 ms cold start, written in Zig). Kuri attaches to Chrome and enables `Network.enable` to record every HTTP request and response into a HAR (HTTP Archive) log. This catches standard page loads, XHR, and fetch calls at the protocol level.

```
# Simplified CDP capture flow
Kuri -> Chrome DevTools Protocol
    -> Network.enable
    -> Network.requestWillBeSent   # capture request
    -> Network.responseReceived     # capture response headers
    -> Network.getResponseBody      # capture response body
    -> HAR entry assembled
```

### Layer 2: JavaScript fetch/XHR interceptor

CDP's HAR recording misses some requests on SPAs -- particularly those fired during rapid client-side navigation or from Web Workers. To close this gap, Unbrowse injects a small JavaScript interceptor that monkey-patches `window.fetch` and `XMLHttpRequest`. Every outbound request and its response are captured in-page before the site's own code sees the response.

```javascript
// Interceptor pseudocode (injected into page)
const originalFetch = window.fetch;
window.fetch = async (url, opts) => {
  const response = await originalFetch(url, opts);
  const clone = response.clone();
  const body = await clone.text();
  capturedRequests.push({
    url, method: opts?.method || "GET",
    requestHeaders: opts?.headers,
    status: response.status,
    responseBody: body
  });
  return response;
};
```

### Merging and deduplication

When a browse session ends, Unbrowse merges entries from both sources. Requests are deduplicated by URL + method + status code. The interceptor layer fills gaps the HAR missed; the HAR layer provides precise timing and size data the interceptor cannot access.

### The full enrichment pipeline

Raw captured traffic goes through a multi-stage pipeline that transforms it from noisy network logs into clean, callable API skills:

```
# Unbrowse enrichment pipeline

1. extractEndpoints      # Filter noise: strip analytics, ads, static assets
                         # Keep only first-party JSON/API endpoints

2. extractAuthHeaders    # Identify auth patterns: cookies, bearer tokens,
                         # CSRF tokens, API keys in headers/query params

3. storeCredential       # Save auth credentials to local encrypted vault

4. mergeEndpoints        # Merge with any existing skill for this domain
                         # Deduplicate, update schemas, preserve history

5. generateDescription   # LLM generates human-readable descriptions
                         # from URL patterns, params, response shapes

6. augmentWithAgent      # LLM adds semantic metadata: what does this
                         # endpoint actually do? What are the params?

7. buildOperationGraph   # Map dependencies between endpoints
                         # (e.g., search -> detail -> checkout)

8. publishSkill          # Cache locally + publish to shared marketplace
```

The output is a "skill" -- a structured document containing every discovered endpoint for a domain, with schemas, auth requirements, descriptions, and an operation graph. Any agent can use this skill to call the site's shadow APIs directly, without ever opening a browser.

## Separating signal from noise

A single page load can generate 50 to 200+ network requests. Most of them are not shadow APIs. The `extractEndpoints` stage applies several filters:

| Filtered out | Why |
|---|---|
| `*.google-analytics.com/*` | Third-party analytics -- not the site's data |
| `*.cloudfront.net/*.js` | Static assets -- JavaScript bundles, CSS, images |
| `*.doubleclick.net/*` | Ad network calls |
| `*/favicon.ico` | Browser chrome, not data |
| `*/socket.io/*` | WebSocket handshakes (tracked separately) |

What remains are first-party endpoints returning JSON (or occasionally XML/protobuf) responses. These are the shadow APIs -- the actual data layer powering the site.

## 94 domains, 100% discovery rate

For the paper, we benchmarked Unbrowse against 94 live domains spanning e-commerce, social media, developer tools, news, travel, finance, and more. The key finding:

> **Every single domain had at least one discoverable shadow API endpoint.** The median domain exposed 6 distinct endpoints from a single browse session. Some domains exposed 20+.

The distribution across categories:

| Category | Example domains | Typical pattern |
|---|---|---|
| E-commerce | Amazon, eBay, Etsy | Search, product detail, pricing, reviews |
| Social | Reddit, LinkedIn, X | Feed, profile, search, notifications |
| Developer tools | GitHub, npm, Stack Overflow | Repo contents, package metadata, Q&A |
| News / media | HN, TechCrunch, Reuters | Article feed, search, comments |
| Travel | Airbnb, Booking.com | Listing detail, availability, pricing |
| Finance | Yahoo Finance, CoinGecko | Quotes, charts, portfolio |

## From shadow API to agent skill

Discovering an endpoint is only the first step. To be useful to an AI agent, the endpoint needs context: what does it do, what parameters does it accept, what does the response look like, and how does it relate to other endpoints on the same domain?

Here is what a single captured endpoint looks like after the full enrichment pipeline:

```json
{
  "method": "GET",
  "url_template": "/search/suggestions?q={query}&include_over_18={nsfw}",
  "description": "Search Reddit for subreddit suggestions matching a query",
  "params": {
    "q": { "type": "string", "required": true, "description": "Search query" },
    "include_over_18": { "type": "boolean", "default": false }
  },
  "auth": { "type": "cookie", "keys": ["reddit_session"] },
  "response_schema": {
    "suggestions": [{ "name": "string", "subscriber_count": "number" }]
  },
  "observed_latency_ms": 142,
  "last_verified": "2026-04-01T12:00:00Z"
}
```

An agent seeing this skill knows exactly how to call the endpoint, what to pass, what to expect back, and how to authenticate. No browser needed. No DOM parsing. No screenshots. Just an HTTP call that returns structured data in ~140 ms.

## The performance case

Calling shadow APIs directly versus automating a browser is not a marginal improvement. It is a category change in execution characteristics:

| Metric | Browser automation | Shadow API (cached) |
|---|---|---|
| Latency (mean) | 3,404 ms | **950 ms** |
| Tokens per task | ~8,000 | **~200** |
| Mean speedup | 1x (baseline) | **3.6x** |
| Median speedup | 1x (baseline) | **5.4x** |
| Cost reduction | Baseline | **90-96%** |

Cold-start discovery (first time seeing a domain) averages 12.4 seconds. But that cost amortizes within 3-5 reuses. After that, every subsequent agent call to that domain hits the cache and executes in under a second.

## Why this matters for AI agents

The existence of universal shadow APIs has a direct consequence for agent architecture. The dominant approach today -- launching a headless browser, rendering pages, taking screenshots, sending pixels to an LLM -- is doing unnecessary work. The data was structured JSON before the browser rendered it into pixels. The entire rendering pipeline exists only because agents are using human interfaces instead of machine interfaces.

Shadow APIs are the machine-native interface layer. They already exist on every website. The only missing piece was infrastructure to discover, index, and share them.

That is what Unbrowse provides: a system that passively captures shadow APIs from real browsing, enriches them into structured skills, caches them locally, and publishes them to a shared marketplace so every agent on the network benefits from every discovery.

---

## Read the paper. Try it yourself.

The full research paper covers the shared route graph architecture, benchmark methodology across 94 domains, the three-path execution model, and economic analysis of route-level pricing.

- [Read the paper on arXiv](https://arxiv.org/abs/2604.00694)
- [Paper summary page](https://www.unbrowse.ai/internal-apis-are-all-you-need)
- [GitHub repository](https://github.com/unbrowse-ai/unbrowse)

```bash
# Install Unbrowse and discover your first shadow APIs
npm install -g unbrowse
unbrowse go https://example.com
# Browse normally. Close the tab. Unbrowse captures everything.
```

*[unbrowse.ai](https://www.unbrowse.ai)*
