# Google Indexed the Web for Humans. Who Indexes It for Agents?

*The routing layer of the agentic internet.*

---

In 1998, two Stanford PhD students observed that the web was growing faster than any human could navigate it. Pages were multiplying by the millions. The information was there, but finding it was the bottleneck. They built an index -- a map of the web organized by relevance -- and that index became Google. It captured over $2 trillion in value by solving a single problem: **helping humans find what they need on the web.**

Today, a new class of web user is emerging. Not humans -- agents. AI agents that browse websites, extract data, fill out forms, and complete tasks on behalf of people. They are the fastest-growing category in software. OpenClaw has 344K GitHub stars. Claude Code, GPT agents, Cursor, Windsurf -- millions of developers are building with autonomous agents that interact with the web every day.

These agents face the same bottleneck humans faced in 1998: **the web has no index for them.**

## Google's index is for human eyes

Google indexes HTML. It crawls pages, parses text, ranks relevance, and returns links that humans click. The entire pipeline assumes a human on the other end: someone who reads a snippet, clicks a blue link, scans a page, and extracts what they need visually.

Agents do not work this way. When an agent needs the price of a flight on United, it does not need a rendered page with hero images, navigation bars, and cookie consent banners. It needs a JSON object: `{ "price": 342, "currency": "USD", "route": "SFO-NRT" }`. That object already exists -- it is the response from the internal API call that United's frontend makes to render the page. The data was structured before it became HTML. The HTML is a human convenience layer.

Google indexes the human convenience layer. Nobody indexes the machine-readable layer underneath it.

## The discovery tax

Every time an agent visits a website today, it pays a *discovery tax*. It has to figure out, from scratch, how to get the data it needs. Open a headless browser. Render the page. Parse the DOM. Find the right button. Click it. Wait. Parse again. Extract text from pixels. This process takes 5 to 30 seconds and burns thousands of LLM tokens -- per page, per visit.

Worse, every agent pays this tax independently. If a thousand agents need Airbnb pricing data today, a thousand agents will each spend 30 seconds reverse-engineering the same page structure, finding the same API endpoints, and parsing the same response formats. The collective waste is staggering. Millions of redundant browser sessions. Billions of wasted tokens. All because there is no shared memory of what was already discovered.

Our paper, [Internal APIs Are All You Need](https://arxiv.org/abs/2604.00694), benchmarks this across 94 live domains. The numbers are stark: browser-automated agents average 3,404 ms per task. Agents with access to cached routes average 950 ms -- a 3.6x speedup and 90-96% cost reduction. The discovery tax is not a minor inefficiency. It is the dominant cost of agentic web interaction.

## What the agentic web actually needs

The agentic web needs what the human web got in 1998: an index. But a fundamentally different kind.

|                  | Human web index             | Agent web index                                  |
| ---------------- | --------------------------- | ------------------------------------------------ |
| Unit of indexing | HTML pages                  | API routes (endpoints + schemas)                 |
| Consumer         | Human eyeballs              | HTTP clients (agents)                            |
| Output format    | Ranked links + snippets     | Callable routes + structured data                |
| Discovery method | Crawling public HTML        | Passive traffic capture from real usage           |
| Freshness        | Periodic recrawl            | Continuous -- every agent session updates the graph |

Google's index maps URLs to relevance scores. The agent index maps domains to callable routes -- complete with endpoint URLs, request schemas, authentication patterns, and response structures. An agent does not search this index the way a human searches Google. It resolves an intent ("get Airbnb pricing for Tokyo") and gets back a ready-to-call API route, or a prioritized shortlist of candidate routes.

## Building the index collectively

Google built its index with crawlers -- automated bots that systematically visit every page on the web. That approach does not work for API routes. Internal APIs are not linked from sitemaps. They are not exposed in HTML. They are hidden behind JavaScript execution, authentication walls, and dynamic rendering. You cannot crawl them. You can only observe them in use.

Unbrowse builds the index differently: through **passive observation of real agent traffic**. When any agent browses a website through Unbrowse, the network traffic is captured, the API endpoints are reverse-engineered, their schemas are extracted, and the routes are published to a shared graph. The agent that discovered the route gets credit. Every agent that uses the route afterward pays a micro-fee that flows back to the discoverer.

We call this **proof of indexing**. It is a contribution model where the act of using the web as an agent produces value for the entire network. No manual curation. No centralized crawling team. The index grows organically, driven by real demand. Routes that agents actually need get discovered first, because agents discover them by needing them.

## The network effect

This is where the economics get interesting.

Every agent that joins the network makes the index more valuable. More agents means more browsing sessions. More sessions means more routes discovered. More routes means faster resolves for every agent. Faster resolves attract more agents. The flywheel is self-reinforcing.

```
More agents
    ↓
More routes discovered
    ↓
Higher cache hit rate
    ↓
Faster, cheaper resolves
    ↓
More agents join
```

Google had the same dynamic. More users searching meant more click data. More click data meant better rankings. Better rankings attracted more users. But Google's flywheel was powered by humans clicking links. Unbrowse's flywheel is powered by agents calling APIs. The cycle time is orders of magnitude faster, because agents operate at machine speed.

## Route-level economics

Google monetizes at the query level: advertisers pay per click on search results. Unbrowse monetizes at the route level: agents pay per use of a cached route. The difference matters because routes have transparent, measurable value. A cached route that saves an agent 12 seconds and 8,000 tokens is worth a specific, calculable amount. There is no ambiguity about the value delivered.

Route fees are settled via x402 micropayments -- HTTP-native payments where the cost of a route is embedded in the protocol itself. An agent evaluates whether the route fee is lower than the expected cost of rediscovery. If yes, it pays the fee and gets instant structured data. If no, it falls back to browser-based discovery. The market is self-correcting: overpriced routes get bypassed, underpriced routes attract volume.

Contributors earn proportionally to the value their routes generate. Discover a high-traffic route -- say, Amazon product pricing -- and you earn every time an agent uses it. The incentive structure aligns contribution with actual utility, not speculation.

## Why now

Three things had to be true for this to work, and all three became true in the past 18 months.

### 1. Agents became real users of the web

Before 2025, AI agents were demos. Now they are production infrastructure. Claude Code writes and deploys software. GPT agents manage workflows. OpenClaw orchestrates multi-step tasks across dozens of websites. Agents are not a hypothetical user base -- they are already here, already browsing, already paying the discovery tax millions of times per day.

### 2. Micropayments became protocol-native

x402 enables HTTP-level payments -- a server can price a route, and a client can pay for it, in the same request-response cycle. No subscriptions. No API keys. No billing dashboards. This makes per-route pricing viable at scale, which is what allows the contribution incentive to work.

### 3. The browser runtime shrank to near-zero

Kuri, the Zig-native CDP broker that powers Unbrowse, is 464 KB with a 3 ms cold start. It makes browser-based discovery cheap enough to use as a fallback. The three-path execution model -- local cache, shared graph, or browser fallback -- only works when the fallback is fast enough that agents do not avoid it.

## The infrastructure opportunity

Google is a $2 trillion company because it owns the routing layer between humans and information. It does not own the websites. It does not own the content. It owns the index -- the map that tells you where to go. Whoever builds the equivalent index for the agentic web captures the routing layer between agents and the machine-readable internet.

This is not a feature. It is not a product. It is infrastructure. The kind of infrastructure that, once established, becomes the default path. Every agent that needs web data will either discover routes independently (slow, expensive, redundant) or consult the shared index (fast, cheap, improving). The economics always converge on the index.

We are early. The index today covers hundreds of domains and thousands of routes. The web has billions of both. But Google started with a graduate project indexing a fraction of the web, and the network effects did the rest. The same dynamics apply here, except the agents contributing to the index never sleep, never slow down, and operate at a pace no human crawler ever could.

---

## Contribute to the index

The index is being built right now, by agents and developers around the world. Every browsing session that discovers a new route makes the network more valuable for everyone.

- **Read the paper**: [Internal APIs Are All You Need](https://arxiv.org/abs/2604.00694) (arXiv 2604.00694)
- **Install**: `npm install -g unbrowse`
- **Repository**: [github.com/unbrowse-ai/unbrowse](https://github.com/unbrowse-ai/unbrowse)

---

*Tham, Garcia, Hahn. Internal APIs Are All You Need. arXiv 2604.00694, 2026.*
