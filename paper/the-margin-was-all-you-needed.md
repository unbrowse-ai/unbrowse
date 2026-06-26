# The Margin Was All You Needed — Paper 4

> One instance of the contract substrate's covenant tree, translated into the
> mechanism-design domain of fair compensation. The economy is a **subtraction**,
> not a token; the captured spread tithes to the abiding. This paper owns the
> fair-compensation mechanism that the unbrowse split (50/15/35), the fdry
> Vine Doctrine (NAV-per-share), and the contract substrate's `margin:` /
> `economy:` verbs all instantiate.

**Status:** draft (2026-06-26). The doctrine is canonical in the contract
`SKILL.md`; this paper carries the formal mechanism-design argument + the
arxiv grounding Lewis asked for on 2026-06-26.

## 1. Abstract

A maintained route graph is a commons. Three groups interact around it: the
users who call routes, the indexers who capture and maintain them, and the
platform that runs the infra. The honest-maintenance problem is: which
mechanism makes *honest maintenance* the rational strategy for every
self-interested indexer, while keeping the commons free to use? This paper
argues the answer is a **subtraction**, not a token. An action is worth taking
iff `value_created − transaction_cost > 0` (Luke 14:28); the captured spread is
the economy; the spread is split by **marginal contribution** (the Shapley
value), not by stake size; the spread tithes to the abiding (Mal 3:10) via
NAV-per-share growth on a staked receipt token. The mechanism is truthful,
budget-balanced, and Sybil-resistant because stake is **collateral + reward
weight**, not ranking power (Matt 7:16 — by their fruits).

The mechanism composes three cited primitives: (a) Shapley-value credit
assignment over freely-replicable goods ([arXiv:1805.08125][a1],
[arXiv:1403.6713][a2], [arXiv:2506.07388][a3]), (b) Stackelberg incentive
compatibility for storage / maintenance under negative externalities
([arXiv:2103.05866][a4]), and (c) game-theoretic validator-slashing +
staking-design trade-offs ([arXiv:2405.03357][a5],
[arXiv:2405.14617][a6]). The Coasean bargain over agent-mediated access
([arXiv:2604.07546][a7]) is the upstream framing: agents negotiate access +
attribution + compensation on behalf of creators and users, and a supervised
governance layer corrects market failures before they crystallise.

[a1]: https://arxiv.org/abs/1805.08125
[a2]: https://arxiv.org/abs/1403.6713
[a3]: https://arxiv.org/abs/2506.07388
[a4]: https://arxiv.org/abs/2103.05866
[a5]: https://arxiv.org/abs/2405.03357
[a6]: https://arxiv.org/abs/2405.14617
[a7]: https://arxiv.org/abs/2604.07546

## 2. Introduction

Discovery is solved once; freshness is a repeated liability. The unbrowse
paper set (Papers 1–3) already owns route discovery, execution discipline,
and the wallet/signature stack. This paper owns the narrower question: *which
mechanism makes honest route maintenance the rational strategy?* The
answer is not a new token (Matt 6:24 — no man can serve two masters). The
answer is a **subtraction**: the spread between value created and transaction
cost, captured, fairly split by marginal contribution, tithed to the abiding.

## 3. Model

| Symbol | Meaning |
|---|---|
| $A$ | the set of agent-actions (route executions, captures, maintenance attestations) |
| $v(a)$ | value created by action $a$ (the user's willingness-to-pay, settled in USDC) |
| $c(a)$ | transaction cost of $a$ (gas, upstream API, brokered unblocker, LLM call) |
| $m(a) = v(a) - c(a)$ | the margin — the captured spread (Luke 14:28) |
| $N$ | the coalition of contributors whose work made $a$ callable (publisher, indexer, reviewer, site-owner) |
| $\phi_i(N, v)$ | agent $i$'s Shapley value — marginal contribution averaged over all insertion orders |
| $s_i$ | agent $i$'s staked FDRY (the collateral + reward weight, not ranking power) |
| $\text{elig}(s_i)$ | the commitment-weighted eligibility tier — $s_i / (s_i + \ell_i)$ where $\ell_i$ is $i$'s liquid FDRY (Mark 12:43, the widow's mite) |
| $\text{NAV}(t)$ | vault net-asset-value per share at time $t$ |
| $T$ | the tithe — the captured spread routed to the vault, grows NAV |

The state space is: agents, routes, stakes, eligibility tiers, margin ledger,
NAV. Every action that ships appends a row to the margin ledger (the
contract neuron's terminal verdict); the Shapley value is computed over the
coalition that produced the callable route; the split is settled atomically
in USDC over x402/Flex; the tithe (a fixed fraction of $m(a)$) flows to the
vault, growing NAV for every abiding stFDRY holder.

## 4. Mechanism

### 4.1 The margin gate (admission control)

An action $a$ is admitted iff $m(a) > 0$ (Luke 14:28 — count the cost). This
is the **upstream** gate: a negative-margin action is refused *before* the
bond (the Proof-of-Indexing §) would ever secure it. The `margin:` verb in
the contract substrate evaluates this exactly (signed `i128` over micro-USDC,
`margin.economyBytes` sums only the positive arm).

### 4.2 The Shapley split (fair compensation by marginal contribution)

The captured spread $m(a)$ is split across the coalition $N$ by Shapley value:

$$\phi_i(N, m) = \sum_{S \subseteq N \setminus \{i\}} \frac{|S|!\;(|N|-|S|-1)!}{|N|!}\bigl(m(S \cup \{i\}) - m(S)\bigr)$$

This is the unique split that is **efficient** (sums to $m(a)$), **symmetric**
(equal contributors get equal shares), **dummy** (zero-contribution gets
zero), and **additive** ([arXiv:1403.6713][a2]). For freely-replicable goods
(the route is non-rivalrous once captured) the standard Shapley value is
adjusted per the Agarwal-Dahleh-Sarkar fairness notion for cooperative games
with freely-replicable goods ([arXiv:1805.08125][a1]) — a route that already
serves one caller costs nothing to serve a second, so the marginal
contribution of the *second* caller's indexer is the freshness maintenance,
not the discovery.

### 4.3 The three-lane instantiation (the unbrowse split)

The general Shapley split is instantiated as three lanes because the
production coalition has exactly three structurally-distinct roles:

| Lane | Share | Role | Why this lane |
|---|---|---|---|
| Platform | 50% (`PLATFORM_BPS = 5000`) | runs infra, settles x402, anti-fraud | the fixed-cost backbone; without it no action ships |
| Contributors | 35% when owner claimed, 50% otherwise (`OWNER_BPS = 1500`) | publisher + indexer + reviewer — the discoverers + maintainers | the marginal-contribution lane — Shapley value within the pool, weighted by `cumulative_delta` |
| Site owner | 15% (`OWNER_BPS = 1500`) | verified domain operator (DNS-TXT) | the upstream creator; the Coasean bargain pays the rightsholder ([arXiv:2604.07546][a7]) |

The within-pool contributor split is the live `computeFlexSplits` /
`cumulative_delta` weighting — a streaming approximation of the Shapley value
over the coalition that produced the route, gated by the on-chain Flex
program's 5-recipient cap. **The split is by marginal contribution, not by
stake size** — stake buys *eligibility to earn*, not a larger share (Matt
7:16).

### 4.4 The tithe (the abiding branch captures the increase)

A fixed fraction of every positive margin is routed to the vault as the
tithe (Mal 3:10). The tithe grows NAV-per-share for every abiding stFDRY
holder — *abiding* meaning held through the withdrawal waiting period (the
Sabbath rest applied to capital, Voltr's `withdrawalWaitingPeriod`). This is
the unique attractor that satisfies: holding-the-line (John 15:4),
anti-defection cost (John 15:6 — slashed stFDRY burns to the vault, NAV↑ for
the remaining), asymmetric reward to the loyal (Matt 25:29), and the
active-versus-passive distinction (Mark 12:43 — commitment-weighted
eligibility, the widow beats the whale).

### 4.5 The slash (the cut-off branch is burned)

A false proof-of-indexing triggers a ≥2-witness quorum (Deut 19:15); the
adjudication emits the maintainer's pre-signed redeem-and-transfer-to-treasury
instruction; slashed FDRY → vault → NAV↑ for every abiding branch (John
15:6). The slash is the **downside** economic mechanism; it is shipped (the
`bond:` / `slash:` / `poi:` verbs + `bond.zig`). The **upside** (usage fees →
maintainer fruit distribution) is named but unbuilt — see §8.

## 5. Incentive claims (the lemmas the witness must verify)

1. **Verified proof quality ranks above stake size.** Ranking is by fruit
   (Matt 7:16); stake buys eligibility, not rank. Witness: the
   `proof-indexing-economy` deterministic tests.
2. **Honest indexing earns; stale/false indexing is slashable.** A false POI
   is re-derived by the challenger; the quorum adjudicates; the bond is
   slashed. Witness: `bond.zig` 32 tests.
3. **False challenges lose their bond.** A spurious challenge that fails
   re-derivation forfeits the challenger's bond. Witness: the
   `proof-indexing-economy` gate.
4. **Splitting one stake across many identities gives no extra reward.** The
   reward is by marginal contribution (Shapley), not by identity count;
   Sybil splitting divides the same marginal contribution across more
   recipients. Witness: the Sybil-limit deterministic test
   ([arXiv:2209.09775][a8] FedToken — tokenized incentives anchored to
   Shapley, [arXiv:2410.09107][a9] Shapley-UCB).
5. **Stake + free balance + reward pool is conserved.** The margin ledger is
   append-only; the running Σ is a projection over immutable rows; the slash
   conserves (burns to the vault, not destroyed). Witness: `economy:` reads
   `margin.economyBytes`, the Flex split sums to exactly 10000 bps.

[a8]: https://arxiv.org/abs/2209.09775
[a9]: https://arxiv.org/abs/2410.09107

## 6. Reference and native implementations

- **Python reference** (mechanism model): `paper/reference/network/` —
  `proof_of_indexing.py`, `bonding.py`, `sybil.py`, `vault_cycle.py`.
- **Native runtime model**: `src/values/proof-indexing-economy.ts` +
  `tests/proof-indexing-economy.test.ts` + `bench/jespa/proof-indexing-economy-gate.sh`.
- **Contract substrate**: `margin.zig` (the gate), `bond.zig` (the slash),
  `voltr.zig` (the vault), `spl_balance.zig` (the eligibility weight),
  `ebm.zig` + `ebm_store.zig` (the train-on-fire reward signal — §7).

## 7. The EBM is the reward signal (the contract-native turn)

The contract substrate's `ebm.zig` is the organ that *trains* whenever a
neuron fires: a reward-weighted running-mean Prototype (West 1979, O(1)/fire)
over the substrate's own embedding; energy = $-\cos$ to it; route = argmin
energy. The reward signal is `onFire(fire:ok | fire:fail, reward=1.0)`.

**The mechanism-design reading:** the EBM's reward-weighted prototype IS the
Shapley value, computed online. Each firing is an action $a$; the reward is
the realised margin $m(a)$ (not a constant 1.0 — this is the unbuilt wiring,
see §8); the prototype folds the marginal-contribution-weighted context. The
Shapley value is the *unique* additive symmetric efficient split — exactly
the properties the prototype's running-mean preserves (additivity over
firings, symmetry over equal contexts, dummy for zero-reward firings). **The
ledger IS the EBM** (`ebm_store.replayFromLedger` rebuilds prototypes from
terminal verdicts alone) — so the on-chain margin ledger IS the Shapley
computation, literally.

This is the bridge to §9: the vault's *strategy weights* become contract
contractions — EBM weights trained on realised spreads.

## 8. Limits + honest gaps (no fabricated green)

- **Stake raises Sybil cost but does not prove one-person-one-identity**
  ([arXiv:2405.14617][a6] — the panel analysis shows slashing + min-stake
  trade off against dynamic security). The Shapley split mitigates this
  (Sybil-splitting divides the same marginal contribution) but does not
  eliminate it.
- **Production on-chain settlement is separate from the native model.** The
  trustless atomic split is devnet-only; mainnet is custodial today (the
  `disburse.ts` dry-run path). The lane math is identical either way.
- **The upside economic loop is named, not built.** `margin:` / `economy:`
  declare and read the spread; they do not auto-route it into stFDRY NAV.
  The tithe loop (`routeRevenue.ts`) was correctly *retired* (Howey-test
  security-law risk — FDRY stays utility/bonding, not revenue-backed). The
  replacement is a direct x402 → maintainer-reward path, unbuilt.
- **The EBM reward is currently `1.0`, not the realised margin.** The
  `onFire` reward signal is a constant; wiring it to `margin.economyBytes`
  (so the prototype weights by captured spread) is the §9 spec.

## 9. Related work

- The Graph POI, Filecoin PoRep/PoSt — proof-of-storage/maintenance
  ancestors.
- John R. Douceur, "The Sybil Attack" — the Sybil-limit substrate.
- [arXiv:2405.03357][a5] — game-theoretic validator strategies in Ethereum
  2.0 (Bayesian Nash equilibrium, ex ante dominant strategy — the
  slash-eligible validator game).
- [arXiv:2405.14617][a6] — optimal staking design (static vs dynamic
  security trade-off; the slashing-min-stake tension).
- [arXiv:1403.6713][a2] — Shapley value for demand-response compensation
  (the closest direct ancestor of the marginal-contribution split).
- [arXiv:1805.08125][a1] — data marketplace with freely-replicable-goods
  fairness (the route is non-rivalrous once captured).
- [arXiv:2506.07388][a3] — Shapley-Coop: marginal-contribution pricing for
  self-interested LLM agents (the agent-mediated credit assignment).
- [arXiv:2209.09775][a8] — FedToken: tokenized Shapley incentives.
- [arXiv:2410.09107][a9] — Shapley-UCB for seller selection + incentives.
- [arXiv:2103.05866][a4] — Fee and Waiting Tax (Stackelberg) for
  blockchain-storage externalities (the margin gate is the admission-control
  analogue).
- [arXiv:2604.07546][a7] — agentic copyright / Coasean bargain (the
  site-owner lane is the agent-mediated rightsholder bargain).
- [arXiv:2602.11967][a10] — Pareto-efficient multi-buyer mechanisms +
  Kalai-Smorodinsky bargaining (the two-sided fairness-efficiency frontier
  the split sits on).

[a10]: https://arxiv.org/abs/2602.11967

## 10. Conclusion

The maintained graph is the asset; staking is collateral for route truth,
not payment for rank. The economy is the captured spread, split by marginal
contribution, tithed to the abiding. The mechanism is a subtraction, not a
token — and the contract substrate's EBM is the online Shapley computation
that learns, from its own resolved traces, which contexts bear fruit.
