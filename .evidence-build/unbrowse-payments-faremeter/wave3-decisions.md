# Wave 3 decisions blocking L3 full Stripe three-tier integration

Wave 2 of unbrowse-payments-faremeter shipped the **tier-detection
primitive** (`services/stripe-tier-detection.ts::inferTier`) as a pure
function with 18 no-mock tests. Wave 3 wires it into the live billing
webhook + execute path. Two design questions must be answered before
wave 3 starts.

## D1. User -> agent mapping for the Pro tier grant

The credit ledger (`services/credits.ts::grantCredits`) is keyed by
`agent_id` (one per API key). A Stripe customer maps to `user_id` (one
per email). A single user typically has multiple API keys.

When a Pro subscription event fires for `user_id = U`, which `agent_id`
receives the 200_000 uc grant?

**Options:**

- **D1a. First-key wins.** `listKeysForUser(env, U)[0]` is the grant
  target. Stable, deterministic, but if the user revokes that key the
  grant chain breaks.

- **D1b. Promote to user-level ledger.** Replace `agent_id` with
  `user_id` as the credit balance key (or add a parallel user-level
  ledger). Every keyId-bound agent_id reads its balance via
  `lookupUserIdByKey(env, keyId) -> user_id -> balance(user_id)`. Larger
  refactor; touches `getBalance`, `debitCredits`, `creditBalanceKey`.

- **D1c. Per-key opt-in.** User picks one of their keys in
  `/account` UI as the "billing target"; that keyId receives all
  grants. Adds a UI surface but is the most explicit.

**Recommendation when the call is made:** D1b is the right long-term
shape -- credit balance is a billing concept, billing is per-user, and
the per-key x402 funding binding (already shipped wave 1) is the right
place for per-key scoping. The first-key shim (D1a) buys us velocity if
the refactor is too big.

## D2. Meter API integration point

For tier=metered the wave-3 caller fires
`stripe.billing.meterEvents.create({event_name, payload})` on each
chargeable execute. Two placement choices:

- **D2a. In the existing payment gate.** Right where the `keyFundedAdmit`
  + sponsor lanes live in `routes/skills.ts::GET /skills/:id`. Fires
  immediately on admit-success. Highest fidelity, but every paid skill
  call now has a Stripe HTTP call inline.

- **D2b. Background flush.** Queue the meter event into a KV ring and
  flush in batches via `executionCtx.waitUntil`. Avoids inline Stripe
  latency. Risk: meter events lost on isolate eviction before flush.

**Recommendation:** D2b with a small ring (size 100, flush every
5 seconds) protects p99 latency without losing accuracy in practice.

## D3. Webhook idempotency key shape

Stripe re-delivers webhooks. The grant path must be idempotent. Two
candidate keys for the Pro-tier grant:

- **D3a.** `${event.id}` -- one grant per webhook delivery. Re-deliveries
  of the same event noop. Period rollovers (a new event each period)
  grant correctly.

- **D3b.** `${customer.id}:${current_period_start}` -- one grant per
  customer per billing period. More defensive against duplicate events
  for the same period from different event types
  (`customer.subscription.updated` vs `invoice.paid`).

**Recommendation:** D3b. The Pro grant should fire once per period, not
once per Stripe event; events can be duplicated, periods cannot.

---

Once Lewis decides D1, D2, D3, wave 3 wires:
1. `inferTier` (already shipped) -> `processBillingEvent` (extension)
2. Grant path matching D1 choice
3. Meter API integration matching D2 choice
4. Idempotency key matching D3 choice
5. UI tier picker on `/account` (Pro upgrade CTA + Metered toggle)
6. No-mock integration tests against Stripe sk_test
