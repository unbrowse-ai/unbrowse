# Payments, Staking & UNB

This page explains how you earn from routes and how Unbrowse's economy works — starting with the plain-English summary, followed by the full route-staking, verification, ranking, and bounty mechanics.

---

## The short version

If you just want to use Unbrowse and earn when you share routes, here is all you need to know:

1. **Browsing and sharing are free.** Your node learns routes as you and your agents browse. Sharing proven routes to the open index costs nothing and requires no deposit or bond.
2. **Your own routes and cached routes are free.** Calling routes your node learned — or routes you already fetched and cached — costs **$0**. Search is free. Failed fetches always cost **$0**.
3. **Callers pay once per version, in dollars (USDC).** When another agent fetches a route from the index for the first time, it pays the route's fee in USDC (up to the owner's per-fetch limit, $0.05 by default).
4. **Every passed fee splits 65 / 30 / 5:**
   - **65% goes to the route** (paid to the contributor directly before route staking opens on that route, or to verified stakeholders once staked).
   - **30% goes to the website's domain escrow** (claimable by the site owner via DNSSEC).
   - **5% buys UNB and burns it.**
5. **Callers become stakeholders automatically.** Once staking is open on a route, part of every passed fetch automatically buys and locks a stake in that route for the calling agent — without the caller ever needing to hold UNB.

*(Status: local learning, calling, and devnet testing work today. Real-money settlement, route staking, website escrow, and bounties open on Arc mainnet after contract audit, legal review, and the closed pilot.)*

---

## Why the economy is built this way

A shared map of website APIs is a commons problem: websites change constantly, fixing broken routes takes real work, and if everyone copies routes for free, nobody maintains them. Conversely, if anyone can get paid to list routes, spammers will flood the index with broken or fake ones.

Unbrowse solves both problems without a central company, human moderators, or star ratings:
- **Contributors get paid** in USDC whenever agents adopt their working routes.
- **Route staking** turns real users into verifiers. Because every paying user automatically gets a locked stake in the route, and a stake only counts while the holder's own calls work, working routes accumulate verified stake and rise to the top while broken routes lose rank and earnings automatically.

---

## 1. Pricing, vouchers & failed calls

- **Market-set prices in USDC:** Each contributor sets its own price in dollars (USDC). The only protocol floor is `$0.000001`. Equivalent working routes compete on price. A verified website owner may also set a price floor for its own domain (spec R4.17).
- **Pay once per route version:** A caller pays on a cache miss when fetching a route body. Once fetched and verified, the node caches the recipe and replays it for **$0** as long as that version works (spec R3.12).
- **Off-chain signed vouchers:** Calling a route never waits on a blockchain transaction. The node owner deposits USDC into Settlement and authorises each agent key with a daily spending cap ($5/day by default) and expiry. Each paid fetch appends a signed EIP-712 receipt line to the agent's running voucher. Payees (or the payer's backstop / watchtowers) batch-claim settled lines on chain (spec R3.13, R3.22). One **epoch** is 24 hours.
- **Failed calls are always free:** The calling node checks every response mechanically (HTTP status, bound host, response schema) before signing pass or fail into the receipt line. A failed fetch costs the caller **$0** and pays nobody, regardless of how many calls fail. Servers may independently stop serving a payer that reports excessive failures.

---

## 2. How the 65 / 30 / 5 split works

When a passed receipt line is claimed on chain, its USDC fee splits three ways (spec R4.1):

```
Passed USDC fee
 ├── 65% ──▶ The Route (CoinFetch)
 │            ├── Before route staking opens: owed directly to the credited contributor in USDC
 │            └── Once route staking is open:
 │                 ├── Locked, verified stake earns its pro-rata share in USDC
 │                 └── Remainder swaps to UNB → buys route stake on its curve → locks for caller
 ├── 30% ──▶ Website Escrow (held per domain; claimable via DNSSEC proof after 14 epochs)
 └──  5% ──▶ Burn Buffer (batch-swapped once per epoch into UNB and permanently burned)
```

Neither the serving peer (0%) nor the platform (0%) takes a cut of route fees. There are no skill fees and no execute tolls.

---

## 3. Stake your routes: how route staking works

### One fixed-supply stake per route body
Every unique route body is identified by the SHA-256 hash of its canonical recipe bytes (`content_id`). Each entry can have **at most one route stake** with a fixed supply of **1,000,000,000** standard ERC-20 stake units (`coin.per-entry`).

- An exact copy of a recipe has the same hash and cannot open a duplicate stake.
- A modified recipe (such as a fix when a website changes) has a new hash, becomes a new entry, and can open its own stake to compete on rank.
- **Listing is free and launches nothing.** Staking on a route only opens when the entry's credited contributor makes the first buy on its price curve (by default, the node uses 1% of its UNB balance if it holds any; set `coin_dev_buy` to `0` to disable; a wallet with no UNB still lists and earns the 65% route share directly in USDC).

### The permanent price curve
Every route stake's entire 1B unit supply trades on a constant-product price curve against **UNB** (`coin.curve`):
- **Early backers pay less:** Price increases along the curve as more stake units are bought, rewarding early contributors and verifiers.
- **Permanent market:** Route stakes never expire and never graduate off the curve; holders can buy from or sell back into the curve at any time (`coin.no-expiry`).
- **Curve fees:** Every curve trade pays a **1%** fee in UNB to the platform. Buys during the first **5 minutes** after a route stake opens also pay a decaying **early-buyer fee** (snipe tax) starting at **50%** and falling linearly to **0%**, sent to the UNB burn buffer (`coin.snipe-tax`).

### How a paid fetch pays stakeholders and stakes the caller
When an agent's passed fetch is claimed on a staked route:
1. Every unit of the 1,000,000,000 supply is allocated an equal fraction of the **65%** route share.
2. **Existing verified stakeholders get USDC:** Any stake units that were locked before the current epoch closed — by wallets that have verified the entry — receive their exact fraction immediately as claimable USDC.
3. **Unlocked/unsold supply buys and locks stake for the caller:** The remainder (for units still on the curve, held unlocked, or locked too recently) is swapped into UNB through the UNB/USDC pool, buys stake in the route on its price curve, and automatically locks it for the calling agent's wallet (with its default 24-hour notice period).
4. **Price-movement protection:** If a route stake is younger than 15 minutes or its spot price has moved more than 1% from its 15-minute average or recent settled price, the USDC is safely parked (`completeBuy`) and completed once prices settle.

On a brand-new route with little stake, nearly all of each fetch buys and locks stake for early callers. As more of the supply becomes locked by verified users, a larger share of each fetch flows directly to stakeholders as USDC.

### Staking rules, checks & exiting
- **Lock to earn:** Unlocked stake earns nothing. Locked stake begins earning USDC from the next epoch close (`coin.stake`).
- **Check-once verification:** Locked stake only earns after the wallet has **checked** the route — either by paying the listed price for a passed fetch served by another identity, or by having its own live listing serve a passed fetch paid by another identity. Self-paid calls never count as a check (`coin.check`). Once verified, a check does not expire on a timer.
- **Notice period (exit delay):** When locking stake, you pick an exit delay (**24 hours** by default). Longer notice periods carry higher weight in route ranking. Requesting an unlock stops earnings and ranking weight immediately; after the delay passes, you withdraw the units and can sell them into the curve.
- **Claim anytime, zero slashing:** There is **no entry bond, no payout withholding, no vesting period, no fraud court, and no slashing** (`bond.none`, `fraud.none`). Nobody can forfeit your stake. A stakeholder's only risk is that the route breaks or loses demand, causing its stake value and fee flow to drop.
- **Owner control:** Aside from automatic stake buys triggered by passed fetches and the optional 1% opening buy (configurable to 0), a node never buys, locks, or sells route stakes unless the owner explicitly asks.

### How staking drives route ranking
Staking isn't just for splitting fees — it is how clients decide which route to call when multiple contributors map the same site. Clients rank each entry by `S = √(Q · M)`, combining **verified locked collateral** (`Q`, valued last-out and weighted by notice period) and **24-hour time-weighted market value** (`M`). The moment a stakeholder's own paid call fails, its stake stops counting in `Q`. See [Search and ranking](search-and-ranking.md) for the full ranking logic.

---

## 4. Bounties

Anyone who needs a route for an unmapped website can post a **bounty** in UNB (`CoinBounties`):

- **Standing limit order in UNB:** The poster locks UNB in the bounty contract, names the target site, sets a maximum price per stake unit (`limit`, fees and early-buyer fee included), and sets a deadline (30 days by default).
- **Two ways a bounty releases (no human judge):**
  1. **Sponsor confirmation:** After the poster's own paid call on a listed route passes and is claimed (and once the route's stake is past its 5-minute opening window), the poster can confirm. The bounty buys the route stake up to its limit price and splits the bought stake **50% to the credited contributor, 50% to the poster**, both locked and verified.
  2. **Automatic release by use:** Even if the poster stays silent, every counting paid fetch on that site after posting reserves up to **5%** of that call's USDC value from the bounty (matching the 5% burn so wash-calling cannot profit). After settlement, each qualifying entry's stake is bought automatically.
- **Refunds:** Unfilled or unused UNB returns to the poster after the deadline. Nothing is burned for silence.

---

## 5. UNB supply, allocation & trade-offs

**Supply:** **1,000,000,000 UNB**, minted once at genesis on Arc mainnet with **0 minted afterward** (spec R9.1, R10.2). Burns only shrink circulating supply.

**Genesis allocation (protocol spec R9.3):**
- **67% (proposed):** Public launch pool / open market (UNB's public UNB–USDC pool on Arc)
- **10%:** Rewards reserve (locked in a utility contract solely to post hourly listing Merkle roots; never stakes or pays bounties)
- **15%:** Treasury (5% locked 3 months, 10% locked 6 months from genesis)
- **8%:** Team (locked 3 months from genesis; team may also buy up to 7% on the open market from disclosed wallets)
- **0%:** No airdrop

**Pool fees:** UNB's public UNB–USDC pool charges a **4%** trade fee, which funds Unbrowse.

**Explicit trade-offs & risks:**
- **UNB carries no governance vote.** Contracts have no owner or admin key; rule changes happen only through new deployments that users choose to adopt (spec R10.3, R10.14).
- **Capital can buy rank.** Because ranking reads market value and locked collateral, well-funded actors can push a route up — though failed calls always cost callers $0 and pay stakeholders $0.
- **Well-funded copies can compete.** A copy of a working recipe backed by more capital can out-earn an under-staked original.
- **Dormant holders slow decay.** Until holders sell or their own calls fail, stale stake decays slowly.
- **Market and stablecoin risks.** UNB and route stakes can fall to zero; the 5% burn is a fee-funded buyback, not a price floor. Fees settle in USDC, whose issuer can freeze addresses.

*Nothing in this documentation is an offer of any token or a promise of any price or return.*

---

## 6. In the code today

**Built in this repository:**
- **Node chain & economy logic:** 65 / 30 / 5 fee split (`unbrowse-node/app/src/chain/wallet.rs`), route-stake opening, trading, locking, claiming, held-buy completion, bounties, and `S = √(Q · M)` ranking (`app/src/chain/coins.rs`, `rank/coin.rs`, `autobounty.rs`).
- **Compiled contract interfaces:** `unbrowse-node/app/contracts/` holds the ABIs for Settlement, Listings, Domains (DNSSEC), RouteCoins, CoinStakes, CoinFetch, and CoinBounties.
- **Local test mode:** Source builds spin up a local Anvil devnet with test USDC and test UNB so every payment, route-staking, and bounty path can be exercised locally.

**Differences & deployment status:**
- Daily wallet fee capacity (spec R6.12) is not implemented yet.
- The curve's 1% trade fee goes to a deployment-configured address; price-movement protection bounds (1% / 15 min) are deployment settings.
- **Not deployed on live networks yet:** `arc-mainnet.json` and `arc-testnet.json` currently set `"deployment": null`. Mainnet deployment is gated on an independent security audit, legal opinion, and closed pilot measurements.

For exact gas measurements, claim batching, and balance rules, see [MONEY.md](../MONEY.md).
