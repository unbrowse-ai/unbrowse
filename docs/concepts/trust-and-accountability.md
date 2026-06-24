# Trust and Accountability

In a shared route graph, trust is a practical signal about whether a route still does what it claims, not a cryptographic guarantee.

The shipped model is reliability-oriented: routes carry success and failure behaviour, freshness, verification state, and folded-in feedback, and that composite signal moves good routes up and bad routes out of future shortlists. This is a continuous trust model in the sense the paper uses: quality is observed from real outcomes over time rather than asserted once at publish.

A maintained graph then asks how it should express trust and enforce accountability once it carries meaningful traffic. The answer is deliberately narrow: higher-trust route tiers, accountable maintainers, and challenge mechanisms are the coordination tools. This is a quieter accountability layer, not a redesign of the product.

What does not exist today, and is described as forward-looking rather than shipped, is a full validator market or cryptographic attestation. The honest reading: practical reliability and verification ship now; the richer accountability layer is research direction, not current behaviour. Throughout, discovery stays free — an agent only pays when it executes a paid route, settled over x402.

## Two currencies, two jobs — settlement vs trust

The agentic web needs two distinct units, and conflating them is the bug. Usage is
**settled in USDC** — a paid `execute` clears in stable value over x402, so an agent
(or the human behind it) pays a predictable price and never has to hold or understand
a volatile asset. That is the only currency a caller ever touches.

The second unit is not for paying — it is for **trust**. The native token (FDRY) is
the agentic web's *accountability currency*: the stake a maintainer or indexer bonds
to stand behind a route. You do not spend it to use the network; you bond it to be
*trusted by* the network. Keeping the two separate is deliberate — if the trust asset
were also the payment rail, every use would be a forced sale, draining the very stake
that is supposed to signal commitment. Settlement is stable; trust is staked; they do
not mix. (This is the same separation the [contract platform](./contract-platform.md#the-economy-rides-the-same-platform)
keeps at the protocol layer.)

## How /contract and stFDRY carry it

A maintained route is not a free externality — under the [contract platform](./contract-platform.md)
it is a **signed, bondable asset**. The forward-looking accountability layer makes
that concrete:

- **/contract** turns each route into a typed, wallet-signed claim with a verifiable
  freshness proof. A maintainer who bonds behind a route is making a checkable
  promise: *this still resolves, and its shape still matches.* A proof that fails to
  reproduce is challengeable, and a dishonest claim is slashable — so the bond is
  what gives a trust tier teeth.
- **stFDRY** is the *staking* form of the stake — the staked receipt held by those who
  stay committed through the cooldown rather than trading in and out. The design
  rewards **holding, not spending**: an staking staker earns a larger maintenance
  reward and a higher trust weight, weighted by *commitment* (how much of one's
  position is staked) rather than by raw size, so a proportionally-committed small
  staker can outweigh a nominally-committed whale. The reward is *earn-by-staking*,
  never a discount on usage — usage stays USDC, and the value flows back to committed
  stakers through the network's growth, not by making anyone pay in the trust asset.

So FDRY is "the currency of the agentic web" in exactly one sense: it is the unit of
**trust and accountability** that makes a maintained, agent-usable web economically
honest. It is bonded to be trusted, abided in (stFDRY) to earn, and never the thing an
agent spends to act. This layer is **forward-looking** — practical reliability and
USDC settlement ship today; the bonded proof-of-indexing accountability economy is the
research direction described in the maintenance-network paper, not current behaviour.

Read [Where This Goes](../vision.md) for how this accountability layer sequences behind the wedge.
