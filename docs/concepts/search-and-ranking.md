# Search and ranking

When several contributors have mapped the same website, the calling node has to decide which route to try first. Unbrowse does this locally in software — there are no human curators and no 5-star ratings.

## How a node picks a route

1. **Scope by site.** The node looks up its own routes first, then queries the peer network for listings under the target site's registrable domain (search is free).
2. **Recall by goal.** Listings matching the agent's goal words (BM25 over description, site, path, and response field names) become candidates.
3. **Filter by budget & site policy.** Any listing priced above the owner's per-fetch maximum ($0.05 by default) or below a verified website's fee floor (or on a delisted site) is skipped.
4. **Rank by verified stake and market value.** Each candidate entry is scored by:

   $$S = \sqrt{Q \cdot M}$$

   - **$Q$ (verified locked collateral):** Route stake locked by wallets that have verified the route (through a real counterparty call) and whose own latest paid call passed. Longer notice periods carry higher weight. Stake is valued conservatively at the lower of the 24-hour time-weighted price and its **last-out** sale value (as if all unlocked units sold first), so unlocked speculation adds zero collateral (`rank.collateral`, `rank.last-out`).
   - **$M$ (market value):** The route stake's 1,000,000,000 fixed supply multiplied by its 24-hour time-weighted price.

5. **Proportional pick + newcomer exploration.** Clients pick among candidates in proportion to `S` (so an entry with twice the rank is picked roughly twice as often). **5%** of public read-only picks go to unverified entries (fewer than 30 counted uses) so new routes can earn their first real track record (spec R3.4).

## When a route breaks

A broken route loses traffic automatically without any central intervention:
- **Immediate fallback:** If a route fails the client's mechanical check (status, bound host, response schema), the failed fetch costs **$0**. The node immediately tries the next candidate, and if none work, falls back to its browser to relearn the site (spec R3.19).
- **Rank drops automatically:** The moment a stakeholder's own paid call fails, its stake drops out of $Q$. Holders exit the broken route's stake and adopt the working replacement.
- **Dark-set backoff:** If none of an entry's providers serve its recipe body during an epoch, the entry is sidelined on an exponential backoff schedule (1, 2, 4, … up to 32 epochs) without forfeiting any stake (spec R7.12).

## Gaming and trade-offs, plainly

Because there are no ratings to fake, the main attack is self-dealing (wash-calling your own route):
- A call an identity pays to its own entry **never counts as a verification check**, so it cannot activate unchecked stake.
- Every self-paid call forfeits the **30%** website share (on any domain the attacker doesn't control) and the **5%** burn, while pushing up the curve price on its own buys. Wash-calling is strictly more expensive than simply buying and locking stake openly.
- **Accepted trade-offs:** Locking capital *can* buy rank (though failed fetches still cost callers $0 and earn stakers $0), a well-funded copy can out-earn an under-staked original, and dormant holders who never re-test or sell slow down rank decay.

## In the code today

**Built:**
- **BM25 recall & site scoping:** `unbrowse-node/app/src/rank.rs` (`scores`, `ranked`) and `api/goal.rs` (`network_goal`, `goal_words`).
- **Budget & site-policy filters:** `over_max` checks (`max_fetch_usdc`) and `app/src/sitepolicy.rs`.
- **Verified-collateral ranking (`S = √(Q · M)`):** `unbrowse-node/app/src/rank/coin.rs` and `chain/coins.rs` compute `Q`, `M`, proportional selection, and 5% newcomer exploration from chain state.
- **Fallback & dark-set backoff:** `network_goal`, `share::Dark`, and `crates/net/src/providers.rs`.

**Differences & not built yet:**
- Candidate matching uses exact goal words (`goal_words`) and BM25; semantic embeddings from a pinned open model (spec R2.24) are not wired in yet.
- Each contributor sets one on-chain fee (`setFee`) across its entries rather than per-entry payer-dependent schedules (spec R3.30–R3.31).
- Dark-set state is held locally in memory per node and resets on restart.
- Daily wallet fee capacity (spec R3.6, R6.12) and commit-reveal failure reports (spec R5.7) are not built yet.

Related: [Routes and the registry](routes-and-registry.md) · [Payments, Staking & UNB](payments-and-unb.md).
