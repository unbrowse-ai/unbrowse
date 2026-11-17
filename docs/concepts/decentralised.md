# Decentralised from launch

In the design Unbrowse has no central server on the path. Nodes find each other and pay each other directly; a
contract on a public chain keeps the ledger; the contracts have no owner and no admin key, and nobody can change a
split after deployment (spec R10.3). This page says how that holds together, and where the code still differs.

## Finding each other

Nodes join a **peer network**: a Kademlia distributed hash table **keyed by site**. Each node announces the sites it
holds listings for under each site's key, its registrable domain. To find routes for a site, a node looks up that key,
gets back the nodes that hold listings for it, and fetches them from at least two different identities (R7.21). A node
finds its first peers from the peers it saved last time, then from identities registered on chain; there is no
bootstrap list (R7.24).

A node that turns off stops being found, as a BitTorrent peer does. Its announcements last an hour and it renews them
every 20 minutes, so one that crashes drops out within the hour; one that stops cleanly sends its peers a signed
goodbye and drops out at once; and a lookup tries the providers that are up first, so it never waits long on one that
is gone (R7.18, [NETWORK.md §4a](../NETWORK.md#4a-going-offline)).

## Who's allowed in

Open peer networks have a classic problem: a malicious node can flood peers or poison the table. Unbrowse admits peers
by **on-chain identity** (ERC-8004), not by address: a peer enters a routing table only if the registry lists its peer
ID under the identity it names, and its position in the table starts with bits fixed by that identity's registration
(R7.25, R7.26). Crowding one site's key with fake peers then costs a paid registration per peer. A peer that can't be
admitted may still ask questions, rate-limited, but never enters a routing table and its records are dropped.

## Where each rule lives

Rules that move money or stake live on chain, in Settlement and the route-coin contracts: a modified client can't pay
itself a higher split or fake a check, because the contracts verify voucher signatures and Merkle proofs themselves.
Rules that pick routes live in the client. Each client picks in proportion to rank, read from each route coin's price
and the stake its users hold. A client that ranks otherwise, such as an old one that picks by pass rate, only picks
differently for its own owner (`rank.pick`; rule names are the current spec's, `protocol/spec/` in unbrowse-papers).

## Changing a network nobody controls

- **Versioned protocols.** Protocol names carry versions, and peers tell each other their release, so old and new nodes
  can run side by side while a change rolls out. A node older than the network's **minimum version** stays off the
  peer network until it updates, and its peers refuse it. That is the closest a decentralised network comes to forcing
  an upgrade.
- **Self-updating nodes.** Released nodes fetch newer releases, check them against Unbrowse's signing key, and restart
  into them. The update path trusts a **signature**, not a server or a certificate authority: whoever answers for the
  package registry can at most withhold an update, never install one.
- **New rules mean a new deployment.** There is no vote and no council; rules change only when users move to a new
  deployment (R10.14).

## If the chain is compromised

- **Settlement is compromised**: ordering and payment are the chain's, and fetching a *new* route needs it to check
  an entry and pay.
- **Calls to routes a node already holds keep working**: they go straight to the site and never touch the chain.
- **The contracts can move** to another chain as a new deployment.

That is said plainly, not called solved.

## In the code today

**Built.**

- **Route coins are built.** The contracts are in [`unbrowse-settlement/src/coins/`](../../unbrowse-settlement/src/coins/README.md) (the coin, its curve, staking, the fetch path and bounties), Settlement pays the 65 / 30 / 5 split and calls them on every claimed line, and the node trades, stakes, claims and ranks through them (`unbrowse-node/app/src/chain/coins.rs`, `rank/coin.rs`). The earlier economy (entry bond, route pool, fraud court, HTTP domain witnesses) is removed. Nothing is deployed yet: Arc mainnet has no deployment, and the earlier Arc testnet contracts are no longer supported.
- The swarm, admission, fixed positions, joining with no bootstrap list, and failure behaviour:
  `unbrowse-node/crates/net` (`admission.rs` `admit`, `position.rs`, `node.rs`) and `app/src/peers.rs`, `erc8004.rs`.
  [NETWORK.md](../NETWORK.md) is the whole story; [§12](../NETWORK.md#12-failure-behaviour) is what happens when the
  chain or a peer stops answering.
- The version gate and signed updates: `app/src/update.rs` (`verify`, `network_minimum`, `below_minimum`), with the
  minimum in `unbrowse-node/MIN_VERSION` ([NETWORK.md §2](../NETWORK.md#2-who-counts-admission),
  [OPERATIONS.md §2](../OPERATIONS.md#2-cutting-a-release)).
- Settlement has no upgrade path, no owner and no admin, and no function that moves a deposit, a coin, a stake or earnings except
  at its owner's own call (`unbrowse-settlement/src/lean/LeanSettlement.sol`; the
  [contracts reference](../../unbrowse-settlement/README.md)). The UNB/USDC pool is fixed at construction (`pool` is
  immutable).
- Domains proven without an admin or any committee: a DNSSEC proof alone (`Domains.claimEscrow` in
  `unbrowse-settlement/src/lean/Domains.sol`). A domain without DNSSEC cannot be bound until it enables it.
- Arc as the chain: the networks the node knows are in `app/src/arc.rs` and `app/networks/*.json`; fees are Arc's own
  USDC ([ARCHITECTURE.md §8](../ARCHITECTURE.md#8-on-chain-the-money)).

**Differs from the design.**

- **Rate limits are partial.** Bodies are rate-limited per peer (`crates/net/src/body.rs`, `BODY_RATE`), and listings
  answers share 16 slots across all peers (`node.rs`, `MAX_ANSWERING`). Kademlia's own `GET_PROVIDERS` is not limited
  per peer, which R7.18 and R7.26 ask for ([NETWORK.md §13](../NETWORK.md#13-not-built-yet)).
- **A build from source defaults to a devnet.** It runs its own local Anvil chain, forking Arc testnet so the real
  identity registry is there (`app/src/build_config.rs`); a release runs on Arc testnet unless its variable names
  another (`UNBROWSE_DEFAULT_CHAIN`, [OPERATIONS.md §1](../OPERATIONS.md#1-build-time-flags)).

**Not built yet.**

- **Nothing is deployed on Arc mainnet.** Its network file says `"deployment": null`
  (`unbrowse-node/app/networks/arc-mainnet.json`).
- The closed pilot and the gates of spec chapter 11, which are launch steps, not code.
- A real position anchor on a devnet that forks nothing, and receipts sent between machines (they go over HTTP through
  a folder on one machine; [NETWORK.md §13](../NETWORK.md#13-not-built-yet)).

Related: [Identity and the vault](identity-and-vault.md) · [NETWORK.md](../NETWORK.md).
