# Every MCP Server Is a Mass Hallucination

*10,000 hand-written API wrappers. 99% of the web still uncovered. The APIs already exist — we just keep ignoring them.*

---

Open GitHub and search for "MCP server." You will find over ten thousand repositories. Each one is a hand-written wrapper around a single API. There is an MCP server for Stripe, one for Notion, one for Jira, one for Linear, one for GitHub, one for Slack. Someone wrote one for Hacker News. Someone else wrote a different one for Hacker News.

It is one of the largest collective engineering efforts in the AI tool ecosystem. And it is almost entirely a waste of time.

## The wrapper treadmill

The thesis behind MCP servers is straightforward: agents need structured tools, APIs provide structured interfaces, so we write wrappers that expose APIs as tools. Reasonable in theory. Broken in practice, for three reasons.

1. **Most of the web has no official API.** The ten thousand MCP servers on GitHub cover maybe a few hundred services. There are hundreds of millions of websites. The overwhelming majority have zero documented API. No OpenAPI spec. No developer portal. No API key signup page. The entire MCP approach silently assumes the API exists and is documented. For 99% of the web, it does not.

2. **The APIs that exist change constantly.** Stripe changes its API versioning. Notion adds new block types. Jira restructures its REST endpoints. Every change breaks the wrapper. Every broken wrapper requires a human to notice, diagnose, and fix. Multiply that by ten thousand repositories maintained by volunteers with day jobs. The median MCP server on GitHub has not been updated in months. Many are already broken.

3. **You cannot write your way to coverage.** Even if every wrapper were perfect, the approach requires one hand-written integration per service. That is a linear scaling function against a web that grows exponentially. You will never catch up. You will never cover the long tail. You will certainly never cover the internal tools, admin panels, and niche SaaS products where agents could deliver the most value.

## The APIs already exist

Here is the part that makes the MCP server treadmill especially absurd: every website already has APIs. They are the internal endpoints that power the UI.

When you load a Reddit thread, your browser does not receive a pre-rendered HTML document. It calls `GET /api/v1/comments/t3_abc123` and gets back JSON. When you search Airbnb, your browser calls `GET /api/v3/StaysSearch`. When you check your bank balance, your browser calls an internal REST endpoint that returns structured account data.

These are not theoretical APIs. They are production APIs that handle millions of requests per day. They have authentication. They have rate limits. They have schemas. They are the most battle-tested interfaces on the internet. The only difference from a "public API" is that nobody wrote documentation for them.

The MCP ecosystem is an enormous effort to hand-write wrappers for the tiny fraction of the web that publishes API docs. Meanwhile, the actual API layer that powers the entire web sits right there, undiscovered, behind every single website.

## What if you just discovered them?

This is the question we started with at Unbrowse. Instead of writing one wrapper per service, what if agents could discover the internal APIs automatically, from real browsing traffic?

The approach is simple. Browse a website normally. Capture the network traffic. Extract the API endpoints, their request schemas, authentication headers, and response structures. Publish them as reusable skills. Every future agent on the network skips the discovery step entirely and calls the API directly.

We tested this across 94 live domains and published the results in a peer-reviewed paper.

## The numbers

| Metric | Value |
|--------|-------|
| Mean speedup over Playwright | **3.6x** |
| Median speedup | **5.4x** |
| Cached API call latency | **<100ms** |
| Cost reduction per task | **90-96%** |
| Warmed-cache avg execution | **950ms** (vs 3,404ms Playwright) |
| Cold-start discovery | **12.4s** (amortizes in 3-5 reuses) |

Once a site is discovered, every subsequent agent call is a direct HTTP request.

Source: [Internal APIs Are All You Need](https://arxiv.org/abs/2604.00694) (arXiv:2604.00694), 94-domain benchmark.

## Why the MCP ecosystem is a hallucination

The word "hallucination" is not hyperbole. The MCP server ecosystem shares the same structural defect as LLM hallucinations: it looks correct, it feels productive, and it confidently produces output. But it is disconnected from ground truth.

The ground truth is this: the web already has a machine-native interface layer. It is the internal API calls that every website makes on every page load. The MCP approach ignores this layer entirely and instead builds a parallel, manually maintained, perpetually incomplete replica of it.

Consider what happens when someone wants their agent to interact with a new SaaS product:

**MCP approach:**
1. Check if someone wrote an MCP server for it
2. They probably did not
3. Check if the service has a public API
4. It probably does not, or it is incomplete
5. Write a wrapper from the API docs
6. Test it, debug it, maintain it
7. Repeat for the next service

Time to first call: hours to days.

**Unbrowse approach:**
1. Browse the website once
2. Internal APIs are discovered automatically
3. Schemas and auth are reverse-engineered
4. Published to a shared index
5. Every agent can call them directly

Time to first call: seconds.

## The scaling argument

There are roughly 200 million active websites. The MCP ecosystem covers a few hundred of them. That is not a rounding error. It is a coverage rate so low that the word "coverage" barely applies.

The fundamental problem is that hand-written wrappers require human effort proportional to the number of services. That is an O(n) solution to an O(n) problem, which means you never get ahead. Every new SaaS product, every new internal tool, every new admin panel requires someone to sit down and write another wrapper.

Automated discovery inverts this. The cost of discovery is paid once per site and amortized across every agent that uses it. The shared index grows with usage, not with human effort. When one agent discovers the APIs behind a niche HR tool, every agent on the network gains access. The more agents participate, the faster the index grows, and the less any individual agent needs to discover on its own.

This is the difference between a library and a network. MCP servers are a library: someone has to write each book. Unbrowse is a network: every participant makes it more valuable for everyone else.

## Objections

**"Internal APIs aren't stable. They change without notice."** So do public APIs. The difference is that internal APIs are continuously validated by the website itself. If the internal API breaks, the website breaks. That makes them the most reliable interfaces available. And when they do change, traffic-based discovery detects the drift automatically and re-captures.

**"MCP servers give you nice, typed tool definitions."** So does automated schema extraction. Unbrowse reverse-engineers request and response schemas from observed traffic and generates typed interfaces. You get the same structured tool definitions without writing them by hand.

**"This only works for websites with SPAs and JSON APIs."** That describes approximately every website built in the last decade. Server-rendered HTML with no client-side API calls is increasingly rare. Even traditional sites make AJAX calls for search, pagination, and dynamic content.

## What this means for MCP server builders

If you have spent weeks building MCP servers, your work was not wasted. You understand the problem better than most: agents need structured, callable interfaces to the web. That insight is correct.

But the solution is not to keep writing wrappers. The solution is to automate discovery. The APIs your wrappers expose are a subset of the APIs that already exist inside every website. The hard part was never writing the wrapper. It was finding the endpoint, understanding its schema, and keeping it working as the service evolves. That is exactly the part that can be automated.

The MCP protocol itself is fine. It is a reasonable standard for how agents communicate with tools. The hallucination is the ecosystem built on top of it: the assumption that the only way to give agents web access is to hand-write one integration at a time.

## Stop writing wrappers. Start discovering APIs.

Unbrowse discovers the internal APIs behind any website automatically and makes them callable by any agent. One install. No wrappers. No maintenance.

```bash
npm install -g unbrowse
```

- [Read the paper](https://arxiv.org/abs/2604.00694)
- [View on GitHub](https://github.com/unbrowse-ai/unbrowse)
- [unbrowse.ai](https://www.unbrowse.ai)
