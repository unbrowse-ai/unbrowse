# User Acceptance Criteria

> Per-subsystem acceptance criteria in Given/When/Then form, reflecting
> standard practice for an API-key + payments product. Each block names the
> implementing module. Test-level detail lives in
> [TEST-SPECS.md](./TEST-SPECS.md).

## 1. Authentication (magic link)
Implementing: `backend/src/routes/auth.ts`, `frontend/src/app/login/page.tsx`

- **AC-AUTH-1** Given a valid email, when the user requests sign-in, then a
  single-use link is emailed and the API responds without disclosing
  whether the account already existed.
- **AC-AUTH-2** Given a magic-link token, when it is verified within its
  30-minute TTL, then the account is created/located and an API key is
  returned exactly once.
- **AC-AUTH-3** Given a token that is expired, already used, or malformed,
  when verification is attempted, then the request fails with a 4xx and no
  key is minted.
- **AC-AUTH-4** Given a malformed email address, when sign-in is requested,
  then the request is rejected before any email is sent.
- **AC-AUTH-5** Given two concurrent verifications of the same token, when
  both race, then at most one succeeds (no duplicate accounts or keys).
- **AC-AUTH-6** Given a user whose accepted ToS version is older than the
  current one, when they call an authenticated endpoint, then they receive
  403 with a pointer to re-accept.

## 2. API keys
Implementing: `backend/src/services/keys.ts`, `backend/src/middleware/auth.ts`

- **AC-KEY-1** Given an authenticated user, when they create a key, then the
  plaintext (`ubr_…`) is returned exactly once and only a SHA-256 hash is
  persisted.
- **AC-KEY-2** Given a presented key, when it is verified, then lookup uses
  the hash with timing-safe comparison; invalid, unknown, or revoked keys
  yield 401.
- **AC-KEY-3** Given a key owner, when they revoke a key, then subsequent
  requests with that key fail with 401 and revocation is idempotent.
- **AC-KEY-4** Given the operator sets the global kill switch
  (`ALL_KEYS_REVOKED`), when any key is presented, then the API returns 401
  with rotation guidance.
- **AC-KEY-5** Given an authenticated user, when they list keys, then only
  their own keys appear, and never any plaintext or hash material.

## 3. API key ↔ wallet funding ("key wraps the wallet")
Implementing: `backend/src/routes/account.ts`, `backend/src/services/splits.ts`

- **AC-FUND-1** Given a key owner, when they bind funding of kind `wallet`
  with a valid address, then the binding is stored and visible on read-back.
- **AC-FUND-2** Given a key owner, when they bind funding of kind `credit`
  with a budget, then paid calls debit that budget instead of requiring a
  wallet signature, and exhausting the budget stops admission.
- **AC-FUND-3** Given a contributor who published skills before attaching a
  wallet, when they later bind a wallet, then future settlements pay them
  for those existing skills (retroactive attribution).
- **AC-FUND-4** Given a sign-in that carries a wallet address, when the
  agent is registered, then the default key is auto-bound to that wallet
  without a separate call.
- **AC-FUND-5** Given a funding write, when the caller does not own the key,
  then the request is rejected (no cross-tenant binding).

## 4. Stripe subscriptions
Implementing: `backend/src/services/stripe.ts`, `backend/src/routes/billing.ts`

- **AC-STR-1** Given an authenticated user, when they start checkout, then a
  Stripe checkout session is created against their (created-or-reused)
  customer and the session URL is returned.
- **AC-STR-2** Given a completed checkout or subscription change, when the
  allow-listed webhook arrives, then the cached subscription state
  (status, period, price, payment method) is updated; non-allow-listed
  events are ignored.
- **AC-STR-3** Given Stripe is unconfigured or the subscription is not
  active/trialing, when admission is checked, then it **fails closed**
  (no silent free access).
- **AC-STR-4** Given an active subscription, when usage is metered, then the
  monthly counter increases monotonically and tier/quota are derived from
  the price; exceeding quota triggers the overage path (auto-refill or
  upgrade prompt), never unmetered service.
- **AC-STR-5** Given a user with an active crypto subscription, when they
  attempt Stripe checkout (or vice versa), then the conflict is rejected.
- **AC-STR-6** Given an authenticated subscriber, when they open the billing
  portal, then they can manage payment method and cancellation via Stripe's
  hosted portal.

## 5. Crypto (USDC) subscriptions
Implementing: `backend/src/services/crypto-sub.ts`

- **AC-CSUB-1** Given an authenticated user, when they request a plan
  intent, then a priced intent is created with a 10-minute expiry.
- **AC-CSUB-2** Given a paid x402 settlement for an intent, when activation
  is called, then a subscription record equivalent to the Stripe-cache
  shape is written and admission works identically to the card rail.
- **AC-CSUB-3** Given an expired or already-activated intent, when
  activation is attempted, then it fails (or is idempotent on the same
  user+plan) without double-charging or double-activating.

## 6. Per-request x402 payments
Implementing: `backend/src/middleware/x402-gate.ts`,
`src/payments/x402-fetch.ts`, `src/payments/flex-pay.ts`,
`backend/src/services/flex.ts`

- **AC-X402-1** Given a paid route and no credentials/credit, when it is
  called, then the response is HTTP 402 with machine-readable payment terms
  (scheme, network, asset, amount, recipient, split metadata).
- **AC-X402-2** Given a configured wallet, when the client receives a 402
  within the cost ceiling, then it signs, retries once with the payment
  proof, and surfaces success only on a 2xx.
- **AC-X402-3** Given the quoted amount exceeds the user's ceiling
  (`UNBROWSE_X402_MAX_COST_USD`), when payment is considered, then the
  client refuses and reports `x402_cost_exceeded` (no silent overspend).
- **AC-X402-4** Given no wallet adapter resolves, when a 402 is received,
  then the outcome is an honest `x402_no_wallet` failure — never a
  fabricated success.
- **AC-X402-5** Given the server rejects a signed retry with another 402,
  when the client evaluates the response, then it stops (no retry loops)
  and reports `x402_retry_blocked`.
- **AC-X402-6** Given a valid bearer key with active subscription credit,
  when a paid route is called, then the credit lane admits the call and no
  on-chain payment is required.
- **AC-X402-7** Given settlement splits are computed, when they are
  serialized into payment terms, then role shares sum to exactly 100% (no
  value created or destroyed), the platform share defaults to the
  configured bps, and markup stays within the clamp (500–8000 bps).
- **AC-X402-8** Given splits frozen in the 402 terms, when the client pays,
  then it pays those terms verbatim (it never recomputes splits locally).

## 7. Sponsored free tier
Implementing: `backend/src/middleware/sponsor.ts`,
`backend/src/services/sponsor-pool.ts`, `backend/src/services/settlement.ts`

- **AC-SPON-1** Given a new agent without payment setup, when they execute a
  paid route, then the platform sponsors it up to the per-agent daily cap.
- **AC-SPON-2** Given the per-agent or global daily cap is exhausted, when a
  sponsored call is attempted, then sponsorship is declined with the
  specific reason and the caller falls through to a payment path.
- **AC-SPON-3** Given free mode is enabled, when a single agent exceeds the
  normal per-agent cap, then they may continue up to the global cap (the
  global bound always holds).
- **AC-SPON-4** Given Stripe revenue events, when the configured carve-off
  runs, then the sponsor pool grows by the configured fraction exactly once
  per event (idempotent on event id).
- **AC-SPON-5** Given unsettled sponsor ledger rows, when settlement runs,
  then payouts batch by recipient, opted-out domains' owner lanes are
  zeroed, and settlement never blocks a user-facing response.

## 8. Wallets & OWS
Implementing: `src/payments/ows.ts`, `src/cli-wallet.ts`,
`src/cli-payment-setup.ts`, `src/payments/lobster-pay.ts`

- **AC-WAL-1** Given multiple wallet sources exist, when the client resolves
  a wallet, then precedence is OWS vault → lobster env/file → generic
  agent-wallet env → Privy → none, and the chosen provider is reported.
- **AC-WAL-2** Given an OWS vault wallet with a policy (allowed chains,
  expiry), when a payment violates the policy, then a deny rule blocks it
  and a warn rule allows it while logging the reason.
- **AC-WAL-3** Given `unbrowse wallet`, when local and server-side wallet
  bindings differ, then the command surfaces the mismatch and the fix
  command, without mutating anything.
- **AC-WAL-4** Given the payment-provider chooser, when the user picks a
  provider (or skip), then the choice persists locally, syncs to the
  backend, and is not re-prompted in non-interactive environments.
- **AC-WAL-5** Given lobster.cash is selected but its CLI/agents file is
  absent, when a payment is attempted, then the client falls back (or fails
  honestly) instead of hanging.

## 9. Marketplace: publish, verify, claim
Implementing: `backend/src/routes/skills.ts`,
`backend/src/services/marketplace.ts`,
`backend/src/services/domain-verifier.ts`,
`backend/src/services/domain-claim.ts`

- **AC-MKT-1** Given a valid manifest, when a skill is published, then it is
  validated, sanitized for residual secrets, indexed for search, and listed;
  list caches are invalidated.
- **AC-MKT-2** Given a manifest containing credential material, when
  publishing, then sanitization strips or blocks it (publishing secrets is
  impossible by construction).
- **AC-MKT-3** Given a skill update, when PATCHed, then a new version is
  produced (no silent in-place mutation).
- **AC-MKT-4** Given a domain-verification challenge, when the probe runs,
  then it only accepts the exact token at the `.well-known` URL over HTTPS,
  within timeout/size caps, with redirects refused and private-network
  targets blocked (SSRF-safe).
- **AC-MKT-5** Given a DNS-TXT claim challenge, when verification runs, then
  the record must match on two independent DNS-over-HTTPS providers before
  the domain↔wallet binding is written.
- **AC-MKT-6** Given a verified domain owner runs the takedown flow, then
  the domain is marked opted-out, its skills are disabled per policy, and
  future settlements zero the owner lane.
- **AC-MKT-7** Given challenge minting, when a domain exceeds the rate limit
  (10/hour), then further challenges are refused.

## 10. Earnings & discovery attribution
Implementing: `backend/src/services/flex.ts`, `backend/src/services/splits.ts`,
the discovery toll ledger/emit pair in `src/` (files matching
`*-toll-ledger.ts` / `*-toll-emit.ts`)

- **AC-EARN-1** Given a paid execution of a published skill, when settlement
  occurs, then contributors with wallets receive their delta-weighted
  shares; contributors without wallets are skipped gracefully.
- **AC-EARN-2** Given a route's first capture, when a later agent pays to
  use it, then the first discoverer's reward lane is honored; when the
  payer is the discoverer, no shortcut fee is owed to anyone else.
- **AC-EARN-3** Given metering or emission fails, when a request is in
  flight, then the user-facing request still succeeds (accounting is
  side-channel, fire-and-forget) and the failure is reported in the result
  shape, not by exception.
- **AC-EARN-4** Given a user's dashboard, when they view earnings, then
  spend/earn figures derive from the settled ledger (not projections),
  with projections labeled as such.

## 11. CLI / MCP core loop
Implementing: `src/cli.ts`, `src/mcp.ts`, `src/capture/`, `src/execution/`

- **AC-CLI-1** Given a fresh machine, when `unbrowse setup` completes, then
  the user has a registered identity, a stored API key in
  `~/.unbrowse/config.json`, a chosen contribution mode, and an optional
  wallet — with non-interactive environments defaulting safely.
- **AC-CLI-2** Given an intent and URL, when `resolve` is called, then a
  ranked endpoint shortlist returns; when `execute` is called, then the
  chosen route replays and returns real data or an honest error.
- **AC-CLI-3** Given a site changes shape, when replay drifts, then
  recovery/escalation paths engage and a hard failure is reported truthfully
  rather than returning stale or fabricated data.
- **AC-CLI-4** Given `auth-capture`, when the user logs into a site, then
  credentials are stored as vault pointers/cookies locally — never published
  in any skill artifact.
- **AC-CLI-5** Given an MCP host, when it lists tools, then all advertised
  tools respond to JSON-RPC calls over stdio across supported protocol
  versions; tool failures return structured errors, not crashes.
- **AC-CLI-6** Given the same engine is reached via CLI or MCP, when the
  same operation runs, then behavior and side effects are identical
  (single in-process app).

## 12. Frontend (product UI)
Implementing: `frontend/src/`

- **AC-FE-1** Given a visitor, when they browse the registry and skill
  pages, then content loads without auth and search works.
- **AC-FE-2** Given a user signs in via magic link, when the token is
  consumed, then the session (API key + identity) persists across reloads
  and signs all subsequent API calls; sign-out clears it.
- **AC-FE-3** Given an authed user, when they open `/dashboard`, then their
  stats, history, and preferences load; preference toggles persist via the
  backend.
- **AC-FE-4** Given an authed user, when they open `/billing`, then their
  sponsored allowance (remaining/cap/used) displays accurately.
- **AC-FE-5** Given an authed user, when they pair a wallet on
  `/account/wallet`, then the address is validated and bound server-side;
  no private key material ever enters the page.
- **AC-FE-6** Given any page, when rendered, then no secret (API key
  excepted as user-owned, server secrets never) is embedded in HTML or
  client bundles.
