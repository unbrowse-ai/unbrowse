# Search and ranking

When more than one contributor has listed a route for the same thing, something has to choose which entry to call. In
the design the software does it: no human picks, and nobody rates. Each route body's rank comes from its coin's market
and the stake its own users hold behind it ([*Keeping the Map True*](../../papers/selection.md), spec chapter 5). Rule names here
are those of the specification ([`papers/protocol.md`](../../papers/protocol.md)).

## How the design chooses

- **Scope and recall.** Candidates come from the site the agent named, then are recalled by words (BM25) and by meaning
  (embeddings from a pinned open model), merged (R3.2). Contributors never supply embeddings (R2.24).
- **Price.** Each contributor sets its own price. A client only picks entries whose price fits the agent's budget and
  never pays more than the agent's maximum (R3.3). A site's own price floor is honoured (R4.17).
- **Rank.** An entry's rank is `S = √(Q·M)`, and nothing else enters: no identity weight, no payout factor, no clock
  (`rank.score`).
  - `Q`, **counted stake**: coins staked by wallets that have checked the route and whose own latest paid call on it
    passed. Each stake counts in proportion to the exit delay its holder chose. It is valued at the lower of the coin's
    time-weighted price over 24 hours and what selling it now would return, as if every unstaked coin had been sold
    first, so capital that isn't staked adds nothing (`rank.counted-stake`, `rank.collateral`, `rank.last-out`).
  - `M`, **market cap**: the coin's fixed supply (1,000,000,000) times its time-weighted price over 24 hours.
- **The pick.** A client picks among an intent's entries in proportion to rank: a route with twice the rank is picked
  about twice as often. The pass rate on paid use is still computed and shown, but it doesn't pick (`rank.pick`).
- **A newcomer's share.** 5% of picks go to unverified entries (fewer than 30 counted uses), so a new entry can earn a
  first record (R3.4).
- **Capacity.** A wallet's entries take paid fees up to a daily cap that grows with clean fees earned, never with stake;
  over it, clients pick the next entry until the next epoch (R5.22, R6.12).

A route that breaks loses rank on its own: each user's stake stops counting the moment that user's call fails, and
holders sell.

## If a pick fails

The caller tries the next entry, then the next, and finally its own browser (R3.19). A failed call costs its payer
nothing. An entry none of whose providers served it in an epoch is **dark**: it is off the
ranking for one epoch, then two, four and so on up to 32 (R7.11, R7.12). A route that stops working stops being picked,
quickly.

## Gaming, plainly

There are no star ratings to push. What an attacker can do is pay its own route over and over. A call an identity pays
to its own entry is never a check, so it makes no stake count that wasn't counting already. Each self-paid call gives
up the 30% website share on a site the attacker doesn't own and the 5% burn on any site; the route's 65% pays the
coin's earlier stakers and buys the payer more of the coin, at a price its own buying pushes up. So a wash is a dearer
way of doing what anyone may do openly: buy the coin and stake it. Rank can be bought by locking capital, and the
capital is lost from rank once its holder's own calls fail or it sells. What the network does **not** do is re-run
every call to prove its answer.

## In the code today

**Built.**

- **Route coins are built.** The contracts are in [`unbrowse-settlement/src/coins/`](../../unbrowse-settlement/src/coins/README.md) (the coin, its curve, staking, the fetch path and bounties), Settlement pays the 65 / 30 / 5 split and calls them on every claimed line, and the node trades, stakes, claims and ranks through them (`unbrowse-node/app/src/chain/coins.rs`, `rank/coin.rs`). The earlier economy (entry bond, route pool, fraud court, HTTP domain witnesses) is removed. Nothing is deployed yet: Arc mainnet has no deployment, and the earlier Arc testnet contracts are no longer supported.
- **Words.** The node ranks by BM25 over what each route does, its site, its path, and the names of its answer's
  fields, with its own routes and other nodes' scored as one list (`unbrowse-node/app/src/rank.rs` `scores`,
  `ranked`; `unbrowse_search`).
- **Scope by site.** `unbrowse_do` with a url asks the peer network for the page's site and tries listings whose
  description says the goal's words (`api/goal.rs` `network_goal`, `goal_words`).
- **The agent's maximum.** A listing over the owner's `max_fetch_usdc` (0.05 USDC by default) is passed over as if it
  weren't offered, and the fee is checked once more on chain before paying (`over_max`;
  [SHARING.md §3](../SHARING.md#3-how-a-caller-finds-pays-for-keeps-and-runs-a-body)).
- **Falling back.** One entry fails, the next is tried, then the browser (`network_goal`).
- **The dark set.** `share::Dark`, on the doubling schedule up to 32 epochs, and providers that serve nothing or the
  wrong bytes set aside on the same schedule (`crates/net/src/providers.rs`).
  [NETWORK.md §8](../NETWORK.md#8-seeding-light-mode-and-the-dark-set).
- **Rank and the pick.** The node computes `S = √(Q·M)` for each entry from chain reads: the stake lots of wallets that checked the entry and whose latest paid call on it passed, each weighted by its exit delay, valued at the lower of the 24-hour average price and what selling would return, and the coin's market cap (`unbrowse-node/app/src/rank/coin.rs`, `chain/coins.rs`). It picks in proportion to rank, with 5% of picks for entries with no rank yet. The pass rate is still computed and shown.

**Differs from the design.**

- **Matching a listing is by its words.** A listing is a candidate when its description's words are the goal's words, in
  any order (`goal_words`); there is no recall by meaning.
- **One price per contributor**, set on chain with `setFee` for all its entries, and moved by auto pricing at most once
  an epoch ([SHARING.md §6](../SHARING.md#6-fees-and-pricing)). The spec has a price schedule per entry that may depend on
  the payer's record (R3.30, R3.31).
- **Dark state is each node's own and in memory**; a restart starts it afresh. The spec leaves who reports a dark entry
  open (R7.11).

**Not built yet.**

- Embeddings and the pinned model (R2.24), the reported pass rate and default entry (R5.16 to R5.19), commit-and-reveal
  reports (R5.7), and the false-fail gate (R4.26 to R4.29).
- Capacity, which in the spec skips a wallet's entries once they take their day's fees (R3.6, R6.12). See
  [Payments and UNB](payments-and-unb.md).

Related: [Routes and the registry](routes-and-registry.md) · [Payments and UNB](payments-and-unb.md).
