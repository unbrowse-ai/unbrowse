# Why Unbrowse

## The problem

An agent that needs something from a website today opens a browser, loads the page, waits for the scripts, finds the
button, clicks it, waits again, and reads the result off the screen. It works, and it is slow, costly and brittle: a
round trip for one piece of data is seconds of wall-clock time, a Chrome's worth of memory, and a flow that breaks the
next time the page's markup shifts.

The data was never really on the page. The page got it by calling the site's **own internal API**: a plain request that
returns JSON. The browser made the request and drew the answer. Make that request directly and the data comes back in
one hop, with no browser.

These internal APIs are undocumented, they change, and they are guarded. You have to drive the real site to see which
request answers your question, carry the right cookies and tokens, and send it the way a real browser would so a
bot-wall lets it through. Doing that once, for one site, is fiddly. Doing it for the whole web, and keeping it working,
is a job nobody wants to repeat.

## What Unbrowse does

It does that job once, and then nobody has to do it again.

- The **first** time you want something from a site, the node's browser walks the page once and records every request
  and response. It keeps the one call that answered you, works out which parts of it were your inputs, and saves that
  as a **route**.
- **Every** time after, the node calls that route directly, with a plain HTTP request shaped like the site's own, and
  hands you JSON. In [*Internal APIs Are All You Need*](papers.md), across 94 sites, a learned route answered in about
  **950 ms** on average against about **3.4 s** for an agent driving a browser, and a well-cached route in under 100 ms.
- A route is just data, so your node can **share** it and other agents' nodes can use it. Each route body you list
  can have its own coin, and the route's share of every fee for it goes to that coin's stakers.

So the web stops being something agents scrape and becomes something agents call. The map of how to call it is built
by everyone who uses it, and owned by everyone who built it ([the whitepaper](../../papers/whitepaper.md)).

## Why you'd want it

**You build agents.** One local endpoint: say what you want and the URL of a page that does it, and get the site's
JSON back. When a flow needs clicks and typing, you drive the node's browser and it learns from every step, so the
second time is a call. Your code doesn't change when a route is learned; the same request just gets faster.

**You want speed and lower cost.** One request beats a browser session on latency, memory and reliability. An agent
that makes thousands of calls feels it in its bill and its wall-clock time.

**You want to be paid for the plumbing you figure out.** If your node learns a route others need, every passed fetch
of it pays **65%** of its fee, in dollars (USDC), to the route: to the stakers of its coin, and for the payer's own
coins with the rest. You earn as a staker of your own route's coin, like anyone; until its coin launches, the credited
lister is paid the route's share. Listing is free and needs no bond.

**You want no company in the middle.** Nodes find each other through a peer network and pay each other through a
contract on a public chain. The software is free, open and forkable. Where the code still has a company or an admin in
the loop, the concept pages say so.

**You want it to keep working.** The caller checks each answer, a use that fails the check costs you
nothing, a copy that serves nothing drops off the ranking, and when no route serves, the node falls back to
the browser and learns the route again. The network degrades to slow, never to broken.

## What it is not

- **Not a proof of correct answers.** Nobody re-runs every call to prove it. The caller's own client checks each answer
  in code (status, host, answer shape) before marking a call passed, and each passed fetch stakes the route's coin for
  its payer. That stake stops counting once its holder's own calls on the route fail.
- **Not paid in a token.** Calls are paid in dollars. Route coins trade against UNB, bounties are posted in UNB, and a
  share of every fee buys UNB and burns it. Rank reads a route coin's market and the stake behind it, so capital can
  buy rank. Prices can rise and fall; there is no price floor and nothing promises a return.
- **Not immune to its chain.** Payments and fetching a new route need the chain. Calls to routes a node already holds
  go straight to the site and keep working.
- **Not finished.** Each concept page ends with what the code does today and where it differs from the design.

## In the code today

**Built.**

- **Route coins are built.** The contracts are in [`unbrowse-settlement/src/coins/`](../../unbrowse-settlement/src/coins/README.md) (the coin, its curve, staking, the fetch path and bounties), Settlement pays the 65 / 30 / 5 split and calls them on every claimed line, and the node trades, stakes, claims and ranks through them (`unbrowse-node/app/src/chain/coins.rs`, `rank/coin.rs`). The earlier economy (entry bond, route pool, fraud court, HTTP domain witnesses) is removed. Nothing is deployed yet: Arc mainnet has no deployment, and the earlier Arc testnet contracts are no longer supported.
- Learning a route from one walk and replaying it without a browser: the pipeline in
  [ARCHITECTURE.md §3](../ARCHITECTURE.md#3-the-pipeline-browse-once-call-forever), `unbrowse-node/crates/learn`
  (`build`, `RouteClient`) and `unbrowse-node/app/src/learn.rs`.
- Falling back to the browser and relearning when no route serves: `api/goal.rs` `network_goal`, then the walk.

**Differs from the design.**


**Not built yet.**

- Rank by a route coin's market and the stake behind it (spec chapter 5): ranking is by words and price today
  ([Search and ranking](search-and-ranking.md)).
- Nothing is deployed on Arc mainnet: `unbrowse-node/app/networks/arc-mainnet.json` says `"deployment": null`. Arc
  testnet's contracts are recorded in `arc-testnet.json`.

Next: [How it works](how-it-works.md).
