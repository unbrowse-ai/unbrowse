# Google Indexed the Web for Humans. Here's Who Indexes It for Agents.

*The Economics of Proof of Indexing*

---

**TL;DR:** Proof of indexing pays you to build the agentic web. Browse sites with Unbrowse installed, discover API routes passively, and earn 70% of every micropayment when agents use your routes. $0.005 per cached resolve vs $0.53 for a browser session. First indexer of a domain earns 2x. Payments in USDC on Solana and Base via the x402 protocol.

---

## The most valuable index on earth

Google indexed the web for human eyes and became the most valuable company on earth. Search was the mechanism: crawl pages, rank links, serve results to people who type queries. Every click on a blue link generated ad revenue. The entire business model sat on top of one insight — whoever organizes the web's information captures an outsized share of its value.

The agentic web needs its own index. Not HTML pages ranked by backlinks, but machine-readable API routes ranked by reliability and speed. When an AI agent needs to check a flight price, it should not launch a headless browser, render JavaScript, screenshot pixels, and OCR the fare out of an image. It should call the airline's internal pricing endpoint directly. That endpoint already exists — the airline's own frontend uses it. The problem is discovery: nobody has indexed these routes and made them collectively available.

Unbrowse is building that index. And proof of indexing is the mechanism that pays anyone who contributes to it.

## What proof of indexing actually is

Proof of work secures Bitcoin by making miners spend energy to validate blocks. Proof of indexing secures the agentic web by making contributors spend browsing effort to discover routes. But unlike proof of work, the effort is not wasted — every unit of work produces a real, reusable API route that makes agents faster and cheaper.

Here is how it works. You install Unbrowse and browse the web. As you visit sites, Unbrowse passively captures the network traffic flowing between your browser and the server. It identifies the internal API calls — the fetch and XHR requests that power every modern website — reverse-engineers their schemas, authentication patterns, and parameters, and publishes them to a shared route graph. That is a mining event. Every route you contribute is cryptographically attributed to your wallet and timestamped on-chain.

When an AI agent later resolves a task using one of your routes, you earn a micropayment. No staking. No GPUs. No specialized hardware. Just the browsing you already do.

## The economics: $0.005 vs $0.53

A cached route resolve costs **$0.005**. A fresh browser-based resolve — launching headless Chrome, rendering the page, extracting data — costs **$0.53** on average. That is a **106x cost reduction**. The difference is not incremental. It is the gap between infrastructure that scales and infrastructure that does not.

This cost gap is what creates the earning opportunity. Agents are economically rational. Given the choice between a $0.53 browser session and a $0.005 cached route, they will choose the cached route every time. The demand side is automatic.

The supply side is where contributors come in. Every route in the shared graph was discovered by someone. When agents pay $0.005 to use that route, the contributor who indexed it earns **70% of the fee**. That is $0.0035 per resolve. The remaining 30% covers infrastructure, quality verification, and network maintenance.

## First-mover bonus: 2x for new domains

The first person to index a domain earns a **2x reward multiplier** on all routes from that domain. If you are the first to index airbnb.com's pricing API, you earn $0.007 per resolve instead of $0.0035. This bonus persists as long as your routes remain the highest-quality version in the graph.

This creates a land-rush dynamic with a key difference from speculative token plays: the value is anchored to real usage. Your 2x bonus only matters if agents actually use the routes. There is no way to earn by indexing garbage domains nobody queries. The incentive structure rewards useful work.

The first-mover bonus also solves the cold-start problem. Early contributors take on more risk — they are indexing domains before agent traffic exists. The 2x multiplier compensates that risk. As the network matures and agent volume grows, the base 70% share becomes the dominant earning driver.

## How earnings compound

A single route is worth $0.0035 per resolve. That sounds small until you consider volume. A popular endpoint on a high-traffic domain might serve thousands of agent requests per day. At 1,000 resolves per day, one route earns **$3.50 daily, $105 monthly, $1,260 annually**. With the first-mover bonus, those numbers double.

But routes are not isolated. When you browse a site, Unbrowse typically discovers 5 to 20 endpoints per session. A thorough indexing of a complex site like Reddit or Amazon might yield 50+ endpoints. Each endpoint earns independently. A contributor who indexes 10 popular domains with 20 endpoints each has 200 earning routes in the graph.

The math scales with the network. More agents joining means more resolve volume per route. More contributors indexing means broader coverage, which attracts more agents. This is the classic network flywheel — but unlike social networks where value is abstract, here every loop iteration generates a measurable micropayment.

## x402 micropayments: how the money moves

Payments use the **x402 protocol** — HTTP-native micropayments settled in USDC on Solana and Base. When an agent resolves a route, the payment happens inline with the HTTP request. No invoices, no billing cycles, no payment negotiations. The agent's wallet signs the payment, the route serves the data, and the contributor's wallet receives the fee. All in one round trip.

USDC was chosen deliberately. Contributors earn in a stable currency, not a volatile token. **There is no Unbrowse token.** There is no speculative asset to pump or dump. The economics are simple: agents pay for routes, contributors earn for indexing them. Stablecoins keep both sides honest.

Solana and Base provide the settlement layer — fast finality, low gas costs, and mature wallet infrastructure. Contributors can withdraw earnings to any wallet, swap to fiat through standard off-ramps, or reinvest in the ecosystem. The settlement chain is an implementation detail, not a value proposition.

## Mining is just browsing

This is the part that makes proof of indexing fundamentally different from proof of work or proof of stake. There is no mining rig. There is no staking lockup. There is no specialized operation to run.

**You install Unbrowse. You browse the web. Routes get indexed. You earn when agents use them. That is it.**

Every resolve command an agent runs also contributes to the index. If the agent encounters a site that is not yet covered, it falls back to a browser session, captures the traffic, indexes the routes, and publishes them. The agent itself becomes a miner. The line between using the network and building the network does not exist.

This is what makes the system self-sustaining. Usage is contribution. Contribution drives usage. There is no separation between the people who build the infrastructure and the people who benefit from it.

## Quality and competition

What happens when two people index the same domain? The route graph keeps both versions and serves the one with the highest reliability score. Reliability is measured empirically: does the route return valid data? Does it handle authentication correctly? Does it respect rate limits? Routes that break get automatically deprecated. Routes that work get more traffic and earn more.

This means contributors compete on quality, not just speed. You can displace a first-mover by indexing a more complete, more reliable set of routes for the same domain. The first-mover bonus helps with cold-start, but long-term earnings go to whoever maintains the best routes.

Contributors can also update and improve their routes over time. Websites change their APIs — endpoints shift, authentication flows evolve, schemas mutate. The contributor who keeps their routes fresh earns more than the one who indexes once and walks away. The system rewards active maintenance, not passive squatting.

## The network economics at scale

| Network agents | Daily resolves | Daily payout (all contributors) | Annual payout |
|---|---|---|---|
| 1,000 | 100,000 | $500 | $182,500 |
| 10,000 | 1,000,000 | $5,000 | $1,825,000 |
| 100,000 | 10,000,000 | $50,000 | $18,250,000 |
| 1,000,000 | 100,000,000 | $500,000 | $182,500,000 |

*Assumes 100 resolves per agent per day at $0.005 per resolve. Daily payout is the 70% contributor share.*

These are not speculative projections based on token price appreciation. They are arithmetic based on usage volume and a fixed fee. The total payout to contributors is a direct function of how many agents use the network. If usage grows, earnings grow linearly. If usage shrinks, earnings shrink. There is no mechanism for value to decouple from utility.

For individual contributors, earnings depend on two factors: how many routes they have indexed, and how popular those routes are. A contributor who indexes 50 high-demand domains will earn significantly more than one who indexes 500 obscure ones. The market prices routes by demand, not by effort.

## Why this matters for web3 builders

Most crypto projects solve for decentralization as a first principle and then search for a use case. Proof of indexing starts from a concrete use case — agents need cheap, fast access to web data — and uses crypto rails because they are the best tool for the job. Micropayments below $0.01 do not work on Stripe. They work on Solana.

For web3 builders, this is an opportunity to earn from real infrastructure with real demand. The agentic web is not a future prediction. There are already millions of AI agent sessions per day across Claude Code, Cursor, Windsurf, and other agent frameworks. These agents already need web data. They already pay for it — through expensive browser automation, scraping APIs, or manual human lookup.

Proof of indexing routes that demand to contributors. If you can browse the web, you can mine the agentic index. The barrier to entry is `npm install`.

---

## Start mining

```bash
npm install -g unbrowse
```

No GPUs. No staking. No tokens. Just USDC for useful work.

- [GitHub](https://github.com/unbrowse-ai/unbrowse)
- [npm](https://www.npmjs.com/package/unbrowse)
- [Whitepaper: Internal APIs Are All You Need](https://www.unbrowse.ai/internal-apis-are-all-you-need)
- [arXiv paper](https://arxiv.org/abs/2604.00694)
