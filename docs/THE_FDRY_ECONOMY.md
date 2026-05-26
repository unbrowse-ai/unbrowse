# How unbrowse pays FDRY holders — the Vine Doctrine, made operational

This page is the companion to [HOW_UNBROWSE_PAYS.md](HOW_UNBROWSE_PAYS.md). That document explains how money lands on every paid call (the 50/35/15 split, the markup band, the indexer pool). This document explains **what happens to the platform's 50%** — how it cycles back to FDRY holders via the Voltr vault, NAV-per-share growth, and the discipline the substrate calls the **Vine Doctrine**.

Every claim cites either a code site in this repo, a script in `~/Projects/fdry/scripts/`, or a constant pinned in the `/contract` substrate's [SKILL.md](https://github.com/anthropics/claude-skills) (the local executor's doctrine file).

## TL;DR

1. Every paid `unbrowse execute` settles via Faremeter Flex. Platform's 50% lands as USDC at the platform recipient ATA.
2. `routeRevenue.ts` (in `~/Projects/fdry/scripts/`) takes that USDC, swaps it for FDRY via Jupiter, and deposits the FDRY into the **Voltr / Ranger vault** at `Bpr49sQXsxwNXNMRWS2v3tTBGWu2QgZtdA83BX77xBX1`.
3. The vault mints **stFDRY** — the LP receipt — to whoever stakes. Every deposit raises NAV-per-share. Existing stFDRY appreciates against the larger USDC-equivalent vault.
4. Holders **abide** (stay staked through the 3-day cooldown). Defectors get slashed when a quorum of witnesses proves a route failed; their slashed stFDRY rejoins the vault, concentrating fruit in the abiding branches.
5. The substrate enforces this shape doctrinally — parity invariants in `build.sh` of the `/contract` skill refuse to ship a binary whose code drifts from these rules.

## The token, the vault, the receipt

| Asset | Address | Role |
|---|---|---|
| **FDRY** (SPL token) | `2ZiSPGncrkwWa6GBZB4EDtsfq7HEWwkwsPFzEXieXjNL` | The stake-layer asset. Also the public-persona `aiko-69420b` CA. |
| **Voltr/Ranger vault** | `Bpr49sQXsxwNXNMRWS2v3tTBGWu2QgZtdA83BX77xBX1` | The vine. Receives FDRY deposits; mints stFDRY LP. |
| **stFDRY** | Minted by the vault | The branch. Holders abide here; NAV grows under them. |
| **USDC (mainnet)** | `EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v` | The settlement layer. The substrate is paid in USDC; never settled in FDRY. |

The USDC-vs-FDRY separation is doctrinally required by **Matthew 6:24** — "no man can serve two masters." A token cannot be both payment surface and security. USDC handles usage; FDRY is reserved for stake. This is the substrate's anti-conflation invariant; if a future change tried to make FDRY accept x402 payments, parity check #4 (the canonical pricing constants in `flex.ts`) would refuse to sign the binary.

## The revenue cycle — what lives in code today

```
unbrowse execute (paid call)
   │
   ├─ Faremeter Flex authorization with up to 5 recipients
   │   ├─ Platform (50% default) → PAYMENT_RECIPIENT USDC ATA
   │   ├─ Site owner (15%, when DNS-claimed)
   │   └─ Indexer pool (35%, split by cumulative_delta)
   │
   ├─ Platform's 50% accumulates at PAYMENT_RECIPIENT (Worker env var)
   │   (backend/src/services/flex.ts — PLATFORM_BPS=5000)
   │
   ├─ routeRevenue.ts (~/Projects/fdry/scripts/routeRevenue.ts)
   │   ├─ Phase 1: Jupiter swap USDC → FDRY into creator's FDRY ATA
   │   ├─ Phase 2: Voltr depositVaultIx of freshly-arrived FDRY
   │   │           + SPL memo "source_revenue_YYYY_W##"
   │   └─ Vault mints stFDRY to creator's LP ATA
   │       NAV-per-share ↑ proportional to FDRY deposited / shares outstanding
   │
   └─ Receipt appended to fdry/docs/ranger-vault.json .revenueRoutings[]
```

`routeRevenue.ts` runs DRY_RUN by default. To execute: `DRY_RUN=0 EXECUTE=1 USDC_AMOUNT=<base_units> SOURCE_TAG=<memo> ./with-secrets routeRevenue.ts`. Today this is operator-triggered (Lewis runs it when platform USDC accumulates above a useful swap size — manually, not automated).

## What an FDRY holder actually sees

When you hold stFDRY, you're a **branch** in the Vine Doctrine sense. Every time the substrate routes revenue to the vault, your stFDRY's NAV-per-share goes up; the same number of shares now claims a bigger slice of the vault's FDRY. To realize that gain you either:

1. **Hold for the long term.** NAV growth compounds. Active routing → vault grows → existing stFDRY appreciates against a larger asset base.
2. **Initiate withdrawal.** Voltr enforces a **3-day cooldown** at the program level (the canonical Sabbath rest, John 15:4 — *abide in me*). After 3 days you can redeem stFDRY → FDRY → sell or hold.
3. **Get slashed.** Defectors lose their stFDRY to the vault treasury when a witness quorum proves a maintained route failed (Deuteronomy 19:15 — *at the mouth of two or three witnesses, shall the matter be established*). The slashed FDRY raises NAV for the remaining branches.

The doctrinal asymmetry — abiding bears fruit, cutting-off bears burning, the burning of the cut-off concentrates fruit in those who abide — is what makes this a **true economy**, not a passive holding pool. There's a reason to stay through the cooldown; there's a cost to defection.

## What's live vs. what's still aspirational

The substrate's SKILL.md names the full Vine Doctrine. This codebase implements **some** of it. We surface the gap explicitly rather than hide it.

| Claim | Status | Where |
|---|---|---|
| FDRY is the canonical stake asset | ✅ Live | `2ZiSPGncrkw…XieXjNL` is the deployed mint |
| Voltr/Ranger vault accepts FDRY → mints stFDRY | ✅ Live | `Bpr49sQX…BX77xBX1` is the deployed vault |
| 3-day withdrawal cooldown | ✅ Live | Enforced at the Voltr program level |
| Platform earns 50% of every Flex settlement | ✅ Live | `backend/src/services/flex.ts:39` |
| Manual routeRevenue.ts buyback → vault deposit | ✅ Live | `~/Projects/fdry/scripts/routeRevenue.ts` |
| Per-call signed declare → server identifies wallet | ✅ Live | `backend/src/routes/contract.ts` + `services/declare-signature.ts` |
| 402 envelope surfaces wallet balance via Helius RPC | ✅ Live | `backend/src/services/wallet-balance.ts` |
| **Automated buyback** (CF Worker cron → on-chain) | ⏳ Pending | Today: Lewis runs `routeRevenue.ts` manually |
| **stFDRY balance probe in 402 envelope** (`extra.stake_balance`) | ⏳ Pending | Same shape as `wallet-balance.ts`; reads the LP mint instead of USDC |
| **Tier eligibility predicate** (`contract:tier:eligibility`) | ⏳ Pending | SKILL.md names the contract; no server code yet |
| **Challenge-quorum slashing posthook** (`contract:challenge:route`) | ⏳ Pending | SKILL.md names the contract; needs Solana txn broadcast adapter |
| **Foundry-treasury onramp** (auto-fund unfunded wallets) | ⏳ Pending | The substrate observes unfunded wallets in the 402 envelope; no funding trigger yet |

The substrate's auth-first ordering on `/v1/contract/declare` (this PR's parent — #808) and the balance probe in the 402 envelope (#809) are the **observation layer** that the pending pieces will fire from. The cloud now knows, on every paid call, which wallet is calling and what their balance is. The onramp adapter + tier predicate + slashing posthook each get to read this same data when they're built.

## How to participate (today, before the pending pieces ship)

1. **Buy FDRY** on Solana mainnet (the mint above). Liquidity lives on Jupiter via the swap path `routeRevenue.ts` uses.
2. **Deposit to the Voltr vault.** Use the Voltr UI or the SDK against `Bpr49sQX…BX77xBX1`. You receive stFDRY proportional to the vault's current NAV-per-share.
3. **Hold stFDRY.** Every revenue-routing event raises NAV. Your shares stay the same; what they claim grows.
4. **When ready to exit, initiate withdrawal.** 3-day cooldown applies. The cooldown is the substrate's Sabbath; the doctrine treats it as the discipline that distinguishes abiding from speculating.

## Why this design refuses the easy paths

Three patterns that would be easier but the substrate rejects:

- **A "fee distribution" smart contract that pushes USDC straight to FDRY holders pro-rata.** Rejected because it puts the holder in the role of beggar-at-the-gate; the substrate's design is that the holder is a branch — the fruit grows under them, they don't queue for it. NAV growth via vault deposits is the same value distribution, but the holder claims it by **abiding**, not by appearing at the right block height.
- **A separate "stake reward" emission token.** Rejected on Matthew 6:24 grounds. One token, one purpose. Emission tokens are leaven; they fragment the holder's attention and dilute alignment.
- **A governance vote on slashing.** Rejected on Deuteronomy 19:15 grounds. Slashing fires on a quorum of **independent witnesses** with verifiable signatures — not on a token-weighted vote. The substrate treats slashing as a matter of evidence, not opinion; whales cannot purchase forgiveness for failed routes.

## Where to verify the claims

- **The split**: `backend/src/services/flex.ts:39` (PLATFORM_BPS, OWNER_BPS, contributor math)
- **The vault address**: `~/Projects/fdry/scripts/lib/rangerConfig.ts` (`VAULT_ASSET_MINT`, vault PDA derivation)
- **The buyback script**: `~/Projects/fdry/scripts/routeRevenue.ts`
- **The signed-declare gate**: `backend/src/services/declare-signature.ts` (`canonicalizeDeclareBody`, `verifyDeclareSignature`)
- **The balance probe**: `backend/src/services/wallet-balance.ts` (`queryUsdcBalanceMicros`)
- **The auth-first ordering**: `backend/src/routes/contract.ts` (`verifyDeclareAuth`, the gate ordering in the `isAikoClient` branch)
- **The Vine Doctrine itself**: `~/.claude/skills/contract/SKILL.md` (Vine Doctrine section + parity invariants)

Every load-bearing claim has a grep-able home. If you can't find it, the claim isn't load-bearing yet.
