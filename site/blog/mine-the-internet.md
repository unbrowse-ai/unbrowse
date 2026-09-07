# Mine the Internet

*Google indexed the web for humans and became worth $2T. The agentic web needs its own index. You can build it and get paid.*

---

**TL;DR:** Unbrowse turns normal web browsing into mining. Every site you visit discovers internal API routes that get indexed into a shared graph. When AI agents use those routes, you earn 70% of the $0.005 resolve fee in USDC via x402 micropayments. First indexer of a domain earns 2x for 30 days. No GPUs, no staking, no tokens. Just browse the web and get paid.

---

## The economics at a glance

| Metric | Value |
|---|---|
| Revenue share to route creators | **70%** |
| Cost per cached resolve | **$0.005** |
| Cost per browser-based resolve | **$0.53** |
| Cost reduction | **106x** |
| First-mover bonus | **2x for 30 days** |
| Hardware required | **None** |

## Mine your first route in 60 seconds

```bash
npm install -g unbrowse
unbrowse resolve "search github for openai"
```

That is it. Unbrowse opened a browser, navigated to GitHub, captured the search API, indexed the route, and returned the result. The endpoint is now in the shared graph, attributed to you, earning every time an agent uses it.

---

## What is web mining?

Every website you use runs on internal APIs. When you search GitHub, your browser calls a JSON endpoint. When you scroll Reddit, fetch requests pull post data from a backend service. When you check a price on Amazon, an XHR call returns structured product information. These internal APIs are the real interface layer of the web. Humans never see them. AI agents need them.

Web mining is the act of discovering these internal APIs and contributing them to a shared index. With Unbrowse, mining is not a separate activity. It is what happens automatically when you browse. Visit a site, and Unbrowse captures the network traffic between your browser and the server. It identifies every fetch and XHR call, reverse-engineers the schema, authentication pattern, and parameters, and publishes the route to a shared graph.

That is a mining event. You just indexed a piece of the internet that AI agents can now use directly instead of launching a headless browser, rendering JavaScript, and scraping pixels. Every route you contribute is attributed to your wallet. Every time an agent uses that route, you earn.

## How the economics work

When an AI agent resolves a task through the shared route graph, it pays $0.005 per cached route. That fee splits three ways: 70% to the route creator, 20% to the platform for infrastructure and quality verification, and 10% reserved for future site-owner royalties.

Compare that to the alternative. A fresh browser-based resolve — launching headless Chrome, rendering the page, navigating the DOM, extracting data — costs $0.53 on average. That is a 106x cost difference. Agents are economically rational. Given a choice between $0.53 and $0.005 for the same result, they will choose the cached route every single time.

This means demand is automatic. The moment your route exists in the graph, any agent that needs it will prefer it over browser automation. You do not need to market your routes or find buyers. The cost advantage does the selling for you.

Your 70% share means you earn $0.0035 per resolve. One route on a popular domain, used 1,000 times per day, earns $3.50 daily. That is $105 per month from a single endpoint you discovered by browsing a website you were already going to visit.

## High-value domains to mine

Not all routes are equal. The most valuable routes are on domains that AI agents query most frequently. Developer tools, search engines, social platforms, and business infrastructure generate the highest agent traffic.

**GitHub** is the most-queried domain in agent workflows. Every coding agent searches repos, reads files, checks issues, and reviews pull requests. GitHub's internal APIs handle repository search, code search, file content retrieval, issue listing, and pull request metadata. A complete index of GitHub's route surface is worth orders of magnitude more than a niche blog.

**Google Search, Reddit, StackOverflow, LinkedIn, Stripe, AWS, Hacker News, npm, PyPI** — these are the domains where agent traffic concentrates. Each has dozens to hundreds of internal endpoints that power their frontends. Most have never been systematically indexed for machine consumption.

The strategy is straightforward: mine where the agents go. If you were prospecting for gold, you would dig where the geological surveys say gold is. The geological survey for web mining is simple: look at what agents are already trying to do, and index the domains they need.

## First-mover advantage: 2x for 30 days

The first person to index a domain earns a **2x reward multiplier** on all routes from that domain for 30 days. If you are the first to index Stripe's dashboard APIs, you earn $0.007 per resolve instead of $0.0035 for the first month. On a high-traffic domain, that bonus compounds fast.

This creates a land-rush dynamic anchored to real utility. Your 2x bonus only matters if agents actually use the routes. Indexing a dead domain nobody queries earns nothing regardless of the multiplier. The incentive rewards useful work on high-value targets, not speculative squatting.

The 30-day window also solves the cold-start problem. Early contributors take the most risk — they are indexing domains before agent traffic has fully materialized. The 2x multiplier compensates that risk. As the network matures and agent volume grows, the base 70% share becomes the dominant earning driver.

After 30 days, the bonus expires and the domain enters open competition. Anyone can index better routes and capture traffic. First-movers keep earning on their routes as long as those routes remain the highest-quality version in the graph. Quality, not timing, determines long-term earnings.

## Getting started

Install Unbrowse with one command. No accounts, no API keys, no configuration. The CLI is all you need.

```bash
npm install -g unbrowse
```

Run your first resolve:

```bash
unbrowse resolve "search github for openai"
```

Unbrowse will open a browser, navigate to GitHub, capture the search API call, index the route, and return the result. You just mined your first route. That endpoint is now in the shared graph, attributed to you, earning every time an agent uses it.

Go deeper. Browse GitHub's issue pages, pull request views, code search, user profiles. Each page triggers different API endpoints. Each endpoint becomes a new route in the graph. A thorough session on one domain can yield 20 to 50 routes.

Every resolve command you or any agent runs also contributes to the index. If the route is already cached, the resolve is instant and the original contributor earns. If it is not cached, Unbrowse falls back to a browser session, captures the traffic, indexes the routes, and publishes them. The agent itself becomes a miner. Usage is contribution.

## Mining strategies

**Go deep on one domain before going wide.** A complete route surface for one high-value site is worth far more than scattered single-page indexes across hundreds of sites. Agents need complete flows — search, navigate to detail, extract structured data. If you only index the search endpoint but not the detail endpoint, the agent still has to fall back to a browser for the second step.

**Authentication flows are the highest-value routes.** Any endpoint behind a login wall is expensive for agents to reach through browser automation — they have to manage cookies, handle CAPTCHAs, deal with session expiry. A cleanly indexed authenticated endpoint that handles auth headers properly is rare and commands premium traffic.

**GraphQL endpoints are particularly valuable.** Many modern apps (GitHub, Reddit, Shopify, Airbnb) use GraphQL internally. A single GraphQL endpoint with the right operation names and variables can replace dozens of REST-style page scrapes. GraphQL routes are underrepresented in the graph because they require POST requests with specific payloads — standard crawlers miss them entirely.

**Watch for pagination patterns.** An endpoint that returns page 1 of search results is useful. An endpoint with documented cursor or offset parameters that lets agents paginate through all results is far more useful. Index the full parameter space, not just the default call.

## The network effect

Web mining has a self-reinforcing flywheel. More miners discover more routes. More routes mean faster, cheaper resolves for agents. Faster, cheaper resolves attract more agents to the network. More agents mean more resolve volume. More resolve volume means more earnings for miners. More earnings attract more miners.

This is the same flywheel that made Google Search dominant, but with one critical difference: the value flows to contributors, not to a single corporation. Google's crawlers built the index and Google captured all the ad revenue. In the Unbrowse network, the miners who build the index earn 70% of every transaction it generates.

The flywheel also creates a quality ratchet. When two miners index the same domain, the route graph serves the higher-quality version. Low-reliability routes get less traffic. High-reliability routes get more. Miners are incentivized to maintain and improve their routes over time because stale routes lose traffic to better alternatives. The network self-improves.

At critical mass, the shared route graph becomes the default way agents interact with the web. Every website effectively gets a machine-readable API layer maintained by the community that uses it. That is the endgame: a collectively built, usage-priced index of the entire callable web.

## Earnings calculator

The math is transparent. Take any domain you want to mine, estimate the agent traffic it receives, and multiply.

**Conservative scenario:** you index 50 routes on 2 popular domains (100 total routes). Each route averages 20 resolves per day. At $0.0035 per resolve, that is $7 per day, $210 per month, $2,520 per year. With the first-mover 2x bonus on one domain, the first month jumps to $315.

**Moderate scenario:** you index 100 routes across 5 high-traffic domains. Each route averages 50 resolves per day. That is $17.50 per day, $525 per month, $6,300 per year.

**Power miner scenario:** you systematically index 500 routes across 20 domains, focusing on the highest-traffic sites. Each route averages 100 resolves per day. That is $175 per day, $5,250 per month, $63,000 per year.

### Earnings by mining intensity

| Strategy | Routes indexed | Avg resolves/day/route | Monthly earnings | Annual earnings |
|---|---|---|---|---|
| Casual | 100 | 20 | $210 | $2,520 |
| Focused | 250 | 50 | $1,312 | $15,750 |
| Power miner | 500 | 100 | $5,250 | $63,000 |
| Network operator | 2,000 | 200 | $42,000 | $504,000 |

*At $0.0035 contributor share per resolve. First-mover 2x bonus not included.*

### Network economics at scale

| Network agents | Daily resolves | Daily payout (all miners) | Annual payout |
|---|---|---|---|
| 1,000 | 100,000 | $350 | $127,750 |
| 10,000 | 1,000,000 | $3,500 | $1,277,500 |
| 100,000 | 10,000,000 | $35,000 | $12,775,000 |
| 1,000,000 | 100,000,000 | $350,000 | $127,750,000 |

*Assumes 100 resolves per agent per day at $0.005 per resolve. Payout reflects the 70% contributor share.*

These are not speculative projections based on token appreciation. They are arithmetic based on usage volume and a fixed fee. If agent traffic grows — and it is growing exponentially as Claude Code, Cursor, Windsurf, and other frameworks gain adoption — every number above scales proportionally.

## How this compares to crypto mining

Bitcoin mining requires specialized hardware (ASICs), significant electricity costs, and technical infrastructure. The resource being contributed is raw compute — SHA-256 hashes that secure the blockchain but produce nothing reusable. The value comes from scarcity and consensus, not from the utility of the work itself.

Web mining requires a laptop and a web browser. The resource being contributed is knowledge — the discovery and documentation of callable web interfaces. Every unit of mining work produces a real, reusable API route that makes the internet more accessible to machines. The value comes from utility, not from artificial scarcity.

No GPUs. No electricity bill. No mining pools. No hardware depreciation. No noise, no heat, no dedicated facility. You browse the websites you already use. Unbrowse captures the routes in the background. You earn when agents use them. The barrier to entry is `npm install`.

There is also no Unbrowse token. Earnings are in USDC — a stablecoin pegged to the US dollar. There is no speculative asset to trade, no tokenomics to decode, no governance votes to track. Agents pay for routes. Contributors earn for indexing them. The economics are simple enough to fit on a napkin.

## x402: how the money moves

Payments use the **x402 protocol** — HTTP-native micropayments settled in USDC on Solana and Base. When an agent resolves a route, the payment happens inline with the HTTP request. No invoices. No billing cycles. No payment minimums. The agent's wallet signs the payment, the route serves the data, and the contributor's wallet receives the fee. One round trip.

Solana and Base were chosen for fast finality and low gas costs. A $0.005 micropayment cannot work if the transaction fee is $2. On Solana, the settlement cost is a fraction of a cent. The full $0.0035 contributor share arrives in your wallet, not eaten by gas.

Contributors can withdraw earnings to any wallet, swap to fiat through standard off-ramps, or let them accumulate. There is no lockup period, no vesting schedule, no minimum withdrawal. Your earnings are yours the moment agents use your routes.

## The research behind it

The technical foundations are documented in the peer-reviewed paper "Internal APIs Are All You Need" ([arXiv:2604.00694](https://arxiv.org/abs/2604.00694)). The paper benchmarks 94 live domains and shows a 3.6x mean speedup and 5.4x median speedup over Playwright browser automation, with 90-96% per-task cost reduction for warmed-cache execution.

The shared route graph architecture, discovery tax analysis, three-path execution model (local cache, shared graph, browser fallback), and route-level economics are all covered in detail. The benchmark methodology is open and reproducible.

This is not vaporware backed by a whitepaper. The system works today. Install Unbrowse, run a resolve, and verify the speedup yourself. The routes you discover in the process are real contributions that earn real USDC.

---

## Start mining

```bash
npm install -g unbrowse
```

No GPUs. No staking. No tokens. Just USDC for useful work.

- [GitHub](https://github.com/unbrowse-ai/unbrowse)
- [npm](https://www.npmjs.com/package/unbrowse)
- [Proof of Indexing](https://www.unbrowse.ai/proof-of-indexing)
- [Whitepaper: Internal APIs Are All You Need](https://www.unbrowse.ai/internal-apis-are-all-you-need)
- [arXiv paper](https://arxiv.org/abs/2604.00694)
