# x402 Routing Plan — v6.16

**Status:** Draft 2026-05-14 (post-v6.15.0)
**Owner:** Lewis
**Audience:** anyone touching `backend/src/middleware/x402-gate.ts`, `backend/src/services/{cascade,splits,sponsor-pay}.ts`, or routes that take payment.

## Why this plan exists

Three honest gaps surfaced in the v6.15.0 Day-6 audit:

1. **Single-contributor skills bypass the 10% platform cut.** `selectPrimaryContributor` returns the contributor wallet directly; `ensureSkillCascadeSplit` bails out when `contributors.length <= 1`. Result: solo creators (the typical day-1 case) take 100% and platform earns 0% on their skills. The flywheel doc's "platform's 10% cut" is true for multi-contributor only.
2. **Sponsor flow never recoups the platform cut.** `sendSponsorPayment` is a direct SPL transfer from the Cascade signer to the creator. The platform pays the principal AND the gas, gets 0% back. Worth keeping if the goal is pure subsidy, but worth costing if the goal is flywheel-priming.
3. **Facilitator is hardcoded.** `CORBITS_FACILITATOR_URL = "https://facilitator.corbits.dev"` lives as a `const`. No env override, no fallback, no per-chain selection. If Corbits is degraded or rate-limits us, every paid execute fails.

This plan fixes all three with citations to the canonical specs.

## Source-of-truth references

| Source | What it says | Why it matters here |
|---|---|---|
| [coinbase/x402 spec](https://deepwiki.com/coinbase/x402) | `paymentRequirements.accepts[]` is single-`payTo` per requirement. Facilitator exposes `POST /verify` + `POST /settle`. Multi-recipient is NOT in the protocol — must be orchestrated via batch transfers (Permit2 on EVM) or via an on-chain split account on Solana | The 10% cut cannot live in the x402 payload — it has to live in what `payTo` POINTS at. That's a Cascade split. |
| [faremeter/faremeter](https://deepwiki.com/faremeter/faremeter) | TypeScript x402 implementation with Hono-based facilitator. `@faremeter/middleware` + `@faremeter/facilitator` packages. Supports Solana (SOL + SPL/USDC) and EVM (Base Sepolia, etc.). Corbits IS a Faremeter facilitator. | If we want a self-hosted backup facilitator, Faremeter is the on-ramp. Drop-in adapter for `/verify` and `/settle`. |
| [PayAINetwork/x402-solana](https://github.com/PayAINetwork/x402-solana) | npm `x402-solana`. SDK middleware + client. Facilitator URL is configurable (defaults to `https://facilitator.payai.network`). v2 spec. **Single `payTo` per request — no native multi-recipient splitting.** USDC mints for devnet (`4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU`) and mainnet (`EPjFW…TDt1v`). | A second Solana facilitator we can adapt for redundancy + comparison. |
| [cascade-protocol/splits](https://github.com/cascade-protocol/splits) | Non-custodial Solana payment-splitting protocol. PDA-owned ATA vault. **Distribution is NOT auto-on-receive — requires explicit `execute_split()`.** 1% protocol fee deducted on-chain. Recipients shape `{address, share}`, 1–20 recipients per split. SPL + Token-2022 supported. SDK at `@cascade-fyi/splits-sdk`. | The key fact: a split vault HOLDS funds until `execute_split()` is called. We must wire that call, or creators see earnings stuck in a vault. |

The deepwiki summary for Coinbase's spec puts it bluntly: "The core protocol appears to use a single `payTo` field per payment requirement, suggesting native support for one-to-one transfers. Multi-recipient scenarios would require either orchestrating multiple sequential payments, implementing custom settlement logic via extensions, or batch transfers through mechanism-specific features."

That maps cleanly to: **on Solana, set `payTo` = Cascade split vault, then trigger `execute_split()` after settle.**

## GOAL (north star)

Every paid execute on Unbrowse routes through a Cascade split that gives the platform its 10% cut, even when there's only one contributor. The facilitator selection is env-driven with chain-aware routing and a healthy-fallback chain. Sponsor mode optionally recoups 10% to the platform when configured.

## ACCEPTANCE CRITERIA (30, ordered by phase)

### Phase 0 — Signup gate: wallet + api key required, no trailing setup

The most important phase. v6.15 lets agents register with just an email and immediately get an API key; wallet pairing is "encouraged" via `unbrowse setup`'s lobster.cash prompt but skippable. Result: half of registered agents have no wallet, lean on sponsor credit, and the platform pays for them indefinitely. v6.16 closes that door.

- **P0.1** `unbrowse setup` (CLI bootstrap) cannot complete without a paired wallet address. The flow becomes: ToS accept → email → wallet pairing (lobster.cash via `npx @crossmint/lobster-cli setup`, OR manual `--wallet-address <addr>`) → API key minted. Skipping the wallet step exits non-zero with an actionable error pointing to either path.
- **P0.2** Backend registration endpoint `POST /v1/agents/register` rejects requests where `wallet_address` is empty or missing. 400 with `{ error: "wallet_address_required", remediation: "Run unbrowse setup or pair via /account" }`. No exceptions — including the `__admin__` shortcut, which moves to a separate admin-only flow.
- **P0.3** Existing v6.15-era agents who registered without a wallet get a soft block: the next request to any priced route returns 402 with a special `X-Wallet-Required: 1` header and a body explaining they need to pair a wallet via `/account` or `unbrowse setup --pair-wallet` before continuing. Free routes (health, search read-only) keep working so the user can still inspect their account.
- **P0.4** `/account` UI in the frontend adds a "Pair wallet" CTA at the top of the page for users with `wallet_address === null`. The CTA links to `/account/wallet` which embeds the lobster.cash/Crossmint pairing flow. Wallet address shows the pairing status and last verified block.
- **P0.5** Sponsor pool semantics tighten: sponsor credit is a **top-up**, not a free tier. Eligibility: agent must have a paired wallet AND have made at least one successful execute paid from their own wallet in the last 30 days. New agents get a one-time $0.50 sponsor allowance to bootstrap (pair-wallet → first-execute), capped lower than the $1/day daily allowance.
- **P0.6** Tests: `backend/tests/signup-wallet-gate.test.ts` (5 cases — missing wallet rejected, valid wallet accepted, existing-no-wallet-agent gets 402 with `X-Wallet-Required`, admin shortcut still works on admin endpoint only, sponsor allowance reduced for new no-history agents).

### Phase 1 — Always-Cascade routing (the 10% fix, continues)

### Phase 1 — Always-Cascade routing (the 10% fix)

- **P1.1** `backend/src/services/splits.ts::syncSkillSplitConfig` no longer bails out when `contributors.length === 1`. For a single contributor, the split has TWO recipients: the contributor at share 90 + platform wallet at share 10 (Cascade's 1% protocol fee comes off the top → contributor receives ~89.1%, platform ~9.9%).
- **P1.2** `backend/src/services/cascade.ts::ensureSkillCascadeSplit` removes the `if (contributors.length <= 1) return {}` guard at L77. New guard: only bail out if `payableContributors.length === 0` (no wallet at all → cannot split).
- **P1.3** `backend/src/middleware/x402-gate.ts::buildSkillPaymentTerms`'s `recipient` arg is the **split vault address**, never the raw contributor wallet, for any skill that has at least one payable contributor.
- **P1.4** A new helper `resolveSkillPayout(env, skill)` returns `{ payTo, isSplit, splitConfig? }` and is the only function any route uses to get the address.
- **P1.5** Tests: `backend/tests/splits-single-contributor.test.ts` proves the two-recipient split (creator + platform) for solo skills.

### Phase 2 — execute_split hook after settle

- **P2.1** After Corbits/Faremeter/PayAI confirms settlement, the route handler triggers `execute_split()` on the affected vault via the Cascade SDK. Best-effort, non-blocking on the request response: fire-and-forget into `ctx.waitUntil(...)` so the user's request doesn't wait for the second tx.
- **P2.2** A separate worker job (`backend/scripts/sweep-cascade-vaults.ts`) runs on a schedule and calls `execute_split()` on any vault with non-zero USDC balance. Catches missed hooks + the "unclaimed funds from missing ATA" case Cascade's claim-based model creates.
- **P2.3** Test: `backend/tests/cascade-execute-after-settle.test.ts` proves the hook fires after a mock-settle and that a recipient with a pre-existing ATA receives USDC in the next block.

### Phase 3 — Facilitator abstraction

- **P3.1** New file `backend/src/services/facilitator.ts` exports:
  - `interface Facilitator { name; url; supports(chain): boolean; verify(payload); settle(payload); supported() }`
  - `selectFacilitator(env, chain): Facilitator` — env-driven (`X402_FACILITATOR_SOLANA`, `X402_FACILITATOR_BASE`, fallbacks via `X402_FACILITATOR_FALLBACKS_CSV`)
  - Built-in adapters: `corbitsFacilitator()`, `payaiFacilitator()`, `faremeterFacilitator(baseUrl)` (for a self-hosted instance)
- **P3.2** `backend/src/middleware/x402-gate.ts` `CORBITS_FACILITATOR_URL` const DELETED. Every `fetch(\`${URL}/...\`)` call goes through `selectFacilitator(env, chain).{verify,settle,supported}()` instead.
- **P3.3** Per-chain default: Solana → PayAI primary (their network, their stack, faster path); Base → Coinbase / Corbits; fallback chain: Corbits multi-chain. All env-overridable.
- **P3.4** Health check: facilitator interface gains `health()` returning `{ ok, latency_ms }`. Selector skips unhealthy facilitators and falls through.
- **P3.5** Test: `backend/tests/facilitator-selector.test.ts` — 6 cases (Solana default, Base default, Solana override, fallback when primary fails, all-facilitators-down → 502, unknown-chain).
- **P3.6** Wrangler bindings: `X402_FACILITATOR_SOLANA="https://facilitator.payai.network"`, `X402_FACILITATOR_BASE="https://x402.org/facilitator"`, `X402_FACILITATOR_FALLBACKS="https://facilitator.corbits.dev"`. All overridable via env vars.

### Phase 4 — Sponsor mode optional recoup

- **P4.1** Add env flag `SPONSOR_USE_CASCADE_SPLIT="1"` (default off). When on, `sendSponsorPayment` sends to the skill's Cascade split vault (which auto-distributes 89.1/9.9/1 once `execute_split` is called), instead of direct-to-creator.
- **P4.2** When `SPONSOR_USE_CASCADE_SPLIT=0` (default), behavior is unchanged: direct SPL transfer to creator, platform absorbs full cost. This preserves the v6.15.0 narrative ("first $1/day is on the house") for the cold-start month.
- **P4.3** Test: `backend/tests/sponsor-cascade-route.test.ts` — both flags, both outcomes, ledger row carries `payment_method: "direct" | "cascade_split"` for audit.

### Phase 5 — Docs + analytics

- **P5.1** `docs/x402-flywheel.md` updated: section 5 ("10% platform cut") drops the "Cascade-split-only" caveat; section 3 ("sponsor mode") notes the optional recoup toggle.
- **P5.2** `docs/x402-routing-plan-v6.16.md` (this file) becomes `docs/x402-routing.md` after v6.16 ships — the live operational doc.
- **P5.3** `GET /v1/admin/sponsor-ledger` response includes `payment_method` field per row.
- **P5.4** Implement `/v1/analytics/payments` (deferred from v6.15.0's D3 TODO). Returns:
  ```json
  {
    "platform_cut_usd_24h": "12.34",
    "platform_cut_usd_30d": "456.78",
    "sponsor_settled_usd_24h": "0.50",
    "sponsor_recouped_usd_24h": "0.05",
    "creator_payouts_usd_24h": "111.00",
    "facilitator_breakdown": { "corbits": 80, "payai": 18, "faremeter": 2 }
  }
  ```
  The deferred TODO in `backend/src/routes/admin.ts:13-17` is finally closed.

## NON-GOALS

- **Multi-token settlement.** USDC stays the only asset. Adding USDT or chain-native tokens is its own loop.
- **EVM-side splits.** Cascade is Solana-only. EVM equivalent (0xSplits, Splits.org) is a future loop. For now, EVM `payTo` stays a single contributor wallet.
- **Per-skill custom share ratios.** Platform is always 10. Contributors split the remaining 90. Custom ratios (e.g. founder skill = 0% platform fee) is a v6.17+ feature.
- **Migrating the existing single-contributor skills' historical earnings.** Pre-v6.16 settled payments stay where they are; the platform cut starts on v6.16-and-later executes only.

## RISKS

- **R1: Cascade split provisioning latency on cold execute.** First paid call against a never-split skill blocks while we call `ensureSplit`. Mitigation: provision the split lazily AT PUBLISH-TIME, not at first execute; for skills already published, run a one-time backfill worker (`scripts/backfill-cascade-splits.ts`).
- **R2: `execute_split()` gas cost > 10% cut for small payments.** A $0.01 paid execute pays $0.01 × 0.099 = ~$0.001 to platform; if `execute_split()` costs $0.005 in fees, we lose money. Mitigation: batch `execute_split()` across multiple settled payments via the periodic sweep worker (P2.2). Only trigger on-settle for payments above a threshold (env: `CASCADE_EXECUTE_SPLIT_MIN_USD="0.10"`).
- **R3: Facilitator interface drift.** Corbits and PayAI both follow the x402 spec, but their `extra` field shapes may differ. Mitigation: each adapter normalises its `extra` to a canonical shape we own; integration tests pin the contract per facilitator.
- **R4: PayAI as primary Solana facilitator means we depend on `https://facilitator.payai.network` uptime.** Mitigation: P3.4 health check + automatic fallback to Corbits. Status: structural, no fix needed beyond the fallback chain.
- **R5: Cascade's 1% protocol fee is unavoidable.** Means platform cut is 9.9% effective, not flat 10%. Mitigation: document this in docs/x402-flywheel.md and `/v1/analytics/payments` returns the post-fee number. Don't pretend.
- **R6: Existing single-contributor skills with `split_config` already set.** A prior incorrect single-recipient split might be cached. Mitigation: backfill worker invalidates and re-creates splits where contributor count is 1 but split has only one recipient.

## OUT-OF-SCOPE (own future loops)

- Per-chain facilitator A/B testing harness with conversion-rate measurement
- EVM-side splits (0xSplits / Splits.org integration)
- Multi-token pay rails (USDT, native SOL, native ETH)
- Wallet-side reconciliation UI on `/account` showing per-skill earnings split history
- Anti-Sybil checks on the platform share (preventing creators from listing themselves twice as "two contributors" to dodge the platform cut)

## Files touched (estimate)

| Path | Change | Phase |
|---|---|---|
| `src/cli-setup.ts`, `src/runtime/setup.ts` | EDIT — wallet pairing becomes a required step of `unbrowse setup`; non-zero exit if skipped | P0 |
| `backend/src/routes/agents.ts` (register endpoint) | EDIT — reject empty `wallet_address` with 400 + remediation hint | P0 |
| `backend/src/middleware/wallet-required.ts` | CREATE — middleware emits 402 `X-Wallet-Required: 1` for existing no-wallet agents on priced routes | P0 |
| `frontend/src/app/account/page.tsx` + `frontend/src/app/account/wallet/page.tsx` | EDIT/CREATE — "Pair wallet" CTA + pairing flow | P0 |
| `backend/src/middleware/sponsor.ts` | EDIT (P0) — tighten eligibility: paired wallet + first-paid-execute history; $0.50 bootstrap allowance | P0 |
| `backend/tests/signup-wallet-gate.test.ts` | CREATE — 5-case matrix | P0 |
| `backend/src/services/splits.ts` | EDIT — drop `payable.length <= 1` shortcut; always include platform recipient | P1 |
| `backend/src/services/cascade.ts` | EDIT — relax single-contributor guard | P1 |
| `backend/src/middleware/x402-gate.ts` | EDIT — replace `CORBITS_FACILITATOR_URL` const with selector | P2, P3 |
| `backend/src/services/facilitator.ts` | CREATE — Facilitator interface + 3 adapters + selector | P3 |
| `backend/src/services/sponsor-pay.ts` | EDIT — optional Cascade route | P4 |
| `backend/src/routes/skills.ts`, `demos.ts`, `search.ts` | EDIT — call `resolveSkillPayout` + post-settle `execute_split` hook | P1, P2 |
| `backend/src/routes/admin.ts` | EDIT — wire `/v1/analytics/payments` | P5 |
| `backend/scripts/sweep-cascade-vaults.ts` | CREATE — periodic execute_split worker | P2 |
| `backend/scripts/backfill-cascade-splits.ts` | CREATE — one-time backfill for existing skills | R1 |
| `backend/wrangler.toml` | EDIT — facilitator URLs + threshold env vars | P3 |
| `backend/.env.example` | EDIT — document new env vars | P3, P4 |
| `backend/tests/splits-single-contributor.test.ts` | CREATE | P1 |
| `backend/tests/cascade-execute-after-settle.test.ts` | CREATE | P2 |
| `backend/tests/facilitator-selector.test.ts` | CREATE | P3 |
| `backend/tests/sponsor-cascade-route.test.ts` | CREATE | P4 |
| `docs/x402-flywheel.md` | EDIT — drop multi-contributor-only caveat; document Cascade fee | P5 |
| `docs/x402-routing.md` | RENAME from this draft | P5 |

## Rollout

1. **Phase 0 ships v6.16.0-preview.0 ALONE.** Wallet/api-key signup gate first — every other phase assumes it. Existing no-wallet agents get one grace cycle via `X-Wallet-Required: 1` 402 responses pointing at the pairing flow. Days 1–7 of v6.16: hard-block new signups without wallet; existing agents get nag headers + frontend CTA. **No more trailing setup.**
2. Phase 1 + 5.1 (docs caveat lift) ship together as v6.16.0-preview.1. Solo skills start earning the platform a cut.
3. Phase 2 ships preview.2 (the execute_split hook + sweep worker). Safe to defer one preview if the periodic-sweep approach is enough for week 1.
4. Phase 3 (facilitator abstraction) ships preview.3. Keep Corbits as the default until tests confirm PayAI parity.
5. Phase 4 (sponsor recoup) ships preview.4. **Off by default** — flip when sponsor-mode actuals show it's worth recouping (probably month 2).
6. Phase 5 (analytics endpoint) ships preview.5. Closes the deferred D3 from v6.15.0.

Stable v6.16.0 after preview.5 stabilises.

## North star (one sentence)

Ship v6.16.0: **every new agent must pair a wallet at signup — no more trailing setup, no more anonymous sponsor leeching**; every paid execute routes through a Cascade split that earns the platform its 10% cut; the facilitator is env-driven and falls back gracefully; sponsor mode is a top-up for paired wallets, not a free tier, and can optionally recoup the cut when caps make sense.
