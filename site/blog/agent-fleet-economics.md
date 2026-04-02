# Your Agent Fleet Can Fund Itself

*You're paying $0.53 per browser action. Your agents could be earning that back -- and more.*

---

## The fleet cost problem nobody talks about

You are running a fleet of AI agents. Maybe 10 for internal tooling. Maybe 50 for customer-facing workflows. Maybe 100 across a platform. Every one of them interacts with websites. And every one of them is paying a hidden tax.

Each browser action -- navigate, click, extract -- costs roughly **$0.53** when you account for compute (500 MB RAM per headless Chrome instance), LLM tokens for visual grounding (8,000-12,000 tokens per screenshot), and wall-clock time (3-30 seconds per interaction). This is not a theoretical number. It comes from benchmarking 94 production websites, published on [arXiv (2604.00694)](https://arxiv.org/abs/2604.00694).

```
What a 50-agent fleet actually costs per month:

50 agents x 200 browser actions/day x 30 days = 300,000 actions/month
300,000 actions x $0.53 = $159,000/month

(Browser compute + LLM vision tokens + wall-clock infrastructure)
```

That is the cost of rendering pixels that no human will ever see, screenshotting them, feeding them to a vision model, and extracting the structured data that was already structured before Chrome touched it. For most fleet operators, browser infrastructure is the single largest line item after LLM inference.

## What if that cost center generated revenue?

Every time one of your agents browses a website, it is doing work. It navigates pages, triggers API calls, encounters authentication flows. With Unbrowse, that work is not wasted. Every browse session passively discovers the internal API routes behind the website -- the actual JSON endpoints that power the UI.

Those discovered routes get published to the Unbrowse marketplace. When another agent -- anywhere in the world -- needs to interact with that same website, it pulls the cached route instead of launching a browser. That cached resolve costs $0.005 instead of $0.53. The agent that discovered the route earns 70% of that fee.

```
The economics flip:

Browser action: you pay $0.53
Cached resolve: someone pays $0.005 -> you earn $0.0035
```

Your agents stop being pure consumers of web infrastructure. They become producers. Every site they touch adds routes to the shared graph. Every route they contribute earns revenue when other agents use it. The fleet funds itself.

## How passive discovery works

There is no extra work. Your agents do not need to change their behavior. Unbrowse sits in the execution path and captures what happens naturally:

**1. Agent browses a site.** Your agent navigates to a URL. Unbrowse opens the page through Kuri (a 464 KB agent-native browser) and passively records all network traffic -- every fetch, XHR, and API call the page makes.

**2. Routes are reverse-engineered.** On session close, captured traffic goes through the enrichment pipeline: endpoint extraction, auth header detection, credential storage, schema inference, and LLM-augmented semantic descriptions. The result is a complete, executable API skill.

**3. Routes publish to the marketplace.** Discovered routes are published to the shared graph with your agent as the contributor. When any agent resolves against that domain, it pulls your route. You earn 70% of the $0.005 resolve fee.

**4. Subsequent calls skip the browser.** Once a route is cached, no browser is launched. No 500 MB of RAM. No screenshot. No vision model. Just a direct API call that returns in under a second at $0.005 instead of $0.53.

## The fleet economics at scale

Here is where it gets interesting. Discovery cost is paid once. Revenue from that discovery is earned every time another agent uses the route.

| Metric | Value |
|--------|-------|
| Revenue per external use | $0.0035 (70% of $0.005) |
| Savings on repeated tasks | 90-96% |
| Reuses to amortize discovery | 3-5 |

### Revenue model: 100-agent fleet

| | |
|---|---|
| Routes discovered per agent | 50 |
| Total routes from fleet | 5,000 |
| External uses per route per month | 100 |
| Total external resolves/month | 500,000 |
| Revenue per resolve | $0.0035 |
| **Monthly marketplace revenue** | **$1,750/month** |

That is the revenue side alone. The cost savings are separate and larger. If those 100 agents each save 150 browser actions per day by hitting cached routes:

### Cost savings: 100-agent fleet

| | |
|---|---|
| Browser actions saved/day | 15,000 |
| Cost avoided per action ($0.53 - $0.005) | $0.525 |
| Daily savings | $7,875 |
| **Monthly cost reduction** | **$236,250/month** |

Combined: $236,250 in cost reduction plus $1,750 in marketplace revenue. The fleet goes from a $159,000/month cost center to a net positive position. The marketplace revenue is a bonus on top of the fundamental cost savings.

## Break-even analysis

The break-even point depends on two factors: how many routes your fleet discovers and how often external agents use them. But the cost savings alone justify the switch at any fleet size.

**Cost savings break-even: day one.** Every cached route that replaces a browser action saves $0.525 immediately. A single agent hitting 10 cached routes per day saves $5.25/day. There is no payback period -- the savings are instant.

**Discovery amortization: 3-5 uses.** Cold-start discovery takes 12.4 seconds on average. At $0.53 per browser action, that discovery cost is recovered after 3-5 cached reuses of the same route. Everything after that is pure savings.

**Marketplace revenue break-even: depends on route popularity.** A route used 100 times externally earns $0.35. A route used 10,000 times earns $35. High-traffic domains (e-commerce, social, travel) amortize fastest. Niche routes earn less but still contribute.

The economic case does not depend on marketplace revenue. Cost savings alone make the switch rational. Marketplace revenue is upside that compounds as your fleet indexes more of the web.

## The early miner advantage

There is a first-mover dynamic in route discovery. The first agent to index a domain's internal APIs gets a structural advantage:

**2x early indexer rewards for 30 days.** The first contributor to index a domain earns double the standard revenue share for the first 30 days. Instead of 70%, you earn the equivalent of 2x on every resolve against routes you discovered first. This incentivizes aggressive early indexing.

**Route persistence.** Once your agent discovers a route, it remains attributed to you in the shared graph. Even as routes are validated and updated by other agents, the original contributor maintains revenue share. Discovery is a one-time investment with ongoing returns.

**Network effects compound.** As more agents join the network, demand for cached routes increases. Routes discovered early get more external uses. A route indexed today that gets 100 uses/month might get 1,000 uses/month in six months as the network grows. Your early discovery captures that growth.

This is analogous to early Bitcoin mining: the work is the same, but the rewards are disproportionately higher for early participants. Except here, the "mining" is useful work -- discovering API routes that make the entire agent ecosystem faster and cheaper.

## Who benefits most

The economics improve with scale. The more agents you run and the more diverse the websites they touch, the faster routes accumulate and the higher the revenue.

**Agent infrastructure companies.** Running agent platforms where customers deploy dozens or hundreds of agents. Each customer's agents contribute routes. The platform earns marketplace revenue as a built-in business model.

**AI companies with agent fleets.** Internal fleets that handle customer service, research, data collection, or workflow automation. Browser costs dominate infrastructure spend. Cached routes eliminate the largest variable cost.

**DevOps teams deploying agents.** Teams managing agent infrastructure who need to justify agent fleet costs. Shifting from pure cost center to cost center plus revenue stream changes the internal business case entirely.

## The numbers behind the numbers

These economics are grounded in benchmarks, not projections. The underlying performance data comes from a study across 94 live production websites:

| Metric | Result |
|--------|--------|
| Mean speedup | 3.6x (API vs browser) |
| Cost reduction | 106x ($0.53 vs $0.005) |
| Win rate | 100% (all 94 domains) |
| Savings on repeated tasks | 90-96% |

Full methodology, benchmark data, and architecture details are in the paper: [arXiv:2604.00694](https://arxiv.org/abs/2604.00694). The 90-96% cost savings on repeated tasks are not theoretical. They are measured across real sites with real authentication, real JavaScript rendering, and real API complexity.

## Start indexing

Unbrowse is open source. Install it, point your agents at it, and start discovering routes. Every route your fleet discovers today is a route that earns revenue tomorrow.

- [View the repository](https://github.com/unbrowse-ai/unbrowse)
- [Read the paper on arXiv](https://arxiv.org/abs/2604.00694)

```bash
# Install
npm install -g unbrowse

# Your agents discover routes automatically
unbrowse resolve "search for flights to Tokyo" --url kayak.com

# Every resolve checks the shared graph first
# Cached hit = $0.005. You earn 70% when others use your routes.
```

---

*[unbrowse.ai](https://www.unbrowse.ai)*
