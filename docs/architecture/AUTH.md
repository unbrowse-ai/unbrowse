# Unbrowse Architecture — Identity, Auth & Wallets

> **At a glance** — One identity (email magic link → `ubr_` API key) fronts both
> the platform and the money. The client gates auth *before* it spends effort on
> a personal/auth-shaped intent, attaches and refreshes credentials at execute
> time, keeps credentials off any server-readable tier, and resolves a wallet
> through a fixed precedence chain. An API key can be bound to a funding source —
> the key wraps the wallet.

> Reviewed 2026-06-17 against build v9.4.12. Companion to [SECURITY.md](./SECURITY.md),
> [PRIVACY.md](./PRIVACY.md), and the money model in [../HOW_UNBROWSE_PAYS.md](../HOW_UNBROWSE_PAYS.md).

## 1. Identity & the API key

- Users sign in with **email magic links** — no passwords (backend
  `auth.ts`, frontend `login`).
- The credential is an **API key** `ubr_<hex>`, stored SHA-256-hashed server-side
  (`backend/src/services/keys.ts`) and validated by `backend/src/middleware/auth.ts`
  with timing-safe comparison, a Terms-of-Service version gate, and a global kill
  switch (`ALL_KEYS_REVOKED`).
- **Client storage** (`src/client/index.ts`): `getApiKey()` resolves env
  `UNBROWSE_API_KEY` first, then `~/.unbrowse/config.json` (`.api_key`, mode
  0o600). `validateApiKey()` does a HEAD `/v1/agents/me` and returns
  `ok | missing_profile | invalid | offline`. The `ignore_env_api_key` flag lets
  a config key override a stale environment key.
- The profile config also carries `agent_id`, `email`, `user_id`,
  `wallet_address`, `wallet_provider`, and ToS acceptance (`UnbrowseConfig`).

## 2. Pre-resolve auth gate (don't spend effort you'll lose)

`src/auth/pre-resolve-gate.ts` blocks resolve *before* the costly routing race
when **all three** hold:

1. the intent is personal/auth-shaped (a personal pronoun, or a keyword like
   `login` / `account` / `auth` / `credentials`), **and**
2. the host is in `AUTH_GATED_HOSTS` (a fixed list of known login-walled hosts),
   **and**
3. there is no fresh local cookie for that host
   (`scripts/check_cookie_freshness.py`, lock-safe).

If the cookie DB is locked or errors, it passes (uncertain → attempt). The
decision returns `gate: "auth_required"` with the host and reason, so the agent
can prompt for sign-in instead of failing mid-route.

## 3. Runtime auth state & the post-execute feedback loop

- **Runtime** (`src/auth/runtime.ts`) — the in-process `LocalAuthRuntime`
  (`authRuntime`) resolves auth in order: cached session (memory TTL) → vault
  cookies → browser extraction fallback. `UNBROWSE_DISABLE_AUTH_FALLBACK=1`
  forces "unauthenticated" for tests. Cookie extraction supports Chrome / Firefox
  / Brave / Arc / Edge (`src/auth/browser-cookies.ts`); history is surfaced as
  eTLD+1 domains only, redacted (`src/auth/browser-history.ts`).
- **Stale endpoints** (`src/auth/stale-endpoints.ts`) — the post-execute
  feedback loop. A 401/403 marks `(domain, endpoint_id, status, cookie_source,
  reason)` stale for 30 min in `~/.unbrowse/stale-endpoints.json`;
  `isEndpointStale` then keeps resolve from returning that endpoint, and
  `buildAuthHint` surfaces the login URL + refresh surfaces (keychain →
  local browser → agent browser). `markCookieExpiry` pre-marks endpoints whose
  cookies have already expired, before an execute is even attempted.

## 4. Auth-bearing execution & token resolution

- **Auth-bearing classifier** (`src/execution/auth-bearing.ts`) — a pure, I/O-free
  predicate (`isAuthBearing`) that returns true if a request carries a credential
  a terminating server tier could read in the clear (any non-benign header, an
  `Authorization`-scheme value, or a locally-dereferenced sealed/storage-bound
  fill). The egress router uses it to keep credentialed requests **off** the
  server proxy tier. See [PERFORMANCE.md](./PERFORMANCE.md#3-egress-tiering).
- **Token resolver** (`src/execution/token-resolver.ts`) — resolves an
  endpoint's `auth_tokens` bindings at execute time: immediate cookie lookup (no
  network) → plain HTTP fetch (8s) extracting from HTML/meta/inline-script →
  Kuri browser fallback (12s) only when a binding is HTML-resolvable. Adds the
  `Bearer ` prefix when needed.

## 5. Verification of auth state

`src/verification/` decides what can be auto-verified:

- `auth-gate.ts` — `isAuthGatedEndpoint` returns true if the skill has an
  `auth_profile_ref` or the endpoint declares `auth_required`; such endpoints are
  excluded from the periodic (6h) auto-verification and only verified manually.
- `candidates.ts` — `selectVerificationCandidates` picks GET-only endpoints
  (never mutations), optionally only the stale ones (disabled, failed, low
  reliability, or not verified in 24h).
- `matrix.ts` / `index.ts` — integration-coverage matrix and the
  `verifyEndpoint` / `verifySkill` / `schedulePeriodicVerification` orchestration.

## 6. Wallet resolution order (the key wraps the wallet)

There are two distinct resolutions — **which wallet address** the agent has, and
**which signer adapter** pays a 402. Keep them separate.

**Wallet address** — `src/payments/wallet.ts` (`getWalletContext()`), first match
wins:

1. **OWS (Open Wallet Standard)** — env `OWS_WALLET_ADDRESS` or the `~/.ows`
   vault, with a declarative policy engine (`src/payments/ows.ts`); the vault
   probe is gated by `UNBROWSE_DISABLE_LOCAL_WALLET=1`.
2. **lobster.cash (env)** — `LOBSTER_WALLET_ADDRESS`.
3. **Generic env wallet** — `AGENT_WALLET_ADDRESS` (+ optional `AGENT_WALLET_PROVIDER`).
4. **lobster.cash (local config)** — `~/.lobster/config.json` (gated by the same flag).
5. **Unbrowse-local native wallet** — `~/.unbrowse/wallet.json` + OS keychain
   (gated). Every install gets a real self-custody wallet with zero setup.
6. **None** → sponsored free tier, or an honest `x402_no_wallet` failure.

**Signer adapter** — at payment time `src/payments/x402-fetch.ts`
(`resolveWalletConfig`) picks how to sign: explicit `UNBROWSE_WALLET_ADAPTER` →
`~/.lobster` ⇒ lobster → `~/.privy` ⇒ **privy** → `UNBROWSE_WALLET_KEY` ⇒
generic → none (pay.sh is explicit-only). Note Privy is an *adapter* here, not a
`getWalletContext` address source. The adapter enforces the cost ceiling, signs
the x402 envelope, and retries. Credentials are sealed to the wallet in
`src/vault/wallet-vault.ts` (`sealToWallet` / `open`); `commitmentOf` exposes a
host-independent commitment that reveals nothing about the secret.

**Funding binds the key.** A key can be bound to a funding source (external
wallet address or prepaid credit budget) via `POST /v1/account/keys/:keyId/funding`
(backend `account.ts`). Contributors who published before attaching a wallet are
paid retroactively when the binding appears (backend `splits.ts`). Client-side,
`src/cli-wallet.ts` reads and reconciles the local vs server wallet for the
`unbrowse wallet` command.

## One-line model

The `ubr_` key is the single identity; it gates effort before resolve, carries
credentials only to tiers that can't read them, and fronts a wallet resolved by
a fixed precedence — so "who you are" and "who pays" are the same handle.

## See also
- Anti-tamper, anti-bot, trust graph → [SECURITY.md](./SECURITY.md)
- Secrets & data handling → [PRIVACY.md](./PRIVACY.md)
- Wallets & payments (agent view) → [../for-agents/wallets-and-payments.md](../for-agents/wallets-and-payments.md)
- Money model → [../HOW_UNBROWSE_PAYS.md](../HOW_UNBROWSE_PAYS.md)
