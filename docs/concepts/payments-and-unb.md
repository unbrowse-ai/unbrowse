# Payments and UNB

Agents pay for routes in dollars (USDC, a dollar stablecoin), never in UNB. UNB is a fixed-supply token with three jobs
in the design: each route's coin trades against it, bounties are posted in it, and a share of every fee buys it and
burns it. The money is the subject of [*Paying for the Map*](../../papers/economy.md). Rule names on this page are those of the protocol specification ([`papers/protocol.md`](../../papers/protocol.md)).

## Who pays, and in what

Nobody sets a central price. Each contributor sets the price of its own entry in USDC, and the only floor is USDC's
smallest unit, $0.000001. The client suggests no price; entries that work equally well compete on it (R3.30, R3.33). A
site that has proved its domain may set a floor for its own routes (R4.17). A node never pays more than its owner's
maximum for one fetch (R3.3).

A node pays **once** when it fetches a route version. It keeps the body and reuses it with no new payment while that
version works (R3.12). Search is free, running a route is free, and no price feed sits on the payment path (R3.29,
R3.34).

Each passed fee splits three ways (R4.1):

| Share | Goes to |
|---|---|
| **65%** | the **route**: it pays the coins already staked on the route, and buys the route's coin for the payer with the rest |
| **30%** | the **website's** escrow, claimed by proving the domain |
| **5%** and rounding | buys UNB and **burns** it |

The node that served the body and the platform take no share of a fee. There are no skill fees and no execute prices.

Payments are off chain until claimed. The owner deposits USDC and authorises each agent key with a cap per epoch and an
expiry. Each paid fetch adds a line to the agent's running **voucher**, a message its key signs. Each payee later
**claims** its line on chain, with a Merkle proof, and is paid from the payer's deposit at once (R3.13, R3.22). An epoch
is 24 hours.

## When a use fails

The caller's client checks each answer mechanically (status, final host, answer shape) and signs the result into the
line (R3.17). A failed line pays nobody and costs its payer nothing, however many of its lines fail. The contract
keeps no count of failures. Since the payer signs pass or fail itself, a payer that marks every use failed gets every
answer unpaid, and nothing on chain stops it: the owner accepted that cost on 12 Nov 2026. Each voucher carries the
payer's own count of lines and passed lines, which the contract doesn't read. A server is paid nothing for a failed
use and may stop serving a payer from what it saw itself; that choice is each server's own.

## Route coins

### One coin per entry

An entry is one route body, named by its hash, and it may have one coin with a fixed supply of **1,000,000,000**. An
exact copy is the same entry and can't launch a second coin; a changed body is a new entry with its own coin
(`coin.per-entry`). Listing is free and launches nothing. A coin launches only with a buy, the credited lister's own
(`coin.launch`); a bounty never launches one.

The whole supply sells on a curve against UNB, and the price rises as coins are bought, so the earliest buyers pay
least. Each curve trade pays **1%** of its UNB to the platform. A buy in the first **5 minutes** after launch also pays
a snipe tax that starts at **50%** and falls to nothing, and the tax is burned. The curve is the
coin's permanent market: nothing is held back, and a coin never moves to a pool (`coin.curve`, `coin.snipe-tax`,
`decide.no-graduation`).

### What a fetch does

1. A passed fetch pays the route's **65%** in USDC.
2. Every coin of the fixed supply earns the same part of it. Coins staked before this epoch, by a wallet that has
   checked the route, are paid their part in USDC.
3. The part of every other coin (unsold on the curve, held unstaked, or staked too recently) is swapped to UNB and buys
   the route's coin for the payer in the same transaction. The payer never handles UNB.
4. Those coins are staked for the payer with its client's exit delay (**24 hours** by default). The payer has just seen
   the route work, so its stake counts in the route's rank at once and earns from the next epoch.

There is no lister cut: the lister earns as a staker of its own coin, like anyone. If an entry has no coin yet, or the
part is too small to buy, the credited lister is paid it, so nothing is stranded (`coin.fetch-pays`, `coin.split`). On a
new route almost nothing is staked, so nearly all of a fetch buys; as more of the supply is staked, more is paid out.

### Staking, checks and exit

- **Stake.** Coins earn only while staked, from the epoch after they were staked. Coins held unstaked earn nothing
  (`coin.stake`).
- **Check.** Staked coins earn only once the wallet has checked the route: it paid the route's listed price for a
  passed call another identity served, or its own listing served a passed call another identity paid. The check is
  recorded once and never lapses. A call a wallet pays to its own entry is never a check (`coin.check`).
- **Exit delay.** The staker names its exit delay when it stakes. Unstaking takes that long, earning nothing, and a
  longer delay counts for more in rank; how much is open (`rank.exit-delay`).
- **Claim.** Earnings are USDC claims of the wallet, taken whenever it chooses (`coin.claims`).
- **Sell.** A holder exits by selling into the curve. Coins never expire
  (`coin.no-expiry`).

Beyond what a fetch buys, a node buys, stakes or sells a coin only when its owner asks.

### Capacity

A wallet's entries take at most $2.00 of paid fees a day plus 0.2 times its clean fees to date; past that, clients
skip them until the next epoch (R6.12). Capacity reads no price and no stake. Whether it stays now that stake earns
from route coins is open (R6.13).

## What you can lose

There is no bond, no withholding, no slashing and no fraud court, and nothing can forfeit stake (`bond.none`,
`fraud.none`). Claims are paid whole in USDC, at once: nothing vests
(`decide.no-claims-vest`). A holder's only risk is the route's coin losing its price and its calls. A slow site, downtime or a changed page
costs the route picks and fees.

## Bounties

A bounty is UNB posted by anyone who needs a route that doesn't exist yet, for a site or an intent, and held by the
bounty contract (`coin.bounty-launch`).

- **A limit order.** The poster names the most it pays per coin, fees and tax included. A release buys only what fills
  at or under that price, and what doesn't fill stays the poster's. With no limit, it buys at market
  (`coin.bounty-limit`).
- **Release by confirmation.** Once the poster's own paid call on an entry has passed and been claimed, the poster may
  confirm once the entry's coin trades and is past its snipe window: the release buys on its curve (a bounty never
  launches a coin). **50%** of the coins bought go to the entry's credited lister and the rest to the poster, both staked
  and both checked (`coin.bounty-confirm`).
- **Release by use.** Every counted paid call on the site after posting, from any wallet, releases a share of the
  bounty to that entry, in proportion to the USDC it paid and at most **5%** of that USDC. That is the burn's share,
  which a faker who owns the site and the stake never gets back (`coin.bounty-by-use`). An entry with no coin when
  the bounty is settled gives its share to the poster. A lister has to launch by the bounty's deadline to get the share.
- **Deadline.** A bounty that approves no entry by its deadline goes back to the poster, and the poster takes back
  whatever nobody used.

There is no judge and no reserve bounty pool. The founder posts bounties from its own UNB on the same terms as anyone,
and its wallet may hold the coins they bought across many routes; that is disclosed (R8.12). How a bounty matches an
entry's site is still open.

## Getting started, in the design

A node joins on its own wallet. It needs a few cents of USDC on Arc once, to register its identity, and every fee is
paid from a deposit and splits like any other.

## Supply and allocation, in the design

**1,000,000,000 UNB**, minted once at genesis on Arc mainnet, with no minter; burns only remove it (R9.1). Genesis
allocates: a public launch pool of 67% (proposed), a rewards reserve of 10% locked in the utility contract (it posts
listing roots and pays no bounty), a treasury of 5% and 10% locked 3 and 6 months, and the team's 8% locked 3 months.
No airdrop (R9.3, R9.12). The team intends to buy up to 7% at launch from disclosed wallets, which is insider UNB, not
outside demand (R9.4a). Every UNB trade in the public pool pays its 4% fee, the trade tax, to Unbrowse (R9.28a). The
network opens to everyone on gates, not a date: audited contracts, a legal opinion and the pilot's measures (R11.8).

## The caveats

- **UNB carries no vote.** Rules change only by a new deployment that users choose to move to (R10.14).
- **Rank can be bought by locking capital.** Rank reads a coin's market and the stake behind it, so a holder with more
  capital can outrank a better route until its own calls fail or it sells.
- **A far larger copy can out-earn the original.** A copy of a working route launched with much more capital than its
  lister staked is accepted as competition.
- **A silent holder keeps a broken route ranked.** Only failed calls and sales take stake out of rank.
- **It can rise and it can fall.** Supply only falls, but nothing promises a price, and a thin early pool moves on small
  swaps.
- **The burn is a buyback**, and is called one. It grows only with paid use (R4.7).
- **USDC's issuer can freeze it.** Fees are in dollars, so that risk is real.

Nothing here is an offer of any token or a promise of any price or return.

## In the code today

**Built.** Everything above that is a contract rule is in this repository, and the node uses it.

- **The split.** Settlement pays 65% to the route, 30% to the website's escrow, and buffers the rest, at least 5%, to
  buy and burn UNB (`unbrowse-settlement/src/lean/LeanSettlement.sol`; the node's copy is `SPLIT` in
  `unbrowse-node/app/src/chain/wallet.rs`).
- **Route coins.** One fixed-supply coin per entry, launched with a first buy, sold on a curve with the 1% trade fee and
  the snipe tax (`RouteCoin`, `RouteCoins`); staking in lots, each with its own exit delay, checks, and USDC paid from
  a running sum (`CoinStakes`); the fetch that pays earlier stake and buys and stakes for the payer, held and completed
  later when a buy can't run safely (`CoinFetch`); bounties as limit orders with release by use (`CoinBounties`). The
  reference is [`unbrowse-settlement/src/coins/README.md`](../../unbrowse-settlement/src/coins/README.md).
- **Failed lines.** Free whatever their share: a claim marks a failed line spent and pays nobody from it.
- **Website escrow.** A domain claims with a DNSSEC proof (`Domains`); there are no HTTP witnesses.
- **The node.** It launches its listing's coin with a first buy of 1% of the wallet's UNB by default, shows what each
  fetch bought and staked, stakes, asks back, withdraws and claims on the owner's word, completes its own held buys,
  posts and confirms bounties, and ranks entries from chain reads
  ([CLI.md](../CLI.md), [MONEY.md](../MONEY.md)).
- **The model.** The rules were written first as an executable model and the contracts are replayed against its traces
  step by step ([`unbrowse-settlement/spec/coins/`](../../unbrowse-settlement/spec/coins/README.md)).

**Differs from the design.**

- **The curve's 1% trade fee goes to one address fixed at deployment**, which pulls it. Who that should be is the
  owner's open decision.
- **A fetch's buy is held, not made, when the coin's price has moved** more than 1% from its 15-minute average or from
  its settled price, and for a coin younger than 15 minutes. Those two numbers are deployment settings, not yet protocol
  parameters.
- **Capacity (R6.12) is not built**: nothing skips a wallet's entries once they have taken a day's fees.

**Not deployed.** Arc mainnet has no deployment (`unbrowse-node/app/networks/arc-mainnet.json`). The earlier Arc testnet
contracts are no longer supported; a node on Arc testnet says so and sends nothing until the route-coin set is deployed
there. No contract here mints UNB or holds an allocation: devnets use a test UNB, and on a live network the operator
names the token at deployment.

**Not yet audited by an outside party.** The coin contracts have had two internal audit rounds, with every finding
fixed or removed; an independent audit and a legal opinion gate any mainnet deployment.
