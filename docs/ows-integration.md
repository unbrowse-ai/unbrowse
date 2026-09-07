# OWS integration (Open Wallet Standard v1.3)

How Unbrowse uses [OWS](https://openwalletstandard.org) — the **Open Wallet Standard** — as its
primary, open-standard wallet path, preferred ahead of the bespoke local signer and the
lobster.cash / pay.sh rails. OWS standardizes exactly what Unbrowse hand-rolled: a local
encrypted wallet vault, policy-gated signing, and API-key delegated agent access, with x402
payment built in (`ows pay request`).

> **Why OWS first:** it is an open standard, not a single vendor. The bespoke local signer
> (`src/values/signer.ts`) becomes the legacy fallback; lobster.cash and pay.sh remain
> supported rails for agents that already hold those wallets.

## The model: a local vault + a policy engine, not a key Unbrowse holds

OWS keeps the wallet in an encrypted local vault (`~/.ows/wallets/<uuid>.json`) addressed by
**CAIP-2 / CAIP-10** chain + account identifiers. Unbrowse reads only the *public* wallet
descriptor (address, chain, derivation path) to learn the agent's identity — never secret
material. Signing, and any policy enforcement, stay inside OWS (`ows pay request`).

```sh
ows wallet list                 # vault wallets (public descriptors)
ows pay request <url>           # x402 paid call — OWS signs + replays, like pay.sh/lobster
```

## Wallet precedence (precedence of record: AC-WAL-1)

`src/payments/wallet.ts` `getWalletContext()` resolves the agent's wallet identity in this order,
and reports the chosen `wallet_provider`:

| order | source | provider label |
|---|---|---|
| 1 | `OWS_WALLET_ADDRESS` env, else first `~/.ows/wallets/*.json` account (eip155 first, then any) | `ows` |
| 2 | `LOBSTER_WALLET_ADDRESS` env | `lobster.cash` |
| 3 | `AGENT_WALLET_ADDRESS` env (+ `AGENT_WALLET_PROVIDER`) | generic |
| 4 | local `~/.lobster/config.json` | `lobster.cash` |
| 5 | nothing → `{}` | none |

OWS is probed first; `UNBROWSE_DISABLE_LOCAL_WALLET=1` suppresses the vault probe (tests use it
to assert a pristine machine). The vault probe reads public descriptors only — an encrypted-only
blob with no public descriptor is skipped (resolve it via the `ows` CLI instead).

## OWS Core Types (`src/payments/ows.ts`)

Implements the spec's Core Types so a real OWS wallet resolves regardless of casing (the spec's
camelCase TS types and the `ows` CLI's snake_case JSON are both read defensively):

- **`AccountDescriptor`** — `accountId` (CAIP-10), `address`, `derivationPath` (BIP-44), `chainId` (CAIP-2).
- **`WalletDescriptor`** — `id` (UUID), `name`, `createdAt`, `chainType`, `accounts[]`, `metadata`.
- **`ApiKey`** — delegated agent access: `tokenHash` (SHA-256 of the raw token), `walletIds[]`, `policyIds[]`, optional `expiresAt`.

## Policy engine (AC-WAL-2)

`evaluatePolicy(policy, ctx)` enforces a declarative `OwsPolicy` whose rules are **AND-combined**
— every rule must pass or the request is denied:

| rule | meaning |
|---|---|
| `allowed_chains` | the request's CAIP-2 chain must be in the allowlist |
| `expires_at` | the policy must not have expired at the request timestamp |

`action: "deny"` blocks a violating payment; `action: "warn"` allows it while surfacing the first
violation's reason. Tested in `tests/ows-policy.test.ts`, `tests/ows-vault-policy.test.ts`,
`tests/ows-provider.test.ts`.

## How OWS sits in the x402 path (honest wiring status)

| piece | file | status |
|---|---|---|
| wallet identity + provider resolution | `src/payments/wallet.ts` `getWalletContext()` | **wired** — OWS is precedence #1 (`resolveOwsWalletAddress`) |
| Core Types + vault read | `src/payments/ows.ts` `listOwsWallets`, `resolveOwsWalletAddress`, `owsAvailable` | **implemented + tested** |
| policy engine | `src/payments/ows.ts` `evaluatePolicy` | **implemented + tested**; not yet called by the live signing path |
| structural 402 signer | `src/payments/x402-fetch.ts` | OWS is **not** a named `WalletAdapterName` (`lobster \| privy \| generic \| pay \| none`) |

The structural signer's adapter union does not list `ows`. So an OWS-signed payment settles via
**OWS's own `ows pay request`** or the **`UNBROWSE_X402_SIGNER` generic hook**
(`node:<module>` / `exec:<cmd>`), not as a dedicated `x402Fetch` rail. To route OWS through the
same `x402Fetch` challenge→sign→retry path as pay/lobster, point `UNBROWSE_X402_SIGNER` at the
OWS signer; until then, OWS provides identity + the policy gate, and the signing primitive must
be the hook or `ows pay request`. The policy engine likewise needs to be invoked at the signing
boundary to enforce AC-WAL-2 on a live payment.

## Spend ceiling + failure handling

The same guardrails as the other rails apply: `UNBROWSE_X402_MAX_COST_USD` (default `1.00`) caps
any single 402 (`x402_cost_exceeded` over it, no payment), and the negative-cache layer
(`src/values/failure-cache.ts`) records dead/blocked payment endpoints so a known-dead provider
is skipped until its class-TTL cooldown expires rather than re-attempted every call.

## Choosing the rail

`unbrowse payment-provider` re-prompts which wallet rail settles paid calls. OWS is the
open-standard primary; lobster.cash and pay.sh are the supported vendor rails. See also
[docs/lobster-cash-integration.md](./lobster-cash-integration.md) and
[docs/pay-sh-integration.md](./pay-sh-integration.md).

For the user-facing concept guide (the "why OWS" + policy examples), see
[ows.md](./ows.md).
