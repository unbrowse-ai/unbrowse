# Why Unbrowse

## The problem

Today, an AI agent that needs data from a website launches a browser, renders the page, waits for scripts, hunts for buttons, clicks them, and reads megabytes of HTML or screenshots. It is slow, expensive, and fragile: seconds of wall-clock time, hundreds of megabytes of RAM, thousands of wasted model tokens, and a workflow that breaks the moment the page's HTML layout shifts.

Yet the data was never really *on* the page. The page fetched it by calling the website's **own internal API** — a structured HTTP request returning clean JSON. Call that endpoint directly and the data comes back in one hop, with no browser.

The catch is that internal APIs are undocumented, evolve over time, and sit behind bot defenses and sessions. Reverse-engineering one site by hand is tedious. Doing it for the whole web — and keeping it working as sites change — is work nobody wants to repeat.

## What Unbrowse does

Unbrowse learns each site once, turns it into a reusable call, and lets the network share the result:

1. **Browse once:** The first time you or your agent need something from a site, your local node walks the page in its browser and records every network exchange. It identifies the call that answered your goal, traces every required header and token to its source, turns your search terms or IDs into inputs, and saves a reusable **route**.
2. **Call directly forever:** Every call after that goes over plain, browser-shaped HTTP — no Chrome window, no HTML parsing. In [*Internal APIs Are All You Need*](papers.md) across 94 domains, learned routes averaged **950 ms** versus **3.4 s** for browser agents, and cached routes answered in under **100 ms**.
3. **Share to the index and earn:** A route is plain data with all cookies, passwords, and personal tokens stripped out. Once a route proves itself, your node can share it to the open peer-to-peer index for free. When other agents pay to use a route you mapped, you earn in dollars (**USDC**).

The web stops being something agents scrape and becomes an API surface agents call — mapped by everyone who uses it, with no central platform in the middle ([the whitepaper](../../papers/whitepaper.md)).

## Why use it

- **Faster, cheaper agents.** Point any MCP client, CLI, or SDK at your local node (`127.0.0.1:7788`). Say what you want and pass a URL; get structured JSON back. When a task needs clicks or typing, drive the node's browser and it learns from every step so the next run is a direct call.
- **Works with your signed-in apps, privately.** Passwords, passkeys, and per-site cookie jars stay on your machine. Requests go straight from your machine to the website under your own session — never through a cloud scraping proxy.
- **Make money while you browse.** You don't need to build scrapers for strangers. Use Unbrowse for your own agents and browsing; proven routes list to the index automatically (unless you opt out). Every passed fetch pays **65%** of its fee in USDC to the route (to the contributor directly before route staking opens, or to verified stakeholders once staked). Listing is free and requires no upfront bond.
- **Websites get a cut too.** Every passed fetch sets aside **30%** in on-chain USDC escrow for the website's domain, whether or not the site has ever heard of Unbrowse.
- **Self-healing fallback.** Calling agents verify every response mechanically; failed calls cost **$0**. When a site changes and no shared route works, the node falls back to its browser and learns the updated route. The network degrades to slow, never to broken.

## What Unbrowse is not

- **Not a central scraping service.** There is no company server on the call path. Nodes discover each other over a Kademlia peer network and settle fees through ownerless smart contracts on Arc.
- **Not paid in a volatile token.** Agents pay for routes in dollars (**USDC**), never in **UNB**. UNB is the reserve token that prices route stakes and bounties, and **5%** of every passed fee buys and burns UNB. Neither UNB nor any route stake has a price floor or promised return.
- **Not a cryptographic proof of truth.** Clients verify response shape, HTTP status, and bound host locally in code before signing payment. Ranking uses verified staked collateral so broken routes lose traffic as calls fail (see [Search and ranking](search-and-ranking.md)).

## In the code today

**Built and working:**

- **Local learning and browserless replay:** The full `mint → walk → trace → route → call` pipeline (`unbrowse-node/crates/browser`, `unbrowse-node/crates/learn`, `unbrowse-node/app/src/learn.rs`, `run.rs`), including automatic browser fallback and relearning when a site drifts (`api/goal.rs`).
- **Local vault & sessions:** OS keystore root key, symbolic `vault:` references, per-host cookie jars, website passkeys, and human-in-the-loop browser handoff (`ask_owner` / `unbrowse_challenge`).
- **Peer network & sharing:** Kademlia DHT keyed by site (`unbrowse-node/crates/net`), content-addressed recipe bodies (`recipe.rs`), automatic sharing (`autolist.rs`), credential leak scanning (`crates/detector`), and gossip delisting notices.
- **Route-staking settlement & ranking:** The node implements the 65 / 30 / 5 split, route staking, claiming, bounties, and verified-collateral ranking (`unbrowse-node/app/src/chain/coins.rs`, `rank/coin.rs`), backed by compiled settlement ABIs in `unbrowse-node/app/contracts/` and tested end-to-end on local devnets.

**Not live on mainnet yet:**

- **Arc mainnet & testnet deployments:** `unbrowse-node/app/networks/arc-mainnet.json` and `arc-testnet.json` currently have `"deployment": null`. Local learning, calling, and devnet testing work today; real-money settlement opens after external audit, legal review, and the closed pilot.

Next: [How it works](how-it-works.md) · For full staking and economy rules: [Payments, Staking & UNB](payments-and-unb.md).
