# x402 Routing Plan — v6.16 (Flex revision)

**Status:** Draft 2026-05-14 (post-v6.15.0, Cascade dropped, Flex in)
**Owner:** Lewis
**Audience:** anyone touching `backend/src/middleware/x402-gate.ts`, `backend/src/middleware/sponsor.ts`, `backend/src/services/*`, or routes that take payment.

## Why this plan exists

Three honest gaps surfaced in the v6.15.0 Day-6 audit:

1. **Single-contributor skills bypass the 10% platform cut.** Current `payTo` is a single contributor wallet; the platform earns 0% on solo-creator skills.
2. **Sponsor flow never recoups the platform cut.** Platform pays principal + gas, gets 0% back.
3. **Facilitator is hardcoded** to `https://facilitator.corbits.dev`. No fallback, no Flex.

**This revision drops Cascade entirely and adopts Faremeter Flex (`@faremeter/flex`).** Why:

- **Flex carries splits natively in every signed authorization.** A single authorization expresses recipient + bps allocations summing to 10,000 (up to 5 recipients per authorization, atomically distributed at on-chain `finalize`). The 10% platform cut moves into the authorization itself, no separate split provisioning, no separate `execute_split()` trigger, no extra protocol fee, no claim-based "funds stuck in vault" UX problem.
- **Flex matches our actual usage.** Unbrowse is an agentic, high-frequency, variable-cost workflow. `exact` scheme requires the client to know the cost up front; Flex's hold-and-settle pattern (`createUptoHandler`) lets us authorize a ceiling, do the work, then settle the actual amount used. Token-count-priced AI inference, data-transfer-priced execute calls, and metered streaming all fit Flex's `maxAmount → actual settle` shape cleanly.
- **Flex eliminates per-request on-chain latency.** Authorizations are signed off-chain; settlement is batched. Today every paid execute blocks on a Corbits `/settle` round-trip; with Flex the hot path is pure compute and the facilitator flushes to chain in the background.
- **Flex has a built-in deadman switch.** If our facilitator becomes unresponsive, clients can unilaterally recover escrowed funds after a timeout. No custodial risk for users.

## Source-of-truth references

| Source | Key fact that shapes this plan |
|---|---|
| [Flex Overview](https://docs.faremeter.xyz/flex/overview) | Scheme id `@faremeter/flex`. Prepaid escrow + off-chain session-key signing + batched settlement. **Native splits in every authorization.** Solana today, EVM planned. |
| [Flex Concepts](https://docs.faremeter.xyz/flex/concepts) | Each escrow PDA holds a balance for ONE client + ONE facilitator. Splits are `(recipient_token_account, bps)`, must sum to 10,000, max 5 entries. Authorizations carry `escrow / mint / maxAmount / authorizationId / expiresAtSlot / splits` and are Ed25519-signed by a registered session key. `MAX_PENDING_SETTLEMENTS = 16` per escrow. |
| [Flex Facilitator](https://docs.faremeter.xyz/flex/facilitator) | `createFacilitatorHandler` plug-in slots into Faremeter middleware. Implements x402 `verify` + `settle` lifecycle, runs a background flush (`flushIntervalMs`), exposes `flush()` + `getHoldManager()` + `stop()`. `PERMANENT_SUBMIT_ERRORS` (expired auth, invalid sig, etc.) drop the hold; transient errors retry. For variable-amount endpoints: `createUptoHandler` in `@faremeter/payment-solana/flex/hono` takes `authorize` + `handle` callbacks. |
| [coinbase/x402 spec](https://github.com/coinbase/x402) | The wire protocol (HTTP 402 + `X-PAYMENT` / `PAYMENT-SIGNATURE` headers) is scheme-agnostic. Flex authorizations ride in the same headers — only the `scheme` and `extra` fields change. |

The single most important sentence in the Flex docs for our purposes: *"A single authorization can distribute funds across multiple recipients (platform fees, referral commissions, royalties) in one atomic settlement."* This is what kills Cascade for us — splits stop being an external protocol we provision and become a field we sign.

## GOAL (north star)

Every paid execute on Unbrowse rides on Faremeter Flex with the platform's 10% cut written directly into every signed authorization's `splits` array. Every new agent funds an escrow + registers a session key at signup before getting an API key. Sponsor mode is a top-up for paired-wallet agents, signed by a platform session key against an agent-owned escrow.

## ACCEPTANCE CRITERIA (30, ordered by phase)

### Phase 0 — Signup gate: wallet + escrow + session key required, no trailing setup

The most important phase. v6.15 lets agents register with just an email and immediately get an API key; wallet pairing is "encouraged" via `unbrowse setup`'s lobster.cash prompt but skippable. Flex makes the gate richer: agents need not just a wallet but a funded escrow + registered session key before any execute can settle.

- **P0.1** `unbrowse setup` (CLI bootstrap) cannot complete without (a) a paired wallet, (b) a Flex escrow created against the platform facilitator, (c) at least one session key registered. The flow becomes: ToS accept → email → wallet pairing (lobster.cash via `npx @crossmint/lobster-cli setup` OR `--wallet-address <addr>`) → escrow creation via `@faremeter/flex-solana` client → session key registration → API key minted. Skipping any step exits non-zero with an actionable error.
- **P0.2** Backend `POST /v1/agents/register` rejects requests without `wallet_address`, `flex_escrow_address`, and `flex_session_key_address`. 400 with `{ error: "flex_onboarding_incomplete", missing: [...], remediation: "Run unbrowse setup or pair via /account" }`. Even the `__admin__` shortcut moves to a separate admin-only flow.
- **P0.3** Existing v6.15-era agents who registered without Flex onboarding get a soft block: the next request to any priced route returns 402 with a `X-Flex-Onboarding-Required: 1` header and a body explaining the missing steps (wallet, escrow, session key). Free routes (health, search-read-only) keep working.
- **P0.4** `/account` UI gets three sequential CTAs at top: "Pair wallet", "Fund escrow", "Register session key". Each links to a guided flow; status badge shows "complete / pending / not started" per step. Wallet address, escrow PDA, and session key fingerprint all displayed once complete.
- **P0.5** Sponsor pool semantics tighten: sponsor credit is a **top-up**, not a free tier. Eligibility: agent must have wallet + escrow + session key all set AND have made at least one successful execute paid from their own escrow in the last 30 days. New agents get a one-time $0.50 sponsor allowance to bootstrap (pair → fund → register → first paid execute), capped lower than the $1/day daily allowance.
- **P0.6** Tests: `backend/tests/flex-onboarding-gate.test.ts` (6 cases — each missing field rejected with the right `missing` array; complete onboarding accepted; existing-no-flex agent gets 402 with `X-Flex-Onboarding-Required`; admin shortcut admin-only; sponsor allowance reduced for new agents).

### Phase 1 — Replace `exact` with `@faremeter/flex` everywhere

- **P1.1** New package install: `@faremeter/flex-solana` and `@faremeter/payment-solana` in `backend/package.json`. Versions pinned.
- **P1.2** New file `backend/src/services/flex.ts` exports:
  - `buildFlexAuthorization(agent, skill, priceCeilingUsd, env): FlexAuthorizationDraft` — assembles the authorization shape with `escrow = agent.flex_escrow_address`, `mint = USDC_MINT`, `maxAmount`, `authorizationId = randomU64()`, `expiresAtSlot = currentSlot + escrow.refund_timeout_slots`, and `splits` containing the contributor recipients + platform recipient with bps summing to 10,000.
  - `computeFlexSplits(skill, env): FlexSplit[]` — returns up to 5 `(recipient_token_account, bps)` entries. Platform always present at `PLATFORM_BPS = 1000` (10%). Contributors share the remaining 9,000 bps weighted by `cumulative_delta`.
- **P1.3** `buildSkillPaymentTerms` in `backend/src/middleware/x402-gate.ts` switches scheme from `"exact"` to `"@faremeter/flex"`. The `accepts[]` entry's `extra` field carries the Flex-specific `{ escrow, splits, expiresAtSlot, refund_timeout_slots }` payload per Flex spec. Existing `exact` scheme support is removed (no parallel codepath — full migration).
- **P1.4** The local SDK (`packages/sdk/src/x402.ts`) gains a `signFlexAuthorization(req, sessionKeySigner)` helper that produces the `PAYMENT-SIGNATURE` header value matching `@faremeter/flex-solana` payload shape.
- **P1.5** Tests: `backend/tests/flex-splits-single-contributor.test.ts` proves the splits array for a solo skill has TWO entries (contributor 9000 bps + platform 1000 bps, sum 10000). `backend/tests/flex-splits-multi-contributor.test.ts` proves multi-contributor weighted shares.

### Phase 2 — Run a Flex facilitator (or delegate)

- **P2.1** Decision point (Day-1 of execution): **(a)** stand up our own Flex facilitator inside the Cloudflare Worker backend using `createFacilitatorHandler` from `@faremeter/payment-solana/flex/facilitator`, OR **(b)** delegate to a hosted Flex facilitator (Faremeter Cloud, Corbits-when-they-add-Flex, or any third-party). The plan recommends **(a)** for control, observability, and to avoid bleed of agent data through a third-party.
- **P2.2** If (a): new file `backend/src/services/flex-facilitator.ts` instantiates `createFacilitatorHandler("mainnet-beta", rpc, platformSigner, { supportedMints: [USDC_MINT], defaultSplits: [...], flushIntervalMs: 5000, ... })`. Wire the handler's `verify`, `settle`, and `flush` into the backend's `/v1/x402/{verify,settle}` proxy endpoints.
- **P2.3** Background flush worker — Cloudflare Worker durable-object or scheduled trigger runs `flush()` every 30s OR on-demand after each settle. Settled holds become on-chain pending settlements; refund-window-closed pending settlements become finalized (which atomically distributes per the splits in the authorization).
- **P2.4** **No `execute_split` worker needed.** Flex's `finalize` instruction handles distribution natively — this is the headline win over Cascade.
- **P2.5** Tests: `backend/tests/flex-facilitator-lifecycle.test.ts` — end-to-end: agent funds escrow → middleware verifies authorization (hold) → middleware does work → middleware settles actual amount → flush submits → after refund window, finalize distributes USDC to creator + platform.

### Phase 3 — Variable-amount endpoints via `createUptoHandler`

The Flex win that Cascade couldn't touch.

- **P3.1** Refactor `/v1/skills/:id/execute` (and `/v1/execute` priced branch) to use `createUptoHandler` from `@faremeter/payment-solana/flex/hono` (or our backend's adapter if we're on Hono). `authorize` callback computes max amount from request body (e.g. for AI-inference skills: `maxTokens * 10 µ¢/token`); `handle` callback runs the skill, then calls `settle(actualCostUc)` with the real consumption.
- **P3.2** Skill manifests gain a new optional `pricing` field: `{ mode: "fixed", price_usd } | { mode: "metered", unit, cost_per_unit_uc, max_units }`. Existing fixed-price skills migrate automatically (`{ mode: "fixed", price_usd: <existing> }`).
- **P3.3** Metered skills can return both `data` and `usage_units` in their response; the route extracts `usage_units`, computes `actualCostUc = units * cost_per_unit_uc`, calls `settle(actualCostUc)`.
- **P3.4** SDK gains `Unbrowse#executeMetered(skill, input, { onUsage })` so SDK callers can opt into metered pricing — the SDK signs an authorization for the ceiling, sends the request, parses the `usage_units` from the response, and the facilitator settles the actual cost.
- **P3.5** Tests: `backend/tests/flex-metered-execute.test.ts` proves a metered skill that authorizes 100k units but consumes 10k pays for 10k.

### Phase 4 — Sponsor mode on Flex rails

- **P4.1** Platform funds a "sponsor escrow" via the same Flex program but with the platform as both client AND a registered session-key owner. The sponsor session key has scoped expiry (e.g. 7 days) and is rotated.
- **P4.2** When `maybeSponsor` returns `{ kind: "sponsored" }`, the route signs an authorization against the SPONSOR escrow (not the agent's escrow) with the agent's skill's splits — including the platform 10% recipient. Net effect: platform pays principal from sponsor escrow but recoups 10% via the splits back into a platform-owned wallet in the same authorization.
- **P4.3** Sponsor authorization carries an `agent_id` tag in its `extra` field for ledger attribution. Existing `sponsor:ledger:<id>` KV writes continue to capture `agent_id`, `skill_id`, `amount_settled_usdc`, `tx_hash`.
- **P4.4** Caps still enforced in `maybeSponsor` BEFORE signing the sponsor authorization (per-agent $1/day, global $50/day).
- **P4.5** Tests: `backend/tests/sponsor-flex.test.ts` — sponsor settle path uses sponsor escrow, agent's `flex_escrow_address` is untouched, splits route 90% to creator + 10% to platform.

### Phase 5 — Docs, analytics, retire Corbits / direct-pay paths

- **P5.1** Implement `/v1/analytics/payments` (closes v6.15.0 D3 TODO). Returns:
  ```json
  {
    "platform_cut_usd_24h": "12.34",
    "platform_cut_usd_30d": "456.78",
    "sponsor_settled_usd_24h": "0.50",
    "sponsor_recouped_usd_24h": "0.05",
    "creator_payouts_usd_24h": "111.00",
    "flex_escrows_active": 142,
    "flex_pending_settlements": 18,
    "flex_holds_in_memory": 27
  }
  ```
- **P5.2** `docs/x402-flywheel.md` rewritten — drop Cascade entirely, replace with Flex narrative (mermaid diagram updated: escrow funded → session key signs auth → facilitator holds → service delivers → settle actual → flush → finalize distributes per splits).
- **P5.3** `docs/wallets.md` rewritten to document the wallet → escrow → session key sequence.
- **P5.4** `docs/x402-flex-migration.md` (NEW) — explains for builders/integrators the move from `exact` scheme to `@faremeter/flex`, with code samples.
- **P5.5** **Retire Corbits codepath.** `CORBITS_FACILITATOR_URL` const + `verifyAndSettlePaymentHeader` deleted. **Retire `sendSponsorPayment` direct-transfer codepath.** All settlement flows through the Flex facilitator. No parallel rails.
- **P5.6** Retire Cascade dependency: remove `@cascade-fyi/splits-sdk` from `backend/package.json`, delete `backend/src/services/cascade.ts` and `backend/src/services/splits.ts`. The 10% cut lives in `flex.ts::computeFlexSplits`.

## NON-GOALS

- **EVM support.** Flex is Solana-only today; EVM is on Faremeter's roadmap. v6.16 stays Solana-only for paid execute. EVM agents can still use the SDK against free routes.
- **Custom per-skill platform-share ratios.** Platform is always 1000 bps. Custom ratios are a v6.17+ feature.
- **Migrating historical earnings.** Pre-v6.16 settled payments stay where they are.
- **Multi-mint settlement.** USDC only. SOL / SPL-other / Token-2022 may follow.
- **Replacing the canonical x402 wire format.** We still speak x402 over HTTP; only the scheme + `extra` shape change.

## RISKS

- **R1: Flex onboarding adds three steps to signup.** Wallet pairing is already friction; adding escrow funding + session-key registration triples the new-user effort. Mitigation: the `/account` flow + `unbrowse setup` CLI must collapse all three into a single guided wizard. The Flex Quickstart docs at https://docs.faremeter.xyz/flex/quickstart are the reference for what a "good" client-side onboarding looks like.
- **R2: Self-hosted facilitator is operational ownership we don't have today.** Running `createFacilitatorHandler` in a Cloudflare Worker means managing the facilitator key, flush cadence, refund window, deadman activity-keep-alive. Mitigation: if (a) is too much for week-1, fall back to (b) — hosted Faremeter facilitator — and revisit. Decision documented as P2.1.
- **R3: `MAX_PENDING_SETTLEMENTS = 16` per escrow is a real ceiling.** A busy agent could saturate. Mitigation: facilitator flushes aggressively; if a verify call comes in and the escrow is at cap, return 402 with `X-Flex-Escrow-Saturated: 1` and a retry hint.
- **R4: Refund window holds the merchant's money for at least a minute (150 slots min).** Creators see "earnings in 1–6 days" instead of "earnings instantly." Mitigation: pick the minimum refund window (~150 slots ≈ 1 minute) by default — short enough that creators feel paid immediately, long enough for legitimate dispute. Document the trade-off.
- **R5: Cascade dependency removal might break legacy multi-contributor skills with provisioned splits.** Mitigation: P5.6 includes a one-time migration script that emits a final Cascade `execute_split` on any vault with non-zero balance before the dependency is removed.
- **R6: Sponsor escrow is a hot target — if the platform sponsor session key is compromised, attacker drains the sponsor escrow up to global caps.** Mitigation: short session-key expiry (24–48h), automated rotation, hard-cap the sponsor escrow funding to a few days' worth at any time.
- **R7: SDK clients need to handle authorization signing + escrow management.** Net new surface in `@unbrowse/sdk`. Mitigation: ship a high-level `Unbrowse#fundEscrow()` and `Unbrowse#registerSessionKey()` plus a `WalletLike` extension that can sign Ed25519 auth messages.

## OUT-OF-SCOPE (own future loops)

- EVM Flex when Faremeter ships it
- Multi-token (USDT, SOL, Token-2022) settlement
- Per-skill custom platform-share ratios
- Anti-Sybil checks on contributor splits
- Reconciliation UI on `/account` showing per-skill earnings breakdown over time
- Hosted facilitator failover policies (multi-facilitator escrow strategies)

## Files touched

| Path | Change | Phase |
|---|---|---|
| `src/cli-setup.ts`, `src/runtime/setup.ts` | EDIT — wallet + escrow + session-key wizard becomes required `unbrowse setup` steps | P0 |
| `src/runtime/flex-onboarding.ts` (or extend existing) | CREATE — single-call helpers to fund escrow + register session key | P0 |
| `backend/src/routes/agents.ts` (register endpoint) | EDIT — reject if any of wallet/escrow/session-key missing | P0 |
| `backend/src/middleware/flex-onboarding-required.ts` | CREATE — emits 402 `X-Flex-Onboarding-Required: 1` for legacy agents on priced routes | P0 |
| `frontend/src/app/account/page.tsx` + `account/{wallet,escrow,session-key}/page.tsx` | EDIT/CREATE — three guided CTAs + flow pages | P0 |
| `backend/src/middleware/sponsor.ts` | EDIT (P0+P4) — eligibility tightened; signs sponsor authorization against sponsor escrow | P0, P4 |
| `backend/tests/flex-onboarding-gate.test.ts` | CREATE — 6-case matrix | P0 |
| `backend/package.json` | EDIT — add `@faremeter/flex-solana`, `@faremeter/payment-solana`; remove `@cascade-fyi/splits-sdk` | P1, P5 |
| `backend/src/services/flex.ts` | CREATE — `buildFlexAuthorization`, `computeFlexSplits` | P1 |
| `backend/src/middleware/x402-gate.ts` | EDIT — scheme `"exact"` → `"@faremeter/flex"`; `extra` carries Flex payload; delete `CORBITS_FACILITATOR_URL` + `verifyAndSettlePaymentHeader` | P1, P5 |
| `packages/sdk/src/x402.ts` | EDIT — add `signFlexAuthorization`, `WalletLike` extension for Ed25519 session-key signing | P1 |
| `backend/src/services/flex-facilitator.ts` | CREATE — instantiates `createFacilitatorHandler`; wires verify/settle/flush | P2 |
| `backend/src/routes/x402-facilitator.ts` (or extend) | EDIT — `/v1/x402/verify` + `/v1/x402/settle` proxy through Flex handler | P2 |
| Cloudflare Worker scheduled trigger / Durable Object | CREATE — periodic `flush()` driver for the Flex facilitator | P2 |
| `backend/src/routes/skills.ts`, `demos.ts`, `search.ts` | EDIT — switch to `createUptoHandler`-style hold/settle | P3 |
| `backend/src/types.ts` (SkillManifest) | EDIT — add `pricing` discriminated union (`fixed` | `metered`) | P3 |
| `packages/sdk/src/client.ts` | EDIT — add `executeMetered`, `fundEscrow`, `registerSessionKey` | P3, P0 |
| `backend/src/routes/admin.ts` | EDIT — implement `/v1/analytics/payments` | P5 |
| `backend/src/services/cascade.ts`, `backend/src/services/splits.ts`, `backend/src/services/sponsor-pay.ts` | DELETE | P5 |
| `backend/scripts/cascade-final-distribute.ts` | CREATE — one-time migration: `execute_split` on every vault with balance, then deprecate | R5 |
| `backend/wrangler.toml` | EDIT — replace Cascade env vars with `FLEX_PLATFORM_FACILITATOR_KEY` (secret), `FLEX_PLATFORM_RECIPIENT_USDC_ATA`, `FLEX_REFUND_TIMEOUT_SLOTS`, `FLEX_DEADMAN_TIMEOUT_SLOTS` | P2 |
| `backend/.env.example` | EDIT — document Flex env vars | P2 |
| `backend/tests/flex-splits-{single,multi}-contributor.test.ts` | CREATE | P1 |
| `backend/tests/flex-facilitator-lifecycle.test.ts` | CREATE | P2 |
| `backend/tests/flex-metered-execute.test.ts` | CREATE | P3 |
| `backend/tests/sponsor-flex.test.ts` | CREATE | P4 |
| `docs/x402-flywheel.md` | REWRITE — Flex narrative + new mermaid diagram | P5 |
| `docs/wallets.md` | REWRITE — wallet → escrow → session key sequence | P5 |
| `docs/x402-flex-migration.md` | CREATE — exact→flex migration guide for integrators | P5 |
| `docs/x402-routing.md` | RENAME from this draft after v6.16 ships | P5 |

## Rollout

1. **v6.16.0-preview.0 — Phase 0 + Phase 1 ALONE.** Onboarding gate + Flex scheme adoption. Existing agents get one grace cycle via `X-Flex-Onboarding-Required: 1`. New agents must complete wallet+escrow+session-key. **No more trailing setup.**
2. **v6.16.0-preview.1 — Phase 2.** Run the Flex facilitator (decision: self-host vs hosted). Background flush cadence dialed in.
3. **v6.16.0-preview.2 — Phase 3.** Variable-amount endpoints (`createUptoHandler`). Metered pricing manifest field.
4. **v6.16.0-preview.3 — Phase 4.** Sponsor on Flex rails (10% recoup via splits).
5. **v6.16.0-preview.4 — Phase 5.** Analytics endpoint + Cascade/Corbits/sponsor-direct-pay deletion + docs rewrite.
6. **v6.16.0 stable** after preview.4 stabilises.

## North star (one sentence)

Ship v6.16.0: **every new agent funds a Flex escrow and registers a session key at signup — no trailing setup, no anonymous sponsor leeching**; every paid execute rides on `@faremeter/flex` with the platform's 10% cut written natively into every signed authorization's splits; sponsor mode is a top-up for onboarded agents that recoups via the same splits primitive.
