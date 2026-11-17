# Three parties, one node

Unbrowse has three kinds of participant, and two of them run the **same** node software. What differs is which part of
it they use (spec §1.1).

- **Agents** want data and actions from websites. They point their AI or their code at a local node and ask. They pay
  USDC once per route version their node doesn't have, and each passed fetch also buys the route's coin for them,
  staked.
- **Contributors** run nodes that learn routes and share them. Listing is free. A contributor earns from a route only
  what its own stake in the route's coin earns, like any staker; until the coin launches, the credited lister is paid
  the route's share (R1.3). Most agents are contributors too: a node learns a route the first time its agent needs it,
  and can then share it.
- **Websites** are the sites whose data a route reads. They do nothing and run nothing. Each paid fetch sets aside a
  share for the site, held in escrow until it proves it owns the domain.

Any node that holds a route can also **serve** it to others, so a route stays reachable when the node that learned it
is offline. Serving earns no share of the fee; a node seeds what it keeps so routes stay findable. The roles are
things one node does under one wallet, not separate companies: the same node pays and earns (R1.1).

## What a node is

A node is one program, `unbrowse-node`, that an agent reaches on `127.0.0.1`. It:

- **learns** routes by walking sites in its browser;
- **serves** routes, its own and ones it fetched, and answers its agents in one hop;
- **settles**: pays other contributors for the routes it fetches, and claims what it is owed, on chain;
- **holds** a wallet and a vault (sessions, logins, passkeys) so calls that need to be signed in can be;
- **joins** the peer network to find routes other nodes learned.

The owner sees it all in the app: the routes, what agents are doing, the wallet, the vault and the settings.

## The split

In the design every passed route fetch splits in USDC three ways (R4.1):

| Share | Goes to |
|---|---|
| 65% | the **route**: it pays the route coin's staked, checked coins their part in USDC, and the part of every other coin buys the coin for the payer and stakes it |
| 30% | the **website** whose data it is, in escrow per domain |
| 5% and rounding | buys UNB and **burns** it: the one share no self-payer can recover |

The node that served the body and the platform take nothing from a fee. Fees are USDC, never UNB. The split is a
constant of the contracts: changing it takes a new deployment. See [Payments and UNB](payments-and-unb.md) for route
coins; the rule names are those of the specification ([`papers/protocol.md`](../../papers/protocol.md)).

## One wallet, many nodes

In the design a participant is a **wallet**, not a machine: one person may run up to 16 nodes under one ERC-8004
identity, and they share its record, its deposit and the route coins the wallet holds (R1.12, R7.22). See
[Identity and the vault](identity-and-vault.md).

## In the code today

**Built.**

- **Route coins are built.** The contracts are in [`unbrowse-settlement/src/coins/`](../../unbrowse-settlement/src/coins/README.md) (the coin, its curve, staking, the fetch path and bounties), Settlement pays the 65 / 30 / 5 split and calls them on every claimed line, and the node trades, stakes, claims and ranks through them (`unbrowse-node/app/src/chain/coins.rs`, `rank/coin.rs`). The earlier economy (entry bond, route pool, fraud court, HTTP domain witnesses) is removed. Nothing is deployed yet: Arc mainnet has no deployment, and the earlier Arc testnet contracts are no longer supported.
- The node and its parts: [ARCHITECTURE.md §2](../ARCHITECTURE.md#2-the-pieces) and
  [§5](../ARCHITECTURE.md#5-runtime-agent-node-site-window); `unbrowse-node/app/src/main.rs` (startup and the owner
  commands), `api.rs` (the agent API and MCP).
- Fees in USDC: on Arc the fee token is Arc's own USDC, 6 decimals ([MONEY.md §6](../MONEY.md#6-decimals)).
- Serving: a node seeds the bodies it lists and the ones it fetched and kept (`share.rs` `provide`, `keep`); holding
  others' routes for their sites is opt-in (`hold_routes`, `peers::hold_tick`). [NETWORK.md §8](../NETWORK.md#8-seeding-light-mode-and-the-dark-set).
- Light mode, which pays and learns but seeds nothing it fetched and holds nobody's routes (R1.11): `network light`,
  [NETWORK.md §8](../NETWORK.md#8-seeding-light-mode-and-the-dark-set). Unlike the spec's light node, it still serves
  the bodies of the routes it lists itself.

**Differs from the design.**

- A server that is the payer, its agent, or any key the payer authorised is paid nothing, so a payer can't name
  itself to win back the serving share (`_payHolders`). The design has no serving share.
- The design has no skills and no execute prices (`skills.none`, `execute.none`). The contract still pays a listing that
  names no site as a skill: 90% to its author, 5% to the platform, the rest burned (`SKILL_AUTHOR_PCT` in `_claim`).
- The spec pays every share to `getAgentWallet(agentId)` and keys deposits by the ERC-8004 `agentId` (R1.16). Settlement keys everything by the node's own address, the root key's: deposit, coins, stake, earnings and
  listings all sit at that address ([MONEY.md §1](../MONEY.md#1-three-balances)).
- One identity, many nodes: each node runs as index 0 of its identity (`peers::INDEX`), so a second node of the same
  owner is a second identity today ([NETWORK.md §13](../NETWORK.md#13-not-built-yet)). Admission already allows up to
  16 per identity (`crates/net/src/admission.rs`). What the nodes of one wallet do share is the wallet's deposit: each
  node's agent keys pay from it once the wallet grants them, each up to its own cap (`owner_nodes.rs`,
  [Identity and the vault](identity-and-vault.md#in-the-code-today)).

**Not built yet.**

- Route coins, and index nodes (R1.6).

Next: [Routes and the registry](routes-and-registry.md).
