# Backend (Cloudflare Worker API)

> **At a glance** — a Hono app on Cloudflare Workers (Neon Postgres + 7 KV
> namespaces). Auth is email magic link → SHA-256-hashed API keys with a
> ToS gate and global kill switch. Billing admits a request via any of four
> rails — Stripe sub, USDC sub, per-request x402, or platform sponsorship —
> all converging on one subscription-cache shape and one settlement-split
> function. Marketplace publishing sanitizes secrets and verifies domain
> ownership via `.well-known` or dual-provider DNS TXT.

> Source of truth: `backend/` at v8.3.0-preview.2. Public base URL:
> `https://beta-api.unbrowse.ai`.

## 1. Runtime & topology
- **Framework**: Hono on Cloudflare Workers; entry `backend/src/index.ts`,
  routes registered there from `backend/src/routes/` (~48 modules).
- **Environments**: production / staging / experiments / gate-staging
  (`backend/wrangler.toml`).
- **Postgres (Neon)** via `DATABASE_URL`: accounts, telemetry
  (`backend/schema/telemetry-sessions.sql`). Note: only the telemetry DDL is
  checked in; accounts/usage tables are managed by service code.
- **KV namespaces** (`backend/wrangler.toml`):
  - `STATS_KV` — analytics, search index, sponsor ledger, skill manifests
  - `AUDIT_LOG` — pointer-only Ed25519-signed receipts
  - `RESPONSE_CACHE` — response cache (optional binding, graceful miss)
  - `SESSION_STATE` — persisted session pointers (per-wallet prefixes)
  - `TRACE_STATE` — decision traces (TTL 7d)
  - `SETTINGS_STATE` — durable per-wallet preferences
  - `SCREENSHOT_BLOB` — content-addressed PNGs (TTL 30d)
- **Cron**: `17 */6 * * *` — flush queued GitHub notifications + evaluate
  buyback trigger (`backend/src/index.ts`).

## 2. Route map

### Public (no auth)
| Route | Purpose |
|---|---|
| `GET /v1/health` | Health check |
| `GET /v1/skills` | Skill list (card view, edge-cached) |
| `GET /v1/skills/popular` | Trending skills |
| `GET /v1/skills/:id/card` | Trimmed skill card |
| `GET /v1/skills/by-domain/:domain/skill.md` | Rendered skill doc for a domain |
| `GET /v1/skills/:id/endpoints/:eid/schema` | Endpoint response schema |
| `GET /v1/search` | Search (BM25 + semantic) |
| `GET /v1/stats/traction/:domain` · `GET /v1/stats/by-wallet/:wallet` · `GET /v1/stats/validate/:intent` | Public stats |
| `GET /v1/agents/:id` | Public agent profile |
| `GET /v1/claim/status` · `GET /v1/claim/takedown/status` | Domain claim/opt-out status |
| `GET /v1/dashboard/trends` · `GET /v1/miners/demand` · `GET /v1/issues/:id` | Misc public reads |
| `POST /v1/auth/email/start` · `/v1/auth/email/verify/:token` | Magic-link flow (public by nature) |

### Bearer auth (API key — `backend/src/middleware/auth.ts`)
| Route | Purpose |
|---|---|
| `GET/POST /v1/account/keys`, `DELETE /v1/account/keys/:keyId` | API key list / create / revoke |
| `POST /v1/account/keys/:keyId/funding` | Bind key funding: wallet or credit budget (`backend/src/routes/account.ts`) |
| `GET /v1/account/me` · `GET/POST /v1/account/preferences` · `GET /v1/account/sponsor-status` | Account profile, preferences, sponsor balance |
| `POST /v1/skills` · `PATCH /v1/skills/:id` · `PUT /v1/skills/:id/endpoints/:eid/schema` | Publish / update skills |
| `POST /v1/skills/by-domain/:domain/verify/{challenge,probe}` | Domain verification (`.well-known`) |
| `POST /v1/claim/{challenge,verify}` · `POST /v1/claim/takedown/{challenge,verify}` | DNS-TXT domain↔wallet claim and owner opt-out |
| `GET /v1/billing/me` · `POST /v1/billing/checkout` · `POST /v1/billing/portal` | Stripe state / checkout / portal |
| `POST /v1/billing/crypto-sub/intent` · `POST /v1/billing/crypto-sub/activate/:intentId` | USDC subscription (activation x402-gated) |
| `GET /v1/dashboard/me` | Spend/earn dashboard data |
| `POST /v1/stats` | Record custom stats |

### x402 payment-gated
| Route | Purpose |
|---|---|
| `POST /v1/skills/:id/execute` | Execute a published skill (per-manifest payment terms) |
| `POST /v1/search` | Paid semantic search lane |
| `POST /v1/llm/:provider/messages` | Universal LLM proxy with markup, upstream xgate.run (`backend/src/routes/llm.ts`, `backend/src/services/xgate.ts`) |

### Admin / internal
| Route | Purpose |
|---|---|
| `GET /v1/admin/sponsor-ledger` (ADMIN_KEY) | Read sponsor ledger |
| `POST /v1/ops/reindex` | Force reindex |

### State & audit surface (v7)
A unified state-append route (audit/session/trace/settings writes share one
entry point), `GET /v1/audit/verify/:key`,
`POST /v1/session/park`, `GET /v1/session/restore/:id`,
`POST /v1/trace/append`, `GET /v1/trace/by-receipt/:cacheKey`,
`GET /v1/trace/by-wallet`, `POST /v1/settings/set`,
`GET /v1/settings/get/:keyHash`, `POST /v1/screenshot/store`,
`GET /v1/screenshot/by-sigkey/:sigKey`.

## 3. Auth & API keys
- **Magic link**: `POST /v1/auth/email/start` validates the address and
  sends a one-time link (Resend); `verify/:token` (30-min TTL) upserts the
  user in Postgres and mints an API key (`backend/src/routes/auth.ts`).
- **Key format**: `ubr_` + 48 hex chars; `keyId` = first 32 chars of the hex
  body (`backend/src/services/keys.ts`).
- **Storage**: only SHA-256 hashes — KV `keyhash:<sha256>` →
  `{keyId, name, created_at, revoked_at}` plus reverse index
  `keyid:<keyId>`. Plaintext is shown once at creation and never stored.
- **Verification**: hash the presented key, KV lookup, timing-safe compare
  (`backend/src/middleware/auth.ts`); revocation flips `revoked_at` on both
  records idempotently.
- **Gates**: ToS version check (403 on stale acceptance); global kill switch
  `ALL_KEYS_REVOKED` (401 + rotation pointer); staging accepts any bearer
  for dev convenience — production always verifies.
- **Key funding binding**: `keyfund:<keyId>` ties a key to a wallet or a
  prepaid credit budget — this is the "API key wraps the wallet" mechanism
  (`backend/src/routes/account.ts`). Agent registration auto-binds a wallet
  delivered at sign-in (`backend/src/routes/agents.ts`).

## 4. Billing & payments

### Stripe (card rail) — `backend/src/services/stripe.ts`, `backend/src/routes/billing.ts`
- Customer per user (`getOrCreateCustomer`), cached: KV `stripe:user:<userId>`
  → customerId (1y TTL); `stripe:customer:<customerId>` → subscription cache
  JSON `{status, current_period_*, priceId, productId, brand, last4,
  paymentMethod}` (90d TTL).
- Webhooks: 19 allow-listed event types (checkout, subscription, invoice,
  payment-intent) → `processBillingEvent`.
- Usage metering: monotonic KV counter `billing:usage:<userId>:<YYYY-MM>`;
  tier inferred from priceId (Base / Pro / Enterprise); auto-refill charge
  on overage; `subscriptionAdmits()` **fails closed** when Stripe is
  unconfigured or the sub is inactive.

### Crypto subscription (USDC rail) — `backend/src/services/crypto-sub.ts`
- Plans: base ($19, 200k quota) and pro ($59, 1M quota), env-tunable.
- Flow: mint a 10-minute intent (`/crypto-sub/intent`) → pay via x402 →
  `activate/:intentId` writes the same subscription-cache shape Stripe uses
  (customerId `crypto-<userId>`), so downstream admission code is
  rail-agnostic. Stripe↔crypto double-subscription is rejected
  (`assertNoStripeConflict`).

### Per-request x402 (pay-as-you-go rail)
- Gate: `backend/src/middleware/x402-gate.ts` returns HTTP 402 with payment
  terms: scheme (`exact` or session-key escrow), network (Solana mainnet /
  Base / devnets), asset (USDC mint/contract), amount, recipient, and
  frozen split metadata.
- Settlement splits (`backend/src/services/flex.ts`): five roles summing to
  exactly 10000 bps — infrastructure (platform, default 50%
  `PLATFORM_BPS`/`FLEX_PLATFORM_BPS`), site_owner (only when the domain
  owner opted in with a verified wallet), contributors (delta-weighted, up
  to 5), maintainer and treasury (env-gated, default 0). Markup clamped to
  500–8000 bps.
- Contributor wallet back-fill from key-funding bindings
  (`backend/src/services/splits.ts`): publish first, attach a wallet later,
  earn retroactively.
- Payment-term selection per skill manifest: `direct`, `subscription`,
  `flex`, `auction`, `sponsored`.

### Sponsored tier (platform-funded) — `backend/src/middleware/sponsor.ts`
- `maybeSponsor()` → `sponsored` (with ledger id) / `exhausted`
  (agent_cap | global_cap | no_wallet) / `opted_out`.
- Caps in micro-cents: per-agent `SPONSOR_CAP_DAILY_USD` (default $1/day),
  global `SPONSOR_GLOBAL_DAILY_USD` (default $50/day); `SPONSOR_FREE_MODE`
  lifts the per-agent cap to the global cap.
- KV: `sponsor:agent:<id>:<date>`, `sponsor:global:<date>`,
  `sponsor:ledger:<ledgerId>`.
- Funding flywheel (`backend/src/services/sponsor-pool.ts`): a configured
  fraction of Stripe revenue (default 10%, `PLATFORM_REVENUE_TO_POOL_BPS`)
  is carved into the sponsor pool (`sponsor:pool:balance:uc`), idempotent on
  event id.
- Settlement (`backend/src/services/settlement.ts`): batches unsettled
  ledger rows by skill → recipient wallets; zeroes the owner lane for
  opted-out domains; supports dry-run; on-chain submission via the
  facilitator (`backend/src/services/sponsor-flex.ts`) using a dedicated
  platform escrow + short-lived session key; settlement runs after the
  response (`waitUntil`), never blocking.

### LLM proxy
`POST /v1/llm/:provider/messages` proxies to upstream providers via
xgate.run with a markup; payable either by subscription credit (bearer) or
x402 (`backend/src/routes/llm.ts`, `backend/src/services/xgate.ts`).

## 5. Marketplace & publishing
- **Manifest** (`backend/src/types.ts`): skill_id, version, name,
  intent_signature, domain, endpoints[], contributors[], owner wallet
  (USDC ATA), compensation opt-in, markup_bps, payment_term, lifecycle.
- **Publish** `POST /v1/skills` (`backend/src/routes/skills.ts` →
  `backend/src/services/marketplace.ts`): schema validation → secret-leak
  sanitization pass (including an AI scrub step) → search indexing → KV
  store (`skill:<id>`) → graph edges (requires/yields) → cache
  invalidation. Updates are version bumps, not in-place edits.
- **Domain verification** (`backend/src/services/domain-verifier.ts`):
  challenge token placed at `https://<domain>/.well-known/<token>`; probe
  enforces HTTPS, 5s timeout, 4KB cap, no redirects, and SSRF guards
  (private/link-local IP bans). Production enforcement is flag-gated
  (`REQUIRE_DOMAIN_VERIFICATION`).
- **Domain claim** (`backend/src/services/domain-claim.ts`,
  `backend/src/routes/claim.ts`): DNS TXT record `_unbrowse.<domain>`
  binding domain → Solana wallet, verified against **two independent DoH
  providers** (Cloudflare + Quad9); apex domains only; 10 challenges/hr/
  domain. Takedown flow lets a verified owner opt out — settlement then
  zeroes that domain's owner lane. Bindings live in KV
  (`domain-binding:<domain>`, `domain-optout:<domain>`).

## 6. Data model (summary)
| Entity | Store | Key/table |
|---|---|---|
| Account (email, ToS) | Postgres | accounts (via service code) |
| Telemetry sessions/clusters | Postgres | `telemetry_sessions`, `telemetry_clusters` (`backend/schema/telemetry-sessions.sql`) |
| API keys | KV | `keyhash:<sha256>`, `keyid:<keyId>` |
| Key funding | KV | `keyfund:<keyId>` |
| Stripe/crypto sub cache | KV | `stripe:user:<userId>`, `stripe:customer:<customerId>` |
| Crypto intents | KV | `crypto:intent:<intentId>` |
| Usage counters | KV | `billing:usage:<userId>:<YYYY-MM>` |
| Skills | KV | `skill:<skillId>` (+ search index) |
| Sponsor spend/ledger/pool | KV | `sponsor:agent:*`, `sponsor:global:*`, `sponsor:ledger:*`, `sponsor:pool:*` |
| Domain bindings/opt-outs | KV | `domain-binding:<domain>`, `domain-optout:<domain>` |
| Sessions/traces/settings/screenshots | KV | wallet-prefixed namespaces |

## 7. Known gaps / uncertainties
- Full Postgres schema is not checked in (only telemetry DDL); accounts and
  usage tables are defined implicitly by service code.
- Live on-chain settlement depends on the external facilitator SDK; the
  repo tests it via dry-runs.
- Privy-backed server-side x402 signing endpoint is referenced by the
  client but not yet implemented.
