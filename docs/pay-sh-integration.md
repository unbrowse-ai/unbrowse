# pay.sh integration (x402 payments)

How Unbrowse pays HTTP 402 (x402 / MPP) charges through [pay.sh](https://pay.sh) — the
Solana Foundation payment toolchain (`github.com/solana-foundation/pay`). Source of the
upstream behavior: pay.sh docs (Toolchain / Using pay / Building with pay).

## The model: pass-through, not a key

pay wraps the HTTP client you already use, detects a 402 challenge, builds a signed payment
proof, and retries the same request — no API key, no subscription. The request itself carries
proof of payment.

```sh
pay curl https://gateway/v1/search -H 'content-type: application/json' -d '{"query":"x"}'
pay fetch https://gateway/v1/quote/AAPL      # built-in client (no external curl needed)
pay wget https://gateway/v1/export.csv
pay http  POST https://gateway/v1/search query=x
pay claude / pay codex                        # attach Pay MCP tools to an agent session
pay --sandbox <cmd>                           # ephemeral localnet wallet, no real funds
```

Preserve the original provider URL exactly; all args after `curl`/`wget`/`http` forward to the
underlying tool.

## The 402 pull-mode handshake (what happens on a paid call)

```
1  GET /resource                         (unauthenticated)
2  402 Payment Required                  challenge: amount, recipient, nonce
3  GET /resource + X-PAYMENT             client signs a transfer authorization locally
4  gateway broadcasts the signed tx      (the gateway talks to Solana, not the client)
5  confirmed
6  200 OK + X-PAYMENT-RESPONSE           paid response
```

The client signs locally and replays once; the gateway settles on-chain. A bad proof never
reaches the origin. Pricing is per the provider's `metering` block (per-request, per-token,
per-character, volume tiers, or subscription) — see the pay.sh "Defining pricing" / "YAML
Specification" docs.

## How Unbrowse wires it

| piece | file | role |
|---|---|---|
| structural 402 signer | `src/payments/x402-fetch.ts` | intercepts ANY 402 (and 407 for proxy CONNECT), signs via the configured wallet adapter, retries once. Sub-states: `x402_signed` / `x402_no_wallet` / `x402_signer_error` / `x402_cost_exceeded` / `x402_retry_blocked` / `x402_passthrough`. |
| pay adapter | `src/payments/pay-sh.ts` | `UNBROWSE_WALLET_ADAPTER=pay` → shells `pay fetch <url>` (GET) or `pay curl -sS -X <m> <url>` — pay owns the whole challenge→sign→retry handshake (incl. MPP the native parser can't read). |
| proxy 402 auth | `src/execution/proxy-fetch.ts` `x402ProxyAuthorization()` | signs an x402-gated proxy's 402 control surface to get a `Proxy-Authorization` token for the residential CONNECT tunnel. |
| egress resolution | `src/execution/proxy-fetch.ts` `resolveEgressProxy()` | order: `UNBROWSE_DIRECT_EGRESS` → `UNBROWSE_PROXY_URL` → IProyal creds → ProxyKingdom (x402-gated, `proxykingdom.cn2.ai`). |

### Adapters (pluggable by WALLET, not by provider)

`UNBROWSE_WALLET_ADAPTER` ∈ `lobster` | `privy` | `generic` | `pay` | `none`. The 402 envelope is
structural, so the same signer works across every provider. `pay` uses pay.sh's account; the
others sign with their own wallet. To use pay: `export UNBROWSE_WALLET_ADAPTER=pay`.

### Spend ceiling

`UNBROWSE_X402_MAX_COST_USD` (default `1.00`) caps any single 402; over it → `x402_cost_exceeded`,
no payment. Set it tight for automated runs (e.g. `0.10`).

## Funding the pay account

```sh
pay whoami                 # active account name
pay account list           # accounts + on-chain balances (mainnet + localnet)
pay topup                  # fund a mainnet account (PayPal / Venmo / Apple Pay / Solana wallet)
```

`pay account list` is authoritative for the deposit address + balance. Send **USDC on Solana
mainnet** (SPL mint `EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v`) to the mainnet account's
address; keep a thin SOL buffer (~0.01) for tx fees + the first token-account rent.

## Failure handling (negative-cache layer)

x402-gated providers can be dead (e.g. ProxyKingdom returning `503 NO_AVAILABLE_KEYS`). The
negative-cache layer (`src/values/failure-cache.ts`) classifies such an outcome as `structural`
and caches it (24h), so `resolveEgressProxy` stops routing captures through a known-dead proxy
until the cooldown expires — rather than re-handshaking a dead provider every call. Anti-bot
(403/challenge) and transient (503/timeout) outcomes get shorter, egress-keyed cooldowns. See
`docs/benchmarks.md` and the failure-cache module for the class TTLs.
