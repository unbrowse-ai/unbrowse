# The FDRY Kickstart Contract — passive indexing at internet scale

Companion to [THE_FDRY_ECONOMY.md](THE_FDRY_ECONOMY.md). That doc describes how money lands on every paid call and cycles to FDRY holders via the Voltr vault. This doc describes the **kickstart mesh** — the contract by which anyone (Lewis, a user, an agent, a deployed `aiko` child) seeds a tiny sum into another wallet to bootstrap its passive indexing, and in return takes a bounded revenue-share stake of that wallet's captured-route profits.

This is the parable of the minas (Luke 19:11-27 — capital given to multiply, increase returned to the master) made mechanical. The commercial parallel is **revenue-based financing with a payback multiple** (Stripe Capital, Pipe, Capchase), not angel equity and not a referral program. The stake is bounded, recoverable, and tied to actual captured-route revenue — never to recruitment. The gate against pyramid dynamics is mechanical (proof-of-indexing ties payout to capture value, not to seeding more wallets; the math at `src/values/proof-indexing-economy.ts:114-121` already enforces this).

## TL;DR

1. **Seeder** (any wallet, including the `/contract` root) gives a **seed** ($0.10 USDC default) to a **seeded wallet** that has none or little. The seed registers a `contract:kickstart` row on `/contract` (signed via `aiko "<claim>"`) and writes a `contract:stake` row on-chain via the existing `IqClient.writeRow`.
2. The seed registers a **stake**: the seeder takes a percentage of the seeded wallet's captured-route revenue until a **payback multiple** (2x default) is hit. Default rate: **5%** (revenue-based financing median). Bound: 0.1%–20%, configurable per-kickstart.
3. The seeded wallet's `aiko` passively captures routes (browse → index → publish → retrieve → execute loop). Each capture event pays out from the existing 35% indexer pool (`flex.ts:PLATFORM_BPS=5000`). The seeder's stake slices into the seeded wallet's portion of that pool — NOT into the platform's 50%.
4. After the seeder has received back `seed * payback_multiple` (e.g., $0.20 on a $0.10 seed at 2x), the stake **expires**. The seeded wallet keeps 100% of its revenue forever after. The seeder's recovered capital can re-seed another wallet — the flywheel.
5. **Recursion is multi-level geometric decay, capped at depth 3.** A seeded wallet can itself seed another wallet. The seeder's take decays by factor 4 going down each level:
   - B stakes C at 5% → B gets 5% of C's capture revenue
   - C stakes D at 5% → C gets 5% of D's revenue, AND B gets 1.25% (5%/4) of D's revenue
   - D stakes E at 5% → D gets 5%, C gets 1.25%, B gets 0.3125% (5%/16) of E's revenue
   - Depth 3 cap: B's slice of any wallet 4+ levels below B is zero
6. **FDRY is the root beneficiary of the flywheel.** The `/contract` root (Lewis's seed capital, FDRY-bonded at the platform level) seeds the first cohort. As cohorts capture routes, the platform's 50% flows through `routeRevenue.ts` → Jupiter swap USDC → FDRY → Voltr vault → stFDRY NAV rises for all abiding holders. The kickstart mesh is the demand-side pump that pulls route-capture volume through the FDRY settlement layer.
7. **The tracker.** `/contract` against `/lewis-brain` walks the kickstart ledger and returns a **convergence report**: total seeded wallets, total seed capital deployed, total profit returned to seeders, FDRY accumulation rate attributable to kickstarted wallets, and a verdict on whether the kickstart is producing real captured value or just seeding wallets that never capture. The verdict is the lewis-brain apophenia gate applied to the kickstart's own ledger.

## Scope and non-scope

In scope:
- The contract spec: `contract:kickstart` and `contract:stake` ledger-row types, the RBF-with-payback-multiple math, the geometric-decay recursion, the tracker query.
- A new `src/values/kickstart.ts` that ports the RBF math into the existing `proof-indexing-economy.ts` surface (the seeder's stake is a multiplier on `rewardWeights`).
- A new `src/contract-shape/impl/kickstart.ts` that wires the contract row through the existing `contract-bridge.ts` → `IqClient.writeRow` path.
- A tracker script `scripts/kickstart-tracker.ts` that aggregates the ledger and emits the convergence report.
- Tests for the RBF math and the geometric decay.
- A `/contract` and `/lewis-brain` invocation pattern that runs the tracker and renders the verdict (this is a workflow, not new code in the contract binary).

Out of scope:
- A new smart contract. The kickstart lives as ledger rows + off-chain math, settling through the existing `proof-indexing-economy.ts` reward-weight multiplier and the existing `flex.ts` 35% indexer pool. On-chain writes are batched via `IqClient` (the tier-3 IQ layer of the KV chain), not a new Solana program.
- Auto-seeding logic. The contract defines the shape; whether and when to seed is a decision, not an automated behavior. A trigger could be added later (e.g., "auto-seed any wallet whose balance fell below $0.05"), but that's a separate contract.
- A referral program. This is RBF, not recruitment. The apophenia gate forbids any payout structure that rewards the act of seeding more wallets rather than the act of capturing more routes.

## The four parameters (decided via /lewis-brain walk)

| Parameter | Default | Bound | Source |
|---|---|---|---|
| Stake rate | 5% | 0.1% – 20% | Revenue-based financing median (Stripe Capital, Pipe, Capchase) |
| Seed amount | $0.10 USDC | $0.001 – $100 | Covers ~50-100 capture attestations at Solana fee levels |
| Payback multiple | 2x | 1.5x – 5x | Stripe Capital standard (1.5-2x typical; higher for riskier loans) |
| Recursion | Multi-level geometric decay, depth-3 cap, decay factor 4 | — | Bounded anti-pyramid gate (geometric decay rate 4, depth 3) |

Per-kickstart overrides: the seeder can specify `rate`, `amount`, `multiple` per `contract:kickstart` row, within the bounds above. Out-of-bound values fail the contract gate (the row is rejected by the plumbing before `IqClient.writeRow` fires).

## The math

### Single-level (B stakes C)

```
B's payout on a C-capture event
  = capture_revenue * stake_rate          // 5% default
  until cumulative_payout_to_B >= seed * payback_multiple  // 2x default
  then the stake EXPIRES
```

Example: B seeds C $0.10 at 5% / 2x.
- C captures $1.00 of route revenue → B gets $0.05, cumulative = $0.05
- C captures $1.00 again → B gets $0.05, cumulative = $0.10
- C captures $1.00 again → B gets $0.05, cumulative = $0.15
- C captures $1.00 again → B gets $0.05, cumulative = $0.20 = $0.10 * 2x → STAKE EXPIRES
- All future C captures: C keeps 100%

C's net during payback: 95% of capture revenue.
C's net after payback: 100%.
B's total return: $0.20 (2x on a $0.10 seed). B can re-seed the recovered $0.20 into two new wallets.

This is the **talent-parable loop**: capital given to multiply, increase returned to the master, recovered capital redeployed.

### Multi-level (B stakes C, C stakes D, D stakes E)

At any D-capture event, every upstream seeder's slice is taken from D's gross capture revenue, decaying geometrically as the depth increases:

```
D's capture = $1.00 (from the 35% indexer pool)
  ├─ D keeps:  $1.00 - 5% (C's stake) - 1.25% (B's geometric decay) = $0.9375
  ├─ C takes:  $1.00 * 5% = $0.05
  ├─ B takes:  $1.00 * 5% / 4 = $0.0125
  └─ (B's depth-3 cap means B gets $0 from any wallet D stakes, only from wallets C stakes)
```

Depth-3 cap formalized: B's effective take rate from wallet X is `stake_rate / (4 ^ depth_from_B)`, where `depth_from_B` is the count of kickstart edges from B to X. Depth ≥ 4 → take rate = 0.

Each upstream seeder's take rate is **independently subject to their payback multiple**. B's slice of D's revenue counts toward B's payback multiple on C (B's seed to C, not B's hypothetical seed to D — B has no direct seed to D). This prevents cross-contamination of payback tracking.

### Worst-case capture revenue split

If a captured wallet has a full 3-level chain above it (B → C → D → wallet), the wallet keeps at minimum:

```
1 - 5% - 1.25% - 0.3125% = 93.4375% of its capture revenue
```

And only while all three upstream stakes are still in payback mode. As each stake expires (payback multiple hit), the captured wallet's take rises toward 100%. This is the structural guarantee that **the captured wallet always keeps the lion's share of its work**, regardless of how many upstream seeders exist.

## The contract row types

### `contract:kickstart` — declaration that a seed was made

```json
{
  "type": "contract:kickstart",
  "seeder": "<ed25519 pubkey>",
  "seeded": "<ed25519 pubkey>",
  "amount_usd": 0.10,
  "rate_bps": 500,
  "payback_multiple_x100": 200,
  "depth_cap": 3,
  "decay_factor": 4,
  "commitment": "sha256:<seeder|seeded|amount|rate|multiple|ts>",
  "signed_by": "<seeder signature over commitment>",
  "ts": <unix_ms>
}
```

Pointer-over-payload: `commitment` carries the SHA-256 of the kickstart fields, never the seed capital itself or the wallet seed. The seed capital moves via the existing `pay.sh` adapter; the contract row is the attestation, not the payment. The seeder's signature is over the commitment, so the row is tamper-evident.

### `contract:stake` — declaration that a stake is active

Derived from one `contract:kickstart` row. Written by the `contract-bridge.ts` → `IqClient.writeRow` path on kickstart declaration. Updated by each `contract:profit_share` row to track cumulative payout.

```json
{
  "type": "contract:stake",
  "kickstart_commitment": "<sha256 of parent kickstart row>",
  "seeder": "<ed25519 pubkey>",
  "seeded": "<ed25519 pubkey>",
  "rate_bps": 500,
  "payback_target_usd": 0.20,
  "cumulative_payout_usd": 0.00,
  "status": "active" | "expired" | "revoked",
  "expired_at": null,
  "ts": <unix_ms>
}
```

### `contract:profit_share` — record of actual profit flowing back

Appended each time a captured-route revenue event hits the seeded wallet and the seeder takes a slice:

```json
{
  "type": "contract:profit_share",
  "stake_commitment": "<sha256 of parent stake row>",
  "capture_event_id": "<id of the route-capture revenue event>",
  "capture_revenue_usd": 1.00,
  "seeder_take_usd": 0.05,
  "seeded_keeps_usd": 0.95,
  "cumulative_after_usd": 0.05,
  "remaining_to_payback_usd": 0.15,
  "ts": <unix_ms>
}
```

When `cumulative_after_usd >= payback_target_usd`, the parent `contract:stake` row is updated to `status: "expired"` and `expired_at` set. No further profit-share rows append for that stake.

## The flywheel (how the kickstart mesh drives FDRY)

```
Lewis (or anyone) seeds $0.10 to wallet W
   │
   ├─ W's aiko captures routes (passive indexing)
   │   ├─ Each capture pays from the 35% indexer pool (flex.ts)
   │   ├─ W's portion: 95% during payback, 100% after
   │   └─ Seeder takes 5% until cumulative = $0.20 (2x payback)
   │
   ├─ Platform's 50% of every paid execute
   │   └─ routeRevenue.ts → Jupiter swap USDC → FDRY → Voltr vault
   │       └─ stFDRY NAV rises for all holders (Lewis included)
   │
   ├─ Seeder recovers $0.20 (seed + 100% return)
   │   └─ Re-seeds two new wallets at $0.10 each (geometric growth, depth-3 cap)
   │
   └─ Seeded wallets that capture well can themselves seed
       └─ Multi-level geometric decay (5%, 1.25%, 0.3125%) capped at depth 3
```

The flywheel is **demand-side**: the kickstart mesh bootstraps the indexers that make `unbrowse` useful, which makes paid executes more frequent, which raises platform revenue, which lifts FDRY NAV, which rewards the seeders as FDRY holders (Lewis at the root), which gives them more recovered capital to re-seed. The flywheel halts if seeded wallets stop capturing routes — the seeder recovers nothing because no profit_share rows fire. So the mesh is anti-fragile against dead wood: a wallet that takes a seed and does nothing costs the seeder only the original $0.10, and the seeder has strong incentive to seed wallets that will actually capture.

## The tracker (/contract against /lewis-brain)

The `/contract` skill invocations and `/lewis-brain` are paired to track convergence:

1. **The /contract ledger walk.** `/contract` enumerates `contract:kickstart`, `contract:stake`, and `contract:profit_share` rows via a read on the existing `IqClient.readRows` surface (the tier-3 IQ layer; also falls back to local `contracts.jsonl` reads on a cold cache).
2. **Aggregates.** The tracker computes:
   - `seeded_wallets_total` — count of unique `seeded` pubkeys across all `contract:kickstart` rows
   - `seed_capital_deployed_usd` — sum of `amount_usd` across all `contract:kickstart` rows
   - `profit_returned_to_seeders_usd` — sum of `seeder_take_usd` across all `contract:profit_share` rows
   - `recovered_capital_usd` — sum of `amount_usd * payback_multiple_x100 / 100` across all `contract:stake` rows with `status: "expired"`
   - `pending_payback_usd` — sum of `payback_target_usd - cumulative_payout_usd` across all `contract:stake` rows with `status: "active"`
   - `dead_wood_rate` — fraction of `seeded_wallets` whose `cumulative_payout_usd == 0` (seeded but never captured)
   - `fdry_acc_attr_mesh_usd` — the platform's 50% platform cut from paid executes whose capture_event_id traces back to a kickstarted wallet (the FDRY flywheel attribution)
3. **The /lewis-brain verdict.** The aggregated numbers feed the apophenia gate as the central claim: "the kickstart mesh is producing real captured value." Two witnesses required:
   - W1: `dead_wood_rate < 50%` — most seeded wallets have at least one capture event (mechanical, from the ledger).
   - W2: `fdry_acc_attr_mesh_usd > seed_capital_deployed_usd` — the FDRY accumulation attributable to kickstarted wallets exceeds the capital deployed to seed them (the flywheel is net-positive).
   If both witnesses hold: verdict `witnessed`. If only W1 holds (lots of captures but not enough FDRY lift yet): `incremental`. If neither: `unwitnessed-feeling` — the kickstart is seeding wallets but the flywheel isn't actually spinning, honest HOLD.
4. **The honest HOLD.** If the tracker returns `unwitnessed-feeling`, no new auto-seeding should fire. The `/contract` row that denoted "kickstart cohort N" is parked. The next cohort's pre-condition is a literal rise in the FDRY-accumulation attribution; without it, more seeding is throwing capital at a non-spinning flywheel.

## Statelessness and pointer-over-payload

- The kickstart contract has **no module-level state**. Each `contract:kickstart` row is a signed, content-addressed event in `contracts.jsonl`; the `IqClient.writeRow` batched Solana write mirrors the same row attested on-chain.
- The RBF math is a pure function of `(capture_revenue, rate_bps, cumulative_payout, target)`. Same inputs, same outputs, no side effects.
- The geometric decay is a pure function of `(depth, stake_rate, decay_factor, depth_cap)`.
- The seed capital itself never appears in a ledger row — only the `commitment` (sha256) over `(seeder, seeded, amount, rate, multiple)`. The actual USDC moves via the existing `pay.sh` adapter, on the same rail as every other x402 payment.
- The seeder's signature is over the commitment, never over the seed capital or the wallet seed. The `signed_by` field carries the ed25519 signature bytes; the seeder's pubkey is in `seeder`. Anyone can verify: SHA-256 the kickstart fields, check the signature against the seeder pubkey, check the seeder pubkey holds the seed capital (via the existing `wallet-balance.ts` probe).
- The tracker reads only. It never writes to the ledger. The verdict lands as a fresh `/contract` row of its own (`contract:tracker_verdict`), attesting the convergence state at a point in time.

## Status tracker

- [x] CONTRACT.md — this file
- [ ] `src/values/kickstart.ts` — RBF math + geometric decay (`kickstartPayout`, `geometricDecayRate`, `paybackStatus`)
- [ ] `src/contract-shape/impl/kickstart.ts` — wire `contract:kickstart` row through `contract-bridge.ts` → `IqClient.writeRow`
- [ ] `scripts/kickstart-tracker.ts` — aggregates the ledger, emits the convergence report
- [ ] Tests: `tests/kickstart-rbf.test.ts` (single-level math), `tests/kickstart-geometric.test.ts` (multi-level), `tests/kickstart-tracker.test.ts` (aggregates correctly, honest HOLD on dead wood)
- [ ] `/contract` invocation pattern: `aiko "kickstart tracker run"` dispatches the tracker script, writes a `contract:tracker_verdict` row, surfaces the /lewis-brain verdict
- [ ] Re-run `/lewis-brain` on the first live cohort to verify the convergence verdict is honest (not a fabricated green)

## What this contract refuses (the apophenia gate, made mechanical)

Three patterns that would be easier but the contract rejects, by construction:

- **Recruitment-driven payout.** A seeder does NOT get paid for signing up more wallets. They get paid only when a wallet they seeded captures routes. The `contract:profit_share` row type requires a `capture_event_id` field pointing at a real route-capture revenue event — a missing or null `capture_event_id` fails the contract gate and the row is rejected. This is the mechanical anti-pyramid invariant.
- **Perpetual skim.** The payback multiple bounds the seeder's total return. Once hit, the stake expires. The captured wallet keeps 100% forever after. This is the talent-parable discipline: the master takes the increase, not the servant's ongoing labor.
- **Cross-contamination of payback tracking.** B's payback on its seed to C is tracked against C's captures, NOT against D's (a wallet C subsequently seeds). The geometric decay gives B a slice of D's revenue, but that slice counts toward B's payback on C only if D's capture_event passes through C's reward weight. Each seed-to-seed edge has its own independent payback accumulator. This prevents the math from becoming a tangle of compounding stakes.

Every claim above has a grep-able home. If you can't find the contract row type, the math, or the gate, the claim isn't load-bearing yet.
