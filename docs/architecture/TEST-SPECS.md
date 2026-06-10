# Unit Test Specifications

> **At a glance** — the test coverage map: per subsystem, what standard
> practice requires vs what the ~190 existing backend tests (plus CLI/core
> suites) already cover. Backend billing/marketplace coverage is strong;
> the biggest holes are Stripe webhook signature verification, client-side
> x402 outcome states, wallet-resolution units, and the frontend (zero unit
> coverage). The priority-ordered gap list is at the bottom.

> §N here maps to §N in [ACCEPTANCE-CRITERIA.md](./ACCEPTANCE-CRITERIA.md).
> **Exists** = present today; **GAP** = expected by standard practice but
> not found.

## 1. Auth (AC-AUTH-*)
| Spec | Status |
|---|---|
| Magic-link start → verify mints key; account upserted once | **Exists** — `backend/tests/auth-routes-magic-flow.test.ts` |
| Email shape validation rejects malformed addresses | **Exists** — `backend/tests/auth-*` email-validation suite |
| Expired/reused/forged token rejected (adversarial cases) | **Exists** — `backend/tests/auth-*` token-adversarial suite |
| Concurrent verification of one token → single success | **Exists** — `backend/tests/auth-*` concurrency suite |
| ToS version gate returns 403 with re-accept pointer | **Exists** — `backend/tests/auth-tos-gate.test.ts` (stale version 403, fresh auto-accept, no-ToS bypass for accept-tos) |
| Sign-in response does not reveal account existence (enumeration) | **Exists** — `backend/tests/auth-tos-gate.test.ts` (identical response shape for any email; malformed → 400 with no send) |

## 2. API keys (AC-KEY-*)
| Spec | Status |
|---|---|
| Create returns plaintext once; KV stores hash + reverse index | **Exists** — `backend/tests/keys-service.test.ts` (plaintext-absence scan over all stored entries) |
| Verify: valid / unknown / revoked / malformed → correct result | **Exists** — `backend/tests/keys-service.test.ts` |
| Revoke is idempotent and flips both KV records | **Exists** — `backend/tests/keys-service.test.ts` (also: funding binding cleared on revoke; credit debit lanes) |
| Timing-safe comparison used on verification path | **GAP** (assert code path, not timing itself) |
| List shows only caller's keys, no hash/plaintext leakage | **Exists** — `backend/tests/account-*` key-visibility suite |
| Global kill switch rejects all keys with 401 + pointer | **Exists** — `backend/tests/keys-service.test.ts` (valid key, legacy admin key, missing header) |

## 3. Key funding / wallet wrapping (AC-FUND-*)
| Spec | Status |
|---|---|
| Bind `wallet` funding; read-back roundtrip | **Exists** — `backend/tests/key-funding-routes.test.ts` (wallet + credit, input validation) |
| Bind `credit` funding; debit on paid call; exhaustion stops admission | **Exists** — admission suite (`billing-admission-creatures.test.ts`) |
| Retroactive contributor wallet fill at settlement | **Exists** — `backend/tests/claim-earnings.test.ts` + `splits` suite |
| Auto-bind wallet on registration carrying an address | **Exists** — `backend/tests/key-funding-routes.test.ts` (wallet claim funds the key without a separate call) |
| Cross-tenant funding write rejected | **Exists** — `backend/tests/key-funding-routes.test.ts` (B on A's key → 404 read and write; A's funding untouched) |

## 4. Stripe (AC-STR-*)
| Spec | Status |
|---|---|
| Unconfigured Stripe fails closed (no silent admission) | **Exists** — `backend/tests/billing-stripe-f1-anon-x402-sentinel.test.ts` |
| KV key-convention isolation (single writer) | **Exists** — `backend/tests/billing-stripe-f2-single-writer.test.ts` |
| Webhook → subscription cache roundtrip | **Exists** — `backend/tests/billing-stripe-roundtrip.test.ts` |
| Non-allow-listed webhook events ignored | **Exists** — `backend/tests/billing-webhook-signature.test.ts` |
| Webhook signature verification rejects bad signatures | **Exists** — `backend/tests/billing-webhook-signature.test.ts` (real HMAC: tampered body, wrong secret, stale timestamp, unconfigured secret) |
| Tier detection from priceId + usage | **Exists** — `backend/tests/stripe-tier-detection.test.ts` |
| Metering increments on execute (per-call billing contract) | **Exists** — `backend/tests/meter-on-execute.test.ts` |
| Overage → auto-refill path | partial — `backend/tests/stripe-grants-wave3.test.ts`; add explicit overage unit |
| Checkout/portal session creation (customer reuse) | **Exists** — `backend/tests/billing-stripe-skeleton.test.ts` |
| Stripe↔crypto double-subscription conflict rejected | **Exists** — `backend/tests/crypto-sub.test.ts` |
| End-to-end billing admission | **Exists** — `backend/tests/billing-e2e-dominion.test.ts` |

## 5. Crypto subscription (AC-CSUB-*)
| Spec | Status |
|---|---|
| Intent mint with TTL; expiry refuses activation | **Exists** — `backend/tests/crypto-sub.test.ts` |
| Activation writes Stripe-shaped cache; admission rail-agnostic | **Exists** — `crypto-sub.test.ts` |
| Activation idempotent on (user, plan); no double-activation | **Exists** — `crypto-sub.test.ts` |

## 6. x402 (AC-X402-*)
| Spec | Status |
|---|---|
| Paid route returns 402 with complete terms envelope | **Exists** — `backend/tests/x402-llm-stripe.test.ts`, `x402-llm-flex.test.ts` |
| Splits sum to exactly 10000 bps; rounding absorbed deterministically | **Exists** — `backend/tests/flex-*`/`splits.test.ts` (pure arithmetic) |
| Markup clamped to [500, 8000] bps | **Exists** — flex suite |
| Payment-term selection per manifest (direct/subscription/flex/auction/sponsored) | **Exists** — `backend/tests/flex-*` payment-terms suite |
| Subscription-credit lane bypasses 402 for valid bearer | **Exists** — `x402-llm-stripe.test.ts` |
| Settlement dry-run assembles correct authorization | **Exists** — `x402-llm-flex.test.ts`, `settlement-*` suite |
| Client: cost ceiling refusal (`x402_cost_exceeded`) | **Exists** — `tests/x402-fetch-outcomes.test.ts` |
| Client: no wallet → honest `x402_no_wallet` | **Exists** — `tests/x402-fetch-outcomes.test.ts` |
| Client: second 402 after signed retry → stop, `x402_retry_blocked` | **Exists** — `tests/x402-fetch-outcomes.test.ts` (also covers signed happy path, unparseable envelope, signer error, wallet-config precedence) |
| Client: pays frozen splits verbatim (never recomputes) | **Exists (deliberately red)** — `tests/flex-settlement.test.ts` behavioral pin; cannot go green until escrow/session-key provisioning wires `getFlexWallet()` (currently a documented dormant null). The suite also pins the facilitator URL structurally and freezes `backend/src/services/flex.ts` against unreviewed drift |

## 7. Sponsor tier (AC-SPON-*)
| Spec | Status |
|---|---|
| Decision logic: sponsored / agent-cap / global-cap / opt-out | **Exists** — `backend/tests/sponsor-middleware.test.ts` |
| Stripe-gated sponsorship (disabled / no sub / active / opt-out) | **Exists** — `backend/tests/sponsor-stripe-integration.test.ts` |
| Free mode lifts per-agent cap to global cap only | **Exists** — `backend/tests/sponsor-free-mode.test.ts` |
| Pool carve-off idempotent per revenue event | **Exists** — `backend/tests/sponsor-pool-flywheel-closure.test.ts` |
| Sponsor-on-escrow settlement (platform escrow + session key) | **Exists** — `backend/tests/sponsor-flex.test.ts` |
| Settlement batching; opted-out domain owner lane zeroed | **Exists** — `backend/tests/settlement-*` suite |
| Settlement never blocks response (deferred execution) | **GAP** — assert `waitUntil` usage |

## 8. Wallets & OWS (AC-WAL-*)
| Spec | Status |
|---|---|
| Resolution precedence (OWS → lobster → generic → Privy → none) | **Exists** — `tests/wallet-context-matrix.test.ts` (full matrix incl. disable-flag lanes, both agents.json shapes, corrupt-file tolerance) + adapter-level lanes in `tests/x402-fetch-outcomes.test.ts` |
| OWS policy engine: deny blocks, warn allows+logs, expiry honored | **Exists** — `tests/ows-vault-policy.test.ts` (AND-combined rules, expiry, empty set) |
| OWS vault parsing (CAIP-10 accounts, first-EVM pick, env override) | **Exists** — `tests/ows-vault-policy.test.ts` (both camelCase and snake_case shapes, corrupt-blob skip, hermetic OWS_HOME) |
| `unbrowse wallet` mismatch detection is read-only | **GAP** |
| Provider choice persists + syncs; non-interactive skip | **GAP** — partial coverage via CLI e2e (`tests/cli-e2e.test.ts`) |
| lobster CLI absent → graceful fallback (no hang) | **GAP** |

## 9. Marketplace (AC-MKT-*)
| Spec | Status |
|---|---|
| Manifest validation (schema, lifecycle, required fields) | **Exists** — `backend/tests/skills-*` publish suite |
| Secret-leak sanitization blocks credential material | **Exists** — `backend/tests/publish-error-map.test.ts` + marketplace suite |
| Update produces version bump, not in-place mutation | **Exists** — skills update suite |
| List caching + invalidation on publish/patch | **Exists** — skills card/popular suites |
| Domain verify: exact token, HTTPS-only, timeout/size caps, no redirects, SSRF private-IP bans | **Exists** — `backend/tests/domain-verifier.test.ts` |
| Domain verification default-off gate honored | **Exists** — `backend/tests/marketplace-domain-verify-default.test.ts` |
| DNS-TXT claim: dual-DoH agreement required | **Exists** — `backend/tests/claim-verify-e2e.test.ts`, `domain-claim-helpers.test.ts` |
| Claim challenge rate limit (10/hr/domain) | **Exists** — claim skeleton suite |
| Takedown: opt-out recorded, skills disabled, owner lane zeroed | **Exists** — `domain-claim-helpers.test.ts` + `settlement-*` |

## 10. Earnings & attribution (AC-EARN-*)
| Spec | Status |
|---|---|
| Contributor payout selection (delta-weighted, wallet-less skipped) | **Exists** — `backend/tests/splits`/flex suites |
| First-discoverer binding immutable; self-discovery owes nothing | **Exists** — toll-ledger suite in `tests/` (`*-toll-ledger.test.ts`: first-writer-wins, self-discovery cut returns to payer) |
| Meter conservation: lanes sum exactly to charge | **Exists** — toll-ledger suite ("sums EXACTLY to amount — no value leaks") |
| Emission never throws into request path; failures in result shape | **Exists** — toll-emit suite in `tests/` (`*-toll-emit.test.ts`: negative amount and over-10000-bps guards absorbed, never thrown) |
| Earnings dashboard derives from settled ledger | **Exists** — `backend/tests/claim-earnings.test.ts`, analytics suites |

## 11. CLI / MCP (AC-CLI-*)
| Spec | Status |
|---|---|
| CLI end-to-end (setup → resolve → execute) | **Exists** — `tests/cli-e2e.test.ts` |
| Regression suite for shipped issues | **Exists** — `tests/github-issue-regressions.test.ts` |
| Path-parameter handling | **Exists** — `tests/path-params.test.ts` |
| Quality gate on resolve/execute outcomes | **Exists** — `evals/quality-gate.test.ts` |
| MCP: tools/list + each tool returns structured result/error over stdio | **Exists** — `tests/mcp-protocol-harness.test.ts` (real spawned server: handshake, tool surface + schemas, health call, unknown-method resilience) |
| CLI/MCP parity (same op, same engine, same effect) | **GAP** |
| Config/profile isolation (`UNBROWSE_PROFILE`) | **GAP** |
| auth-capture stores pointers only; no plaintext secrets in artifacts | partial — `src/capture/obfuscate-audit.ts` exists; add dedicated leak test |

## 12. Frontend (AC-FE-*)
| Spec | Status |
|---|---|
| Auth context: login/persist/sign-out lifecycle (localStorage) | **GAP** — component/unit tests not present |
| Magic-link page: request → poll → consume happy/sad paths | **GAP** |
| Dashboard data fetch + preference toggle persistence | **GAP** |
| Billing page renders sponsor status states (sponsored/exhausted/opted-out) | **GAP** |
| Wallet pairing validates address; no key material in page | **GAP** |
| Registry/search/skill pages render from API fixtures | **GAP** |
| Pure lib units (API-origin precedence, domain humanizer, MCP snippet) | **Exists** — `frontend/src/lib/api-helpers.test.ts` (first unit coverage in `frontend/`) |
| Landing funnel e2e | **Exists** — `tests/landing-funnel-e2e.test.ts` |

## Priority of gaps (standard-practice risk order)
1. ~~Stripe webhook signature verification~~ — closed by
   `backend/tests/billing-webhook-signature.test.ts`.
2. ~~Client frozen-splits unit~~ — already pinned by
   `tests/flex-settlement.test.ts` (an evidence-lane falsifier that stays
   red until wallet provisioning lands); the other client x402 outcome
   states are covered by `tests/x402-fetch-outcomes.test.ts`.
3. ~~Key verification/revocation direct units + kill switch~~ — closed by
   `backend/tests/keys-service.test.ts`.
4. ~~Wallet resolution units~~ — closed: OWS policy/vault, adapter-level
   precedence, and the full `getWalletContext()` matrix
   (`tests/wallet-context-matrix.test.ts`).
5. ~~Toll ledger conservation/immutability units~~ — already covered by
   the toll-ledger and toll-emit suites in `tests/` (9/9 green; the
   original GAP rows were a survey error).
6. ~~MCP protocol harness~~ — closed by `tests/mcp-protocol-harness.test.ts`.
7. **Frontend auth/billing component tests** (§12) — lib-level units now
   exist (`frontend/src/lib/api-helpers.test.ts`); component/page tests
   (auth context, billing states, wallet pairing) still need a DOM test
   stack and remain open.
