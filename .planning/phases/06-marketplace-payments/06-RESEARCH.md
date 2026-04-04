# Phase 6: Marketplace Payments — Research

## Codebase Audit

### What Already Exists

| Component | File | Status | Notes |
|-----------|------|--------|-------|
| Wallet precheck | `src/payments/wallet.ts` | Exists, thin | Only checks env vars (`LOBSTER_WALLET_ADDRESS`, `AGENT_WALLET_ADDRESS`). No balance management. |
| Payment gate | `src/payments/index.ts` | Exists, complete but unwired | `checkPaymentRequirement()`, `interpretPaymentResult()`, `resolveUnpaidAccess()`. x402/USDC/Corbits. **Not imported anywhere.** |
| Dynamic pricing | `backend/src/services/pricing.ts` | Exists, wired | `computeRoutePrice()` with demand/reliability multipliers. Exposed at `GET /v1/skills/:id/price`. |
| x402 gate | `backend/src/middleware/x402-gate.ts` | Exists, wired | HTTP 402 flow for `GET /v1/skills/:id`. Corbits facilitator verification with graceful degradation. |
| Fee ledger | `backend/src/services/fees.ts` | Exists, wired | Per-agent graph operation fees in micro-cents. Routes at `/v1/fees/*`. |
| Attribution | `backend/src/services/attribution.ts` | Exists, NOT wired to routes | Tier 1 delta-based indexer credit system. Has `recordAttribution()`, `getIndexerLedger()`, `getAttributionSummary()`. No API routes expose it. |
| SkillManifest pricing fields | `backend/src/types.ts` | Partial | Backend has `base_price_usd` and `owner_compensation_opt_in`. Client-side `src/types/skill.ts` does NOT have these fields. |

### What Does NOT Exist

1. **Payment wiring in execution path** — `executeSkill()` and `resolveAndExecute()` have zero references to `src/payments/*`. Payment checks are dead code.
2. **Transaction recording** — No record of payment events (who paid what, when, for which skill). Attribution tracks indexer credits but not consumer payments.
3. **Wallet balance management** — Current wallet.ts only checks if a wallet env var is set. No balance queries, no deposit/withdraw.
4. **Price in resolve response** — When an agent resolves a skill, the response doesn't include pricing info. Agent can't know cost before execution.
5. **Creator credit API** — Attribution service computes credits but has no routes. Creators can't see their earnings.
6. **Consumer transaction history** — No endpoint for agents to view their payment history.
7. **Skill price-setting by owner** — Backend supports `base_price_usd` on SkillManifest, but there's no API to set/update it and the client-side type doesn't include it.

### Payment Model Decision

The codebase already commits to **per-execution pricing** via x402 (HTTP 402 Payment Required):
- Price computed dynamically per skill based on demand + reliability
- Payment via USDC on Base chain through Corbits facilitator
- Graceful degradation when facilitator is down
- Free tier for local skills and `UNBROWSE_FREE_TIER=1`

This is the right model. No need for subscriptions or credits — per-execution aligns with the marketplace's value (you pay for what you use).

### Where Payment Checks Should Live

The payment gate should be in **`resolveAndExecute()`** in the orchestrator, NOT in `executeSkill()`:
- `resolveAndExecute()` is the agent-facing entry point — agents call resolve, not execute directly
- Payment check happens AFTER skill resolution but BEFORE execution
- This matches the existing flow: resolve skill -> check price -> gate on payment -> execute
- `executeSkill()` stays payment-unaware (it's a lower-level function also used for local skills)

### Architecture: What Needs to Happen

**Wave 1 — Types + Payment Gate Wiring**
1. Add pricing fields to client-side `SkillManifest` type (`base_price_usd`, `owner_compensation_opt_in`)
2. Wire `checkPaymentRequirement()` into `resolveAndExecute()` — check after skill found, before execute
3. Add price info to `OrchestratorResult` so agents see cost before/after execution
4. Record payment transaction event on successful paid execution

**Wave 2 — Transaction Ledger + Creator Visibility**
1. Backend: Transaction recording service (who paid, how much, which skill, when)
2. Backend: Wire attribution routes so creators see earnings
3. Backend: Skill price-setting endpoint (PATCH /v1/skills/:id with `base_price_usd`)
4. Backend: Consumer transaction history endpoint
5. Client: Functions to query transaction history and creator earnings
