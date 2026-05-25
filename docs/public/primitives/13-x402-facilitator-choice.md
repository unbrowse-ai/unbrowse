# x402 facilitator choice

## The rule

Unbrowse paid execute uses x402 (HTTP 402 Payment Required) for per-call settlement. The facilitator is configurable via `UNBROWSE_X402_FACILITATOR`; the default is PayAI. The choice is operator-pluggable, never baked, so a facilitator outage or a wallet-compatibility mismatch is one env var away from being fixed.

## What x402 is and isn't

x402 is an open HTTP payment protocol from Coinbase, standardised by the x402 Foundation (Coinbase + Cloudflare, September 2025). The protocol is provider-neutral: the server returns `402 Payment Required` with payment requirements; the client picks a facilitator that supports the named scheme + network and settles the payment; the server verifies the settlement proof and serves the resource.

Unbrowse never holds the facilitator's keys, never custodies the buyer's funds, and never decides which facilitator a buyer must use. The protocol does the gating; the facilitator does the settlement.

## Production-ready facilitator options

| Facilitator | URL | Networks (mainnet) | Auth | Fees | Notes |
|---|---|---|---|---|---|
| **x402.rs** | `https://facilitator.x402.rs/` | Base, Solana, Avalanche, Polygon, Sei, XDC | None | None | Rust-built, no API key, supports both EOA and smart-wallet settlement. Recommended free default for self-hosted setups. |
| **Coinbase CDP** | `https://api.cdp.coinbase.com/platform/v2/x402` | Base, Polygon, Arbitrum, World, Solana | CDP API keys | 1k tx/mo free, then $0.001/tx | Battle-tested; gas sponsorship on Base + Solana; required for the agentic-wallets infra. |
| **PayAI** (default) | `https://facilitator.payai.network` | Base, Solana | None | None published | Solana-optimised; default for `UNBROWSE_X402_FACILITATOR` because it requires zero buyer-side signup. |
| **Thirdweb Solana** | `https://portal.thirdweb.com/x402/facilitator/solana` | Solana | None | None | SPL token settlement, EIP-3009 equivalent. |
| **second-state self-host** | `https://github.com/second-state/x402-facilitator` | Pluggable | Operator's choice | Operator's choice | Run your own when none of the hosted ones meet your latency or compliance needs. |

The x402.org sandbox at `https://x402.org/facilitator` is testnet-only and exists for the welcome quickstart; it is not a production endpoint.

## When to switch

| Symptom | Likely cause | First action |
|---|---|---|
| `no applicable payers found` / smart-wallet rejection | facilitator's settlement mode doesn't match the buyer's wallet shape | Set `UNBROWSE_X402_FACILITATOR=https://facilitator.x402.rs/` and retry — x402.rs accepts both EOA and smart-wallet settlement modes. |
| 5xx from facilitator | hosted facilitator outage | Swap to another from the table above; fail-over is one env var. |
| Compliance / KYC requirement | regulated buyer who needs an audited path | Coinbase CDP — issues TEE-backed agentic wallets and KYC's the buyer at sign-up. |
| Latency budget < 100ms on Solana | shared facilitator queueing | self-host x402-facilitator (second-state) co-located with your relayer. |

## Splits (Cascade)

Multi-recipient revenue routing — the case where one paid resolve splits across the indexer, the domain owner, and the Unbrowse platform — uses [Cascade Splits](https://cascade.fyi/) (`@cascade-fyi/splits-sdk`, already in `packages/skill/package.json`). Cascade is the x402-native splitter on Solana; the recipient on the 402 challenge is the splitter contract, which fans the USDC into the per-recipient shares atomically.

The fair-split mechanics + the global-hold wallet for unclaimed domain shares are documented at [07-fair-split-and-claim](./07-fair-split-and-claim.md). The facilitator choice here is upstream of that: the facilitator does the buyer-to-splitter transfer; Cascade does the splitter-to-recipients fan-out.

## What this rules out

- Hardcoding any single facilitator URL into source code. The env var is the only seam.
- Custodying buyer funds. Unbrowse never touches the buyer's wallet; the facilitator does the transfer.
- Inventing a new payment protocol. x402 IS the protocol; the choice is which facilitator implements it.
- Tying paid execute to a specific buyer wallet provider. Any facilitator that supports the buyer's wallet shape works.
