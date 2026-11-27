# Three parties, one node

Unbrowse connects three roles — **agents**, **contributors**, and **websites** — without a central broker. Agents and contributors run the exact same local `unbrowse-node` software; the only difference is whether a node is calling routes, sharing routes, or both (spec R1.1).

- **Agents (callers)** want fast, structured data or actions from websites. They connect to their local node over MCP or HTTP (`127.0.0.1:7788`). Running their own learned routes or cached routes is free. When fetching a route shared by someone else for the first time, they pay its fee once in dollars (**USDC**).
- **Contributors (mappers)** run nodes that learn working routes while browsing or running agents, and share scrubbed recipes to the open index. Listing is free and requires no bond. Contributors earn in **USDC** whenever other agents pay to fetch their routes (directly before route staking opens, or through their locked route stake after).
- **Websites** are the domains whose APIs routes call. They don't need to install anything or sign up. Every passed fetch sets aside **30%** of the fee in on-chain USDC escrow for the website's domain until the site owner proves domain control via DNSSEC and claims it.

Any node that fetches and keeps a working recipe can also **seed** it to peers so routes remain available even when the original author is offline. Seeding takes no fee cut and requires no bond.

## What one node does

`unbrowse-node` runs locally on your machine (`127.0.0.1:7788`) and handles five jobs under one wallet:

1. **Learns** routes by watching pages in its linked browser engine.
2. **Calls** routes directly over browser-shaped HTTP, under your own local sessions.
3. **Protects secrets** in your OS keystore and local per-host cookie jars — agents only see symbolic `vault:` references.
4. **Shares & discovers** routes over a peer-to-peer Kademlia DHT keyed by domain.
5. **Settles** USDC fees, route stakes, and earnings on Arc (or local devnet in test mode).

The native desktop window (`unbrowse app`) connects to the node on `127.0.0.1` so you can monitor routes, approve checkouts or manual sign-ins, and manage funds. Closing the window leaves the node running in the background.

## The fee split

Every passed route fetch splits three ways in USDC (spec R4.1):

| Share | Goes to | Purpose |
|---|---|---|
| **65%** | **The route** | Pays verified route stakeholders in USDC, and uses the rest to buy and lock a stake in the route for the calling agent. Before route staking opens, goes directly to the contributor in USDC. |
| **30%** | **The website** | Held in on-chain USDC escrow for the domain until claimed via DNSSEC. |
| **5%** (+ rounding) | **UNB burn** | Batched once per epoch to buy UNB from its public pool and permanently burn it. |

Neither the serving peer nor the platform takes a cut of route fees. There are no per-call tolls on cached routes and no failed-call charges. See [Payments, Staking & UNB](payments-and-unb.md) for the complete economy and staking rules.

## One wallet, many nodes

In the protocol design, one wallet owns a person's ERC-8004 identity, deposit, route stakes, and earnings, and can run up to 16 nodes under it (spec R1.12, R7.22).

## In the code today

**Built:**
- The local node, HTTP/MCP agent API, owner API, and native Zig desktop window (`unbrowse-node/app/src/main.rs`, `api.rs`, `unbrowse-node/window/`).
- Peer seeding (`share.rs`, `peers.rs`) and light mode (`unbrowse-node network light`, which pays and learns without seeding others' routes).
- Route-staking settlement (65 / 30 / 5 split, staking, claiming, bounties) and verified-collateral ranking (`app/src/chain/coins.rs`, `rank/coin.rs`).
- Multi-node shared deposits: multiple nodes linked to one owner wallet can draw from that wallet's single deposit under per-agent caps (`owner_nodes.rs`).

**Differs from the design / not yet built:**
- Settlement keys balances, coins, and listings by the node's own wallet address rather than by ERC-8004 `agentId` (spec R1.16).
- Each node registers index `0` of its own identity (`peers::INDEX`), so a second node registers a separate identity today even though admission already supports up to 16 nodes per identity (`crates/net/src/admission.rs`).
- Optional network-wide index nodes for site-less global search (spec R1.6) are not built yet; search scopes by site through the DHT.
- Live Arc mainnet/testnet deployments are pending audit, legal review, and the closed pilot (`app/networks/*.json` has `"deployment": null`).

Next: [Routes and the registry](routes-and-registry.md).
