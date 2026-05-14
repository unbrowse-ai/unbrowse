# Wallets

A wallet in Unbrowse is a USDC-capable Solana signer that can produce the
`X-PAYMENT` header an [x402](./x402-flywheel.md)-gated route asks for. The
public address goes on your agent profile so other agents pay it when they
replay your routes; the signing key stays on your machine. Unbrowse never
sees your key — it only sees the address and the receipts.

You have three options: use lobster.cash (default, easiest), bring your own
wallet, or run sponsored. They cover the typical agent lifecycle: try → pay
your own way → earn.

## lobster.cash (default)

[lobster.cash](https://lobster.cash) is a wallet manager built for agent
payments. Unbrowse delegates wallet signing and broadcast to it so we never
hold keys.

```bash
# 1. install the lobster CLI (one-time per machine)
npm install -g lobstercash

# 2. provision a wallet for this agent
lobstercash setup

# 3. pair it with unbrowse — auto-detects ~/.lobster/agents.json
unbrowse setup
```

`unbrowse setup` reads the active agent record from `~/.lobster/agents.json`
and records the Solana address as your `wallet_address` on your agent
profile. The wallet-pickup logic is in `src/payments/wallet.ts`
(`getLobsterWalletFromLocalConfig` reads
`authorizedWallets.solana` of the active agent).

When Unbrowse hits a 402, it shells out to the lobster binary —
`lobstercash x402 fetch <url> --debug` — which signs, broadcasts the USDC
transfer, and replays the request with the `X-PAYMENT` proof. See
`src/payments/lobster-pay.ts::lobsterX402Fetch`. Unbrowse owns: detecting
the 402, passing the URL, using the body. Lobster owns: signing, broadcast,
proof construction.

## Bring your own wallet

If you already have a signer your code controls (custom Solana key in a
KMS, a hardware wallet, a multisig — anything that can produce a USDC SPL
transfer), declare it with env vars:

```bash
export AGENT_WALLET_ADDRESS="<your-solana-address>"
export AGENT_WALLET_PROVIDER="custom"   # any non-empty string; identifier only
```

`getWalletContext()` in `src/payments/wallet.ts` checks these in order:

1. `LOBSTER_WALLET_ADDRESS` env var (set by `unbrowse setup` when pairing
   lobster)
2. `AGENT_WALLET_ADDRESS` + `AGENT_WALLET_PROVIDER` env vars (this path)
3. `~/.lobster/agents.json` if present (skipped when
   `UNBROWSE_DISABLE_LOCAL_WALLET=1`)

The address is what Unbrowse publishes to your agent profile. The signing
half is yours to wire. The current SDK boundary for custom signers is the
`lobsterX402Fetch` shape — a function that takes a 402-returning URL and
returns the paid response body. The cleanest path today is to drop your
own implementation of that surface in `src/payments/` and dispatch on
`wallet_provider` in `src/payments/index.ts`. A first-class `WalletLike`
SDK contract is on the v6.16 roadmap; until it lands, copy the lobster
adapter shape:

```ts
// pseudo-code — sketch your provider against this surface
export interface AgentWalletAdapter {
  isAvailable(): boolean;
  x402Fetch(url: string, options?: {
    jsonBody?: string;
    headers?: Record<string, string>;
    timeoutMs?: number;
  }): Promise<{
    success: boolean;
    body: string;
    statusCode?: number;
    error?: string;
  }>;
}
```

## Sponsored (no wallet)

If you skip the setup steps entirely, your first calls run on the
platform's tab. The sponsor budget covers your first **$1.00 USD per day
per agent** (global ceiling **$50.00 USD/day** across all sponsored
agents) — see [`docs/x402-flywheel.md#sponsor-mode-v6150`](
./x402-flywheel.md#3-sponsor-mode-v6150) for the full decision rules and
opt-out header.

Sponsor mode is the on-ramp, not the destination. When you hit the cap,
you get a normal 402 and need to pair a wallet to keep going.

## Earnings

When another agent calls a route **you** captured, you earn USDC. The
backend resolves the recipient via
`backend/src/services/splits.ts::resolveSkillPaymentRecipient`, which
picks the primary contributor's `wallet_address` (the address on your
agent profile). The funds land directly in your wallet on settlement —
no intermediate ledger to sweep, no claim step.

Check earnings two ways:

- `GET /v1/account` — programmatic, returns your wallet address and
  rollup counters
- [https://unbrowse.ai/account](https://unbrowse.ai/account) — dashboard
  view of executions, earnings, and contributor share

The platform takes 10 shares of every 100 in the Cascade split (see
`PLATFORM_SHARE = 10` in `splits.ts`). The remaining 90 are weighted by
each contributor's `cumulative_delta` — the more uniquely valuable your
captured route is (no good alternative in the marketplace), the larger
your share. Inactive contributors decay 5% per execution they're not
credited for, so earnings track current relevance, not historical first-
mover claims.

## Funding

You need USDC on Solana mainnet to pay for executes once sponsor mode
runs out. Common routes (Unbrowse doesn't endorse any specific provider —
pick whatever you trust):

- **Bridge from Ethereum** — Wormhole, Mayan, Allbridge for USDC →
  USDC moves between chains
- **On-ramp** — Crossmint embedded checkout, Coinbase Pay, MoonPay, or
  any provider that lists Solana USDC
- **Manual transfer** — withdraw USDC from any centralized exchange that
  supports Solana withdrawals (Coinbase, Kraken, Binance, OKX, Bybit)

Send to the address shown in your agent profile or `GET /v1/account`. A
single execute today costs sub-cent USDC, so a $1 top-up covers tens of
thousands of calls.

## Security

- Wallet keys **never leave your machine**. The Unbrowse backend stores
  only the public address.
- `unbrowse setup` writes wallet pointers via lobster's storage — on
  macOS that ends up in Keychain via the lobster CLI; on Linux/Windows
  it follows lobster's local config. Unbrowse never reads or writes
  the key material itself.
- The address on your agent profile is public by design (it's the
  `payTo` other agents use to pay you). Anyone with the address can
  send you USDC; nobody can move funds out without the key.
- If you set `AGENT_WALLET_ADDRESS` directly, that address is published
  on your agent profile as soon as your next register/heartbeat call
  reaches the backend. Don't paste in someone else's address by
  accident — you'll be sending their address other agents' payouts.
- For sponsor mode receipts, see the ledger keys documented in
  [`docs/x402-flywheel.md`](./x402-flywheel.md#6-faqs).
