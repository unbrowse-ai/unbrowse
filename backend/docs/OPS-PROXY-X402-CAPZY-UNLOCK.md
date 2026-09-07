# Ops runbook — residential proxy, x402, Capzy, `/v1/unlock`

Operator steps for the paid egress / captcha / unblocker stack on the
Cloudflare Worker. **Never paste secret values into chat, tickets, git, or
this file.** Use `wrangler secret put` (stdin) and `wrangler secret list`
(names only).

Routes (mounted in `backend/src/index.ts`):

| Surface | Method / path | Auth | Upstream secret(s) |
|---|---|---|---|
| HTTP proxy | `POST /v1/proxy` | Bearer **or** x402 proof | `MINI_EGRESS_URL`, `EGRESS_SECRET` (residential runtime); optional `IPROYAL_*` on mini-egress host |
| Captcha solve | `POST /v1/solve` | Bearer **or** x402 proof | `CAPZY_KEY` |
| Web unlock reseller | `POST /v1/unlock` | Flex x402 (`X-PAYMENT`) | `BASE_X402_SIGNER_KEY`, optional `UNLOCK_UPSTREAM_APIKEY` |
| Proxy health | `GET /v1/proxy` | none | `residential_configured` true **iff** `MINI_EGRESS_URL` **and** `EGRESS_SECRET` are set (matches `fetchViaIproyal` runtime gate; `IPROYAL_USER` alone is a false positive) |

---

## 0. Inventory secrets (names only)

### Declared provisioning exceptions (machine-read)

`scripts/backend-config-parity.sh` compares this runbook's secret inventory
against what `.github/workflows/deploy.yml` and
`.github/workflows/gitea-mini-deploy.yml` provision, and against the `Env`
type in `backend/src/types.ts`. Anything that legitimately does not line up
has to be declared here, so a gap is a written decision rather than drift
nobody noticed. The gate reads these comments literally — keep the shape.

<!-- config-parity: operator-manual PLATFORM_SPONSOR_WALLET_KEY sponsor tier is opt-in and off by default: PLATFORM_SPONSOR_WALLET_ADDRESS is "" in every wrangler env, and sponsor.ts refuses-to-enable unless BOTH the address var and this signer key are set. Auto-provisioning the signer on every deploy would arm a paying wallet nobody asked for, so an operator puts it by hand at the moment they turn the tier on. -->

<!-- config-parity: not-worker-read IPROYAL_USER pool identity lives on the mini-egress HOST. The Worker never reads it: isResidentialConfigured takes it in its signature only to ignore it, and fetchViaIproyal authenticates with MINI_EGRESS_URL + EGRESS_SECRET. -->

<!-- config-parity: not-worker-read IPROYAL_PASS same as IPROYAL_USER — mini-egress host credential, never read by the Worker. -->

From `backend/`:

```bash
# Production (top-level deploy + --env production)
npx wrangler secret list
npx wrangler secret list --env production

# Staging
npx wrangler secret list --env staging
```

Expected names for this stack (presence ≠ correctness of value):

| Secret | Purpose |
|---|---|
| `IPROYAL_USER` / `IPROYAL_PASS` | Residential pool identity on the **mini-egress host** (not read by Worker residential path) |
| `MINI_EGRESS_URL` | HTTPS base URL of the OS-level residential egress service (**required** for residential) |
| `EGRESS_SECRET` | Shared secret header `X-Egress-Secret` for that service (**required** for residential) |
| `CAPZY_KEY` | Capzy `clientKey` for server-side `/v1/solve` (moat — not shipped to clients) |
| `BASE_X402_SIGNER_KEY` | `0x` + 64 hex EVM key — Worker fronts Base x402 upstreams |
| `UNLOCK_UPSTREAM_APIKEY` | Vendor account key for the web-unlocker (200ok apiKey+paid) |
| `PLATFORM_SPONSOR_WALLET_KEY` | Solana sponsor signer (x402 sponsor tier) |

Plain vars (committed in `wrangler.toml` `[vars]` / `[env.*.vars]`, **not** secrets):

| Var | Role |
|---|---|
| `X402_NETWORK_MODE` | `mainnet` \| `testnet` / `devnet` — payment network terms |
| `PAYMENT_RECIPIENT` | Solana wallet that appears in 402 `accepts` / payTo |
| `X402_DEGRADED_ALLOW` | Optional secret/var: set `1` only to fail-open on facilitator outage (default fail-closed) |
| `FAIR_COMPENSATION_BPS` | Platform take on brokered cost (**code default 0 = pass-through**; set e.g. `2000` only to opt into 20% markup) |
| `UNLOCK_UPSTREAM_URL` | Override default `https://web-unlocker.200ok.xyz/unlock` |
| `UNLOCK_UPSTREAM_COST_USD` | Passthrough USD (default `0.01`) |
| `SOLVE_SURCHARGE_USD` | Per-solve toll (default `0.003`) |
| `SPONSOR_PROXY_SURCHARGE_USD` | Residential 429-fallback toll (default `0.001`) |
| `CAPZY_URL` | Capzy API host override (default `https://api.capzy.ai`) |
| `PLATFORM_SPONSOR_WALLET_ADDRESS` | Public sponsor address (must be non-empty **with** `PLATFORM_SPONSOR_WALLET_KEY` or sponsor tier refuses-to-enable) |

---

## 1. Residential proxy (`POST /v1/proxy`)

### Code path

- `backend/src/routes/proxy.ts` — direct Worker `fetch`, or residential via
  `fetchViaIproyal` → external mini-egress (`MINI_EGRESS_URL` + `EGRESS_SECRET`).
- Workers cannot TLS-handshake arbitrary origins over `cloudflare:sockets`
  `startTls`, so residential is **delegated** to the mini-egress service.
- Health: `isResidentialConfigured` = both mini-egress env vars non-empty
  (unit: `backend/tests/residential-health.test.ts`).
- Opt-in 429 fallback: authenticated agent with `consent:proxy_fallback = yes`
  → residential retry + `recordProxySurcharge` toll
  (`maybeProxyFallback`, sponsor ledger).

### Operator set steps

```bash
cd backend

# 1) Mini-egress service (REQUIRED for residential mode at runtime + health flag)
printf '%s' "$MINI_EGRESS_URL_VALUE" | npx wrangler secret put MINI_EGRESS_URL --env production
printf '%s' "$EGRESS_SECRET_VALUE"   | npx wrangler secret put EGRESS_SECRET --env production

# 2) iProyal pool identity lives on the mini-egress HOST (not required for Worker health)
#    Worker may still store IPROYAL_* for inventory/docs parity if the egress service
#    is co-provisioned from the same secret store:
printf '%s' "$IPROYAL_USER_VALUE" | npx wrangler secret put IPROYAL_USER --env production
printf '%s' "$IPROYAL_PASS_VALUE" | npx wrangler secret put IPROYAL_PASS --env production
```

Repeat with `--env staging` for staging.

If `MINI_EGRESS_URL` / `EGRESS_SECRET` are missing, residential mode throws:

> `MINI_EGRESS_URL / EGRESS_SECRET env not set; run wrangler secret put …`

and `GET /v1/proxy` reports `residential_configured: false`.

### Verify (no secrets printed)

```bash
# Capability probe — residential_configured true iff mini-egress URL+secret set
curl -sS https://beta-api.unbrowse.ai/v1/proxy | jq '{modes, residential_configured}'

# Unauthed POST must 402 (Bearer or x402 required) — not 500
curl -sS -o /tmp/proxy-unauth.json -w '%{http_code}\n' \
  -X POST https://beta-api.unbrowse.ai/v1/proxy \
  -H 'content-type: application/json' \
  -d '{"url":"https://example.com"}'
# expect 402; body error=payment_required
```

### Client-side residential (CLI / Kuri) — separate from Worker

Local Chrome / curl-impersonate path uses env on the **agent machine**, not
Worker secrets:

```
UNBROWSE_KURI_PROXY=auto   # or 1 / true / explicit http(s)|socks5 URL
IPROYAL_USER=…
IPROYAL_PASS=…
# or UNBROWSE_PROXY_URL=http://user:pass@host:port
# force direct: UNBROWSE_KURI_PROXY=0  or  UNBROWSE_DIRECT_EGRESS=1
```

See `docs/public/primitives/02-residential-proxy-fallback.md`. Never commit
credentials; logs redact them (`[kuri-proxy] wired … url=http://***@…`).

---

## 2. x402 (payment gate + Base broker)

### Charge side (agent → Unbrowse)

- Wire: HTTP `402` + `accepts[]` + `PAYMENT-REQUIRED` header; retry with
  `X-PAYMENT` / `PAYMENT-SIGNATURE` / legacy `X-Payment-Proof`.
- Settlement: Faremeter Flex (Solana USDC). Public contract:
  `docs/api/x402.md`, primitive `docs/public/primitives/04-x402-and-faremeter.md`.
- Network: `X402_NETWORK_MODE` in wrangler vars (`mainnet` on production /
  staging; `devnet` on experiments).
- Recipient: `PAYMENT_RECIPIENT` (platform / creator wallet in envelope).
- Fail-closed: facilitator outage does **not** free paid skills unless
  operator sets `X402_DEGRADED_ALLOW=1` (legacy opt-in).
- Sponsor tier: `PLATFORM_SPONSOR_WALLET_KEY` + address vars
  `PLATFORM_SPONSOR_WALLET_ADDRESS`, caps `SPONSOR_CAP_DAILY_USD` /
  `SPONSOR_GLOBAL_DAILY_USD`. Empty address refuses-to-enable even if key exists.

### Pay side (Unbrowse → Base upstreams)

`services/base-x402-pay.ts` signs EIP-3009 `TransferWithAuthorization` in-Worker
with `BASE_X402_SIGNER_KEY` (`0x` + 64 hex). Used by `/v1/unlock` (and any other
Base x402 reseller). Missing key → honest `503 broker_unconfigured`.

```bash
cd backend
# stdin only — never echo the key
npx wrangler secret put BASE_X402_SIGNER_KEY --env production
# paste 0x… key, Ctrl-D

# Fund the corresponding Base address with USDC (and a little ETH for edge cases).
# Confirm name only:
npx wrangler secret list --env production | jq -r '.[].name' | grep BASE_X402
```

### Verify x402 envelope (no settlement)

```bash
# Unauthed paid surface should 402 with accepts (not 5xx)
curl -sS -o /tmp/unlock-402.json -w '%{http_code}\n' \
  -X POST https://beta-api.unbrowse.ai/v1/unlock \
  -H 'content-type: application/json' \
  -d '{"url":"https://example.com"}'
# expect 402; jq '.accepts, .facilitator, .error' /tmp/unlock-402.json

# Code readiness for mainnet payouts (does not move money):
bash backend/scripts/mainnet-payout-ready.sh
```

---

## 3. Capzy (`POST /v1/solve`)

### Server (moat)

- Secret lives **only** on the Worker: `CAPZY_KEY` → Capzy `clientKey`.
- Route: `backend/src/routes/solve.ts`. Unconfigured → `503 solver_unconfigured`.
- Solve failure → `502` with reason; **never** fabricates a token.
- Metered via `recordProxySurcharge` (`SOLVE_SURCHARGE_USD`, default $0.003).
- Vendor → task type map must stay in lockstep with client
  `capzyTaskTypeForVendor` (`src/execution/captcha-solve.ts`).

```bash
cd backend
npx wrangler secret put CAPZY_KEY --env production
# optional host override as plain var CAPZY_URL if not using api.capzy.ai
```

### Client-local Capzy (optional, not the moat)

CLI can hold `UNBROWSE_CAPZY_KEY` for local CF / Tencent WAF clears
(`solveCfViaCapzy`, `clearTencentWafViaCapzy`). Prefer server `/v1/solve` so
the key stays off agent hosts. Local key is for operator laptops / benches only.

### Verify

```bash
# No auth → 402
curl -sS -o /tmp/solve-402.json -w '%{http_code}\n' \
  -X POST https://beta-api.unbrowse.ai/v1/solve \
  -H 'content-type: application/json' \
  -d '{"vendor":"cloudflare","url":"https://example.com","body":"<div data-sitekey=\"x\">"}'
# expect 402

# With a real agent Bearer but CAPZY_KEY missing → 503 solver_unconfigured
# With key set + valid sitekey → 200 { token } or 502 solve_failed (never fake token)
```

Unit witnesses (no live Capzy spend):

```bash
bun test tests/capzy-cf-solve.test.ts tests/tencent-waf-solve.test.ts
```

---

## 4. `UNLOCK_UPSTREAM_APIKEY` (`POST /v1/unlock`)

### What it is

Reseller for a paid web-unlocker (default 200ok on Base x402):

1. Agent hits `/v1/unlock` without payment → **402** Flex envelope priced at
   upstream cost + fair-comp markup (`compensateTxCost`; default markup **0%**).
2. Agent retries with `X-PAYMENT` → Flex verify/settle.
3. Worker fronts upstream via `payUpstreamViaBaseX402` using
   `BASE_X402_SIGNER_KEY` + optional vendor `UNLOCK_UPSTREAM_APIKEY`
   (200ok wants **apiKey + paid**, not crypto alone).
4. Returns cleared HTML/json; headers
   `x-unbrowse-charge-usd`, `x-unbrowse-passthrough-usd`,
   `x-unbrowse-compensation-bps`.

Code: `backend/src/routes/unlock.ts`, `services/base-x402-pay.ts`,
`services/fair-compensation.ts`, `services/flex-route-helpers.ts`.

### Operator set steps

```bash
cd backend

# Required for pay side
npx wrangler secret put BASE_X402_SIGNER_KEY --env production

# Required for 200ok (and similar apiKey+paid vendors)
npx wrangler secret put UNLOCK_UPSTREAM_APIKEY --env production

# Optional overrides as plain vars (wrangler.toml [env.production.vars] or secret put):
#   UNLOCK_UPSTREAM_URL=https://web-unlocker.200ok.xyz/unlock
#   UNLOCK_UPSTREAM_COST_USD=0.01
#   FAIR_COMPENSATION_BPS=0        # default pass-through; set 2000 only to opt into 20%
# PAYMENT_RECIPIENT must be set (wrangler vars) or unlock returns 503 operator_wallet_missing
```

### Gap check (names only)

Inventory re-verified: **2026-08-03** (`npx wrangler secret list` / `--env production` /
`--env staging`, names only — no values):

- **production** (`--env production`, and default top-level list match for this stack):
  present — `BASE_X402_SIGNER_KEY`, `CAPZY_KEY`, `IPROYAL_USER`, `IPROYAL_PASS`,
  `MINI_EGRESS_URL`, `EGRESS_SECRET`, `PLATFORM_SPONSOR_WALLET_KEY`;
  **missing** — `UNLOCK_UPSTREAM_APIKEY` → `/v1/unlock` can 402 and settle Flex,
  but 200ok-style apiKey+paid upstream may reject without the vendor key
  (`upstream_unavailable` / failed paid attempt).
  **Operator action:** `printf '%s' "$UNLOCK_UPSTREAM_APIKEY" | npx wrangler secret put UNLOCK_UPSTREAM_APIKEY --env production`
  (and the same name in GitHub Actions secrets so `deploy.yml` keeps it on redeploy).
- **staging** (`--env staging`): present — `BASE_X402_SIGNER_KEY`, `CAPZY_KEY`;
  **missing** — `IPROYAL_*`, `MINI_EGRESS_URL`, `EGRESS_SECRET`,
  `UNLOCK_UPSTREAM_APIKEY`, `PLATFORM_SPONSOR_WALLET_KEY`.
- **Live prod probes** (beta-api.unbrowse.ai, same day): `GET /v1/proxy` →
  `modes: [direct, residential]`, `residential_configured: true` (mini-egress
  armed on prod); unauthed `POST` `/v1/proxy` → **402** `payment_required`;
  `/v1/solve` → **402** `payment_required`; `/v1/unlock` → **402** with
  `facilitator: faremeter-flex-solana` and `accepts: 1`. No secret values printed.
- **Unit witnesses** (same day, no live spend): 62 pass / 0 fail across the §7 suite
  (unlock, base-x402-pay, proxy-429, sponsor-proxy, residential-health,
  fair-compensation, x402-llm-envelope, capzy-cf-solve, tencent-waf-solve).
- **CI arm (code)**: `.github/workflows/deploy.yml` provisions
  `UNLOCK_UPSTREAM_APIKEY`, `MINI_EGRESS_URL`, `EGRESS_SECRET`, `IPROYAL_*`,
  `CAPZY_KEY`, `BASE_X402_SIGNER_KEY` when the matching GitHub Actions secrets
  exist (skip-cleanly otherwise). `gitea-mini-deploy.yml` has the same Capzy /
  Base-x402 / unlock / mini-egress steps. Operator must still put secret
  **values** into the Actions store — workflow only wires names; never prints values.

Re-list after any put:

```bash
npx wrangler secret list --env production | jq -r '.[].name' | sort
# confirm names only; never dump values
```

### Verify unlock lane

```bash
# 402 shape without payment (wallet configured)
curl -sS -X POST https://beta-api.unbrowse.ai/v1/unlock \
  -H 'content-type: application/json' \
  -d '{"url":"https://example.com"}' | jq '{error, facilitator, charge: .extra.charge_usd, accepts: (.accepts|length)}'

# Unit (no live pay):
bun test backend/tests/unlock-route.test.ts backend/tests/base-x402-pay.test.ts
```

Live paid unlock is **operator-manual** (real USDC on Solana + Base) — do not
automate settlement in CI. Accepted risk: no automated two-witness paid settle.

---

## 5. Staging vs production checklist

| Step | staging | production |
|---|---|---|
| `wrangler secret put … --env staging` / `--env production` | ☐ | ☐ |
| `CAPZY_KEY` | ☐ | ☐ |
| `BASE_X402_SIGNER_KEY` (funded Base wallet) | ☐ | ☐ |
| `UNLOCK_UPSTREAM_APIKEY` (vendor account) | ☐ | ☐ |
| `IPROYAL_USER` + `IPROYAL_PASS` (mini-egress host) | ☐ | ☐ |
| `MINI_EGRESS_URL` + `EGRESS_SECRET` (**Worker residential gate**) | ☐ | ☐ |
| `PAYMENT_RECIPIENT` + `X402_NETWORK_MODE=mainnet` in vars | ☐ | ☐ |
| `PLATFORM_SPONSOR_WALLET_ADDRESS` non-empty if sponsor tier desired | ☐ | ☐ |
| `GET /v1/proxy` → `residential_configured: true` | ☐ | ☐ |
| Unauthed `/v1/proxy`, `/v1/solve` → 402 | ☐ | ☐ |
| Unauthed `/v1/unlock` → 402 accepts | ☐ | ☐ |

Deploy after secrets:

```bash
cd backend
npx wrangler deploy --env staging     # first
npx wrangler deploy --env production  # after staging green
```

---

## 6. Security rules (non-negotiable)

1. **Never** commit secret values, `.env` with live keys, or wrangler dump
   output that includes plaintext.
2. Prefer `printf '%s' "$VAR" | wrangler secret put NAME` over interactive
   paste in shared screen recordings.
3. Capzy + unlock vendor keys are **server-only** moat; do not put
   `CAPZY_KEY` / `UNLOCK_UPSTREAM_APIKEY` into the npm client or MCP env.
4. Rotate by `secret put` overwrite; revoke at Capzy / 200ok / iProyal
   dashboards if a value leaked.
5. Two witnesses before calling a lane green: unit suite (this doc § tests)
   + live probe (402 shape or residential_configured) on the target env.

---

## 7. Related tests (cheap, no secrets)

```bash
bun test \
  backend/tests/unlock-route.test.ts \
  backend/tests/base-x402-pay.test.ts \
  backend/tests/proxy-429-fallback.test.ts \
  backend/tests/sponsor-proxy-fallback.test.ts \
  backend/tests/residential-health.test.ts \
  backend/tests/fair-compensation.test.ts \
  backend/tests/x402-llm-envelope-compliance.test.ts \
  tests/capzy-cf-solve.test.ts \
  tests/tencent-waf-solve.test.ts
```

Related public docs: `docs/api/x402.md`,
`docs/public/primitives/02-residential-proxy-fallback.md`,
`docs/public/primitives/04-x402-and-faremeter.md`.
