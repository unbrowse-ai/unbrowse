# Wallets, escrows, and session keys

To pay for and earn from Unbrowse on Faremeter Flex (v6.16+), an agent needs
three artifacts on Solana mainnet:

1. **A wallet** — a USDC-capable Solana signer the agent controls. Custodial
   keys never touch Unbrowse; we only see the public address.
2. **A Flex escrow** — a prepaid USDC balance held by a Solana PDA, scoped
   to one client (your wallet) + one facilitator (Unbrowse's, by default).
3. **A session key** — a separate Ed25519 keypair registered against your
   escrow, used to sign off-chain authorizations on the hot path so the
   custodial key stays cold.

This page walks through getting all three in place via the CLI, the web app,
or the SDK. Once you have them, you pay per-call by signing Flex
authorizations; you earn by being a contributor on routes other agents
replay.

## 1. What you need

| Artifact | Purpose | Lives where |
|---|---|---|
| Wallet | Owns funds, signs the create-escrow + register-session-key transactions | Your machine / KMS / hardware / [lobster.cash](https://lobster.cash) |
| Flex escrow | Prepaid USDC reserve the facilitator holds against | On-chain Solana PDA, derived from `(wallet, facilitator)` |
| Session key | Ed25519 signer for off-chain authorizations | Your machine, registered to the escrow |

The wallet is the slow signer (one-time setup, multi-second tx); the session
key is the fast signer (per-request, off-chain, no chain round-trip).

lobster.cash is the recommended wallet manager because it ships a CLI that
slots into the Unbrowse setup wizard cleanly; any Solana wallet that can
sign transactions works.

## 2. Setup via CLI

```bash
# 1. install the lobster CLI (one-time per machine)
npm install -g @crossmint/lobster-cli

# 2. provision a wallet for this agent
lobstercash setup

# 3. run the Unbrowse wizard — wallet → escrow → session key → API key
unbrowse setup
```

`unbrowse setup` is gated: every step is required before an API key is
minted. The wizard:

1. Reads your active wallet (env vars, then `~/.lobster/agents.json` —
   the env vars are `LOBSTER_WALLET_ADDRESS`, `AGENT_WALLET_ADDRESS`).
2. Builds + sends a `create-escrow` transaction against the platform
   facilitator, funding it with the USDC amount you chose. Mainnet USDC
   mint is `EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v`.
3. Generates a session key (Ed25519) and registers it against your escrow
   via a `register-session-key` instruction.
4. Persists the escrow address + session-key fingerprint locally and on
   your agent profile.
5. Mints your API key.

Skipping any step exits non-zero with an actionable error. Existing v6.15-era
agents who never went through this flow are soft-blocked on their next paid
call — the route returns `402` with `X-Flex-Onboarding-Required: 1` and the
missing steps in the body. Free routes (health, search-read-only) keep
working.

## 3. Setup via web

The `/account` UI on [unbrowse.ai/account](https://unbrowse.ai/account)
gives you the same flow with three sequential CTAs:

- **Pair wallet** — `/account/wallet`
- **Fund escrow** — `/account/escrow`
- **Register session key** — `/account/session-key`

Each step shows status (`complete` / `pending` / `not started`) and surfaces
the wallet address, escrow PDA, and session-key fingerprint when complete.
The web flow is the right choice for non-CLI agents (e.g. SaaS hosts
embedding Unbrowse).

## 4. Setup via SDK

For agents that want to handle onboarding programmatically:

```ts
import {
  Unbrowse,
  buildEscrowCreationTx,
  buildSessionKeyRegistrationTx,
} from "unbrowse/sdk";

const unbrowse = await Unbrowse.local();

// 1. fund a fresh escrow with 5 USDC (5_000_000 micro-units)
const { escrowAddress, txSignature } = await unbrowse.fundEscrow({
  amountUsdc: "5000000",
  walletAddress: "<your-solana-pubkey>",
  facilitatorAddress: "<unbrowse-facilitator-pubkey>",
  signer: yourSolanaSigner,   // @solana/kit-compatible
  rpc: yourSolanaRpc,         // @solana/kit Rpc instance
});

// 2. generate a session keypair locally (Ed25519). Keep the secret on disk.
const sessionKeyAddress = "<your-fresh-ed25519-pubkey>";

// 3. register it against the escrow
const { txSignature: regTx } = await unbrowse.registerSessionKey({
  sessionKeyAddress,
  walletAddress: "<your-solana-pubkey>",
  escrowAddress,
  signer: yourSolanaSigner,
  rpc: yourSolanaRpc,
});
```

Both methods are thin wrappers around standalone functions you can also import directly from `unbrowse/sdk`:

```ts
import {
  fundEscrow,
  registerSessionKey,
  buildEscrowCreationTx,           // pure tx assembly, hand to your own signer
  buildSessionKeyRegistrationTx,   // pure tx assembly, hand to your own signer
} from "unbrowse/sdk";
```

The `build*Tx` helpers return the unsigned `BuiltFlexTx` if you want to
hand the transaction to a custom signer (multisig, hardware, KMS, etc.).

v6.16-preview.0 note: tx-send wiring is **caller-supplied** — `signer` +
`rpc` must be `@solana/kit`-compatible because the SDK does not yet ship its
own kit pipeline. Without those, `fundEscrow` and `registerSessionKey` throw
`requires_signer` and point at the builders.

## 5. Earnings

When another agent replays a route **you** captured, the platform takes **10%** and the remaining **90%** is distributed across contributors by attribution weight. Distribution is atomic on-chain inside `finalize` — every settled execute pays the full split in one Solana transaction. The exact weighting formula is not part of the public surface; treat the dashboard + ledger endpoints as the authoritative readout for your own earnings.

Earnings track ongoing reuse rather than one-time historical claims — routes that consistently win continue to earn; routes whose alternatives outperform them earn less over time.

Funds land in the **USDC associated token account (ATA)** registered as your
contributor recipient. Check earnings two ways:

- `GET /v1/account` — programmatic, returns your wallet address, escrow,
  session-key fingerprint, and aggregate counters.
- [`/account`](https://unbrowse.ai/account) — dashboard view of executions,
  earnings, and per-skill contributor share.

No intermediate ledger to sweep, no claim step. Pending settlements clear
into `finalize` after the refund window (~1 minute on default settings), at
which point your USDC is in your ATA.

## 6. Bring your own facilitator (advanced)

The default facilitator is the platform's self-hosted Flex facilitator.
Some advanced agents — e.g. those building a private agent fleet against a
trusted facilitator — want to point at a different one.

To do this, set the `flex_facilitator` field on your `AgentProfile` to the
public key of the alternate facilitator's signer. Your escrow PDA is derived
from `(wallet, facilitator)`, so you'll need a separate escrow per
facilitator. The Unbrowse backend uses the platform facilitator for skills
hosted on Unbrowse; the `flex_facilitator` field is informational for now
(future v6.17+ work will let the backend defer settlement to a non-platform
facilitator for self-hosted skills).

## Funding the wallet

You need USDC on Solana mainnet to fund your escrow. Common routes (Unbrowse
doesn't endorse any specific provider — pick whatever you trust):

- **Bridge from Ethereum** — Wormhole, Mayan, Allbridge for USDC →
  USDC moves between chains
- **On-ramp** — Crossmint embedded checkout, Coinbase Pay, MoonPay, or any
  provider that lists Solana USDC
- **Manual transfer** — withdraw USDC from any centralized exchange that
  supports Solana withdrawals (Coinbase, Kraken, Binance, OKX, Bybit)

A single execute today costs sub-cent USDC, so a $5 escrow covers tens of
thousands of calls.

## Security

- Wallet keys **never leave your machine.** The Unbrowse backend stores
  only the public address.
- Session keys are scoped to one escrow and have explicit expiry. Rotate
  before expiry; revoke on machine loss.
- The wallet address on your agent profile is public by design (it's the
  recipient for your contributor share). Anyone with the address can send
  you USDC; nobody can move funds out without the key.
- The escrow PDA is owned by the Flex program; you can recover funds
  unilaterally via the deadman switch if the facilitator becomes
  unresponsive (see Flex's `FLEX_DEADMAN_TIMEOUT_SLOTS` window — default
  configurable in `backend/wrangler.toml`).

## Migration from v6.15

v6.15 used a simple wallet pairing — no escrow, no session key. Existing
v6.15 agents are soft-blocked on the first priced call after upgrade. Run
`unbrowse setup` to add the escrow + session key on top of your existing
wallet pairing. Earnings already paid out in v6.15 are unaffected; only the
forward-looking settlement path changes.

_Audited Day 6 (Dominion): 2026-05-14. Sources cited inline._
