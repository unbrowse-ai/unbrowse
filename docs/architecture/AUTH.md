# Unbrowse Architecture — Identity, Auth & Wallets

> **At a glance (web3-native, 2026-06-25 rip)** — One identity (the local
> self-custody **ed25519 wallet pubkey**) fronts every backend call. The
> client signs a fresh domain-separated challenge and the backend verifies it
> as the SOLE REQUIRED credential, authenticating the caller as
> `wallet:<pk>` BEFORE any bearer path. A legacy `ubr_` api-key, if present,
> is an OPTIONAL **web2 wrapper** layered over the wallet for account-bound
> continuity (payouts accrual, dashboard sync); a wallet-only caller is a
> full principal. Unbrowse is a **child environment executor** under the
> **contract (aiko) parent substrate**, which signs the on-chain parent root;
> the wallet is the only identity the runtime ever persists.

> Reviewed 2026-06-25 against build v9.4.12+web3-rip. Companion to [SECURITY.md](./SECURITY.md),
> [PRIVACY.md](./PRIVACY.md), and the money model in [../HOW_UNBROWSE_PAYS.md](../HOW_UNBROWSE_PAYS.md).

## 1. Identity & the wallet signature

- **Identity root = the wallet pubkey (ed25519)**, persisted at
  `~/.unbrowse/wallet.json` (mode 0o600) + OS keychain seal. Every install
  creates one on first run (`src/values/signer.ts` →
  `ensureLocalWalletAddress()`); there is no email/password gate to identity.
- **The auth credential** is a capability signature minted per-request by
  `src/lib/wallet-auth-headers.ts` (`mergedAuthHeaders()`). The signature is
  over `AUTH_DOMAIN ":" pubkeyHex ":" ts` (60s TTL,
  `AUTH_DOMAIN = "unbrowse-auth:v1"`), sent as the three headers
  `X-Unbrowse-Wallet`, `X-Unbrowse-Auth-Ts`, `X-Unbrowse-Signature`. The
  backend (`backend/src/services/auth-signature.ts` → `authBySignature`)
  re-derives the challenge, verifies the ed25519 sig against the pubkey, and
  resolves to the agent_id `wallet:<pk>` (or its bound account, if any).
- **The wallet sig IS the principal — never key-gated.** Verified by
  `backend/test/wallet-principal-never-keygated.test.ts`: a wallet-only
  caller (no api-key bound) authenticates and reads
  `/v1/agents/wallet`, `/v1/agents/accept-tos`, `/v1/agents/me`,
  `/v1/account/me`, `/v1/account/credits` regardless of key state. The three
  auth middlewares (`bearerAuth`, `optionalAuth`, `bearerAuthNoTos`) all
  verify the sig FIRST and short-circuit to `wallet:<pk>` before any Bearer
  401 path.
- **`ubr_` api-key = DEPRECATED web2 wrapper**, layered over the wallet when
  present (`Authorization: Bearer ubr_…`). Used only to bind account-bound
  flows (payouts to the linked email, dashboard sync, ToS surface). The
  wrapper will be retired; new code MUST NOT gate on it. Client-side
  `getApiKey()` (`src/client/index.ts`) is now opt-in: `ensureUsableKey()`
  returns `{key: ""}` on the resolve hot path when a wallet is present, and
  only attempts a key-mint when `opts.allowMint` is set.
- **Parent/child substrate model.** The wallet at `~/.unbrowse/wallet.json`
  is unbrowse's identity. The contract substrate (aiko) is the **parent** —
  its deployer keypair at `~/.aiko/keys/deployer.key` signs the parent root
  on-chain, and unbrowse is its **child environment executor** with access
  only to web primitives. The bridge lives in
  `src/bridges/contract-mcp-bridge.ts` + `src/lib/contract-thin-client.ts`
  (HTTP thin client over `/v1/contract/*`); the child never oversteps into
  the parent's signing scope.
- **Client storage** (`src/client/index.ts`): `~/.unbrowse/config.json`
  (mode 0o600) carries `agent_id`, `email`, `user_id`, `wallet_address`,
  `wallet_provider`, ToS acceptance (`UnbrowseConfig`). `getApiKey()` reads
  `UNBROWSE_API_KEY` first then config; `validateApiKey()` HEADs
  `/v1/agents/me` (note: when wallet-only, the route accepts the sig
  directly — the key is not required to be present).

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

## 6. Wallet resolution order (the wallet is the identity; wrappers layer on top)

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
   **This entry is the IDENTITY ROOT** — when this is the resolved address, the
   same keypair signs every auth capability via `mergedAuthHeaders()`. The
   wallet is the principal; the key (if bound) is the wrapper.
6. **None** → sponsored free tier, or an honest `x402_no_wallet` failure.

**Signer adapter** — at payment time `src/payments/x402-fetch.ts`
(`resolveWalletConfig`) picks how to sign: explicit `UNBROWSE_WALLET_ADAPTER` →
`~/.lobster` ⇒ lobster → `~/.privy` ⇒ **privy** → `UNBROWSE_WALLET_KEY` ⇒
generic → none (pay.sh is explicit-only). Note Privy is an *adapter* here, not a
`getWalletContext` address source. The adapter enforces the cost ceiling, signs
the x402 envelope, and retries. Credentials are sealed to the wallet in
`src/vault/wallet-vault.ts` (`sealToWallet` / `open`); `commitmentOf` exposes a
host-independent commitment that reveals nothing about the secret.

**Funding binds the wallet to a key wrapper.** A `ubr_` api-key, when present,
is bound to a funding source (external wallet address or prepaid credit
budget) via `POST /v1/account/keys/:keyId/funding` (backend `account.ts`) —
this is the optional account-bind that carries payouts accrual. Contributors
who published before attaching a wallet are paid retroactively when the
binding appears (backend `splits.ts`). Client-side, `src/cli-wallet.ts` reads
and reconciles the local wallet vs the server-bound wallet for the
`unbrowse wallet` command. **The wallet always remains the identity; the key
is only a funded wrapper that the agent may or may not have.**

## 7. Parent/child substrate (aiko → unbrowse)

The wallet at `~/.unbrowse/wallet.json` is unbrowse's identity, but unbrowse
itself is a **child environment executor** under the **contract (aiko) parent
substrate**:

- **Parent (aiko/contract):** the on-chain truth-root. Deployer keypair lives
  at `~/.aiko/keys/deployer.key`; the contract binary's signed attestations
  are the witness ledger rows the rest of the system dereferences. The wallet
  signs FOR the Word declared on the parent — the wallet is rotatable, the
  Word is not.
- **Child (unbrowse):** the environment executor with access only to **web
  primitives** (fetch, scrape, browse, sign web challenges, x402 pay). It
  never oversteps into the parent's signing scope — it never signs a parent
  truth claim, only its own web-auth capability.
- **Bridge:** `src/bridges/contract-mcp-bridge.ts` + the HTTP thin client at
  `src/lib/contract-thin-client.ts` (`/v1/contract/*` server route) expose
  the parent's declarations to the child as MCP tool surface. The child
  reads parent-signed ledger rows as pointers (never inlines the payload),
  dereferences through the substrate, and acts on the resolved truth.

## One-line model

The local ed25519 wallet is the single identity. It signs every request as a
fresh capability, the backend verifies it as `wallet:<pk>` BEFORE any bearer
path, and a `ubr_` key (if present) is a deprecated funded wrapper layered for
account-bound continuity — under a contract (aiko) parent substrate where the
wallet signs FOR the Word, never in its place. "Who you are" (wallet pubkey)
and "who pays" (the same wallet, optionally key-funded) are the same handle.

## See also
- Anti-tamper, anti-bot, trust graph → [SECURITY.md](./SECURITY.md)
- Secrets & data handling → [PRIVACY.md](./PRIVACY.md)
- Wallets & payments (agent view) → [../for-agents/wallets-and-payments.md](../for-agents/wallets-and-payments.md)
- Money model → [../HOW_UNBROWSE_PAYS.md](../HOW_UNBROWSE_PAYS.md)
