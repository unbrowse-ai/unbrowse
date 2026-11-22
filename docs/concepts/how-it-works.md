# How it works

Unbrowse turns a site someone browses into calls an agent can make without a browser. One engine does it, in five
steps.

```
mint   ->  walk    ->  trace     ->  route        ->  call
browse     requests    the graph     a plain,         Chrome-shaped
once, in   + responses rooted at     reusable         HTTP, no
process    + bodies    the site      description      browser
```

1. **Mint.** The node launches Chrome, attaches over DevTools, opens the page, lets it settle, and keeps what the site
   handed out: its cookies and widget tokens. One call inside the node, no separate browser program. A profile kept per
   site makes later walks cheaper.
2. **Walk.** The same call records every request and response the page made (method, URL, status, headers, body). It
   subscribes before the page loads, so nothing is missed: the walk's first exchange is the page itself.
3. **Trace.** The walk becomes a graph rooted at the site: which call answered the goal, which earlier calls set the
   values it needed, and which parts of the winning request were *your inputs* (the search word, the id in the path)
   and which were constants.
4. **Route.** That graph is saved as a route: a method, a URL template with your inputs as holes, the headers and body
   it sends, and the setup calls it depends on. A route describes how to make a call; it is never a copy of an answer
   (spec R2.1). It is data, so it can be kept on one node or shared with others.
5. **Call.** To use a route the node fills the holes with your inputs and sends the request itself, over a transport
   shaped like the browser it learned in, so a bot-wall that judges the handshake lets it through. The site answers
   with JSON. No browser runs.

The payoff is the gap between step 1 and step 5: learning costs one walk, seconds; calling costs one HTTP request. In
the paper's measurement over 94 sites, a learned route answered in about 950 ms on average against about 3.4 s for an
agent driving a browser ([the papers](papers.md)).

## Why the engine is linked, not driven

The walk that learns a route runs through the browser engine linked into the node as a library, not through a
long-lived browser daemon over a socket. That boundary was a whole family of bugs: stale daemons, settings captured
once at launch, sessions that outlived their own relaunch, capture that missed a page's setup. Linking the engine
removes the class instead of patching each case ([AGENTS.md](../../AGENTS.md)).

## Two ways in

- **`unbrowse do "<goal>" --url <page>`**: say what you want and a page that does it. The node calls a route it holds
  that does it, or one another node listed for the site, or walks the page once, keeps the call that answers your
  goal, and calls that. You get JSON back. This is the common path. A route another node listed costs its fee once, in
  USDC; in the design that passed fetch also buys the route's coin for you and stakes it
  ([Payments and UNB](payments-and-unb.md#route-coins)). Running a route is free.
- **`unbrowse browse <command…>`**: when a task needs clicks and typing (a form, a sign-in), drive the node's browser
  directly. It learns from every step, so what needed a browser today is a route tomorrow.

Always go **through the node**, never a browser of your own: only the node learns, and only the node can reuse what it
learned.

## When a site changes

Sites drift. When a route stops replaying, the node walks the site's page again, rebuilds the call and tries once more.
When no copy of a route works anywhere, the agent falls back to the browser and the route is learned again; that
relearning is the network's own redundancy (spec R7.17).

## In the code today

**Built.**

- **Route coins are built.** The contracts are in `unbrowse-settlement/src/coins/` (private repository; the coin, its curve, staking, the fetch path and bounties), Settlement pays the 65 / 30 / 5 split and calls them on every claimed line, and the node trades, stakes, claims and ranks through them (`unbrowse-node/app/src/chain/coins.rs`, `rank/coin.rs`). The earlier economy (entry bond, route pool, fraud court, HTTP domain witnesses) is removed. Nothing is deployed yet: Arc mainnet has no deployment, and the earlier Arc testnet contracts are no longer supported.
- The five steps: `mint()` and `walk_har()` in `unbrowse-node/crates/browser/src/session.rs`, then `build()`
  (`graph.rs`) and `RouteClient` (`client.rs`) in `unbrowse-node/crates/learn`, driven by
  `unbrowse-node/app/src/learn.rs`.
  [ARCHITECTURE.md §3](../ARCHITECTURE.md#3-the-pipeline-browse-once-call-forever) walks them with a diagram, and
  [§4](../ARCHITECTURE.md#4-the-door) explains how a route gets past a site's bot-wall.
- Replaying with the node's jar and walking the page again when the site has drifted: `app/src/run.rs` (`call`).
- Driving the node's browser by hand, with capture on, so the flow becomes a route: `app/src/browse.rs`, which runs the
  engine's own command-line tool, one browser session per site.

**Differs from the design.**

- The spec has a value only page code computes stored as a sandboxed derivation of the site's script, recomputed at call
  time (R2.9). The code marks such a value `browser` and makes it in the caller's browser at call time
  (`recipe::Source`, [SHARING.md §1](../SHARING.md#1-routes-as-recipes)); there is no script sandbox.

**Not built yet.**

- Checking a recording again in a cookieless context before it is shared, and honouring robots rules while learning
  (R2.12). A robots parser exists (`crates/learn/src/robots.rs`), but nothing in the node calls it.

Next: [Three parties, one node](the-node.md).
