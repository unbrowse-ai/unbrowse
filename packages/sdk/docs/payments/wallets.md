# Payments — Wallets

The SDK does not sign anything. It hands the `X402PaymentRequirement` to a wallet you supply and attaches whatever string the wallet returns to the retry request as `X-PAYMENT`. Any wallet that can produce that string works.

## The `WalletLike` contract

From `packages/sdk/src/x402.ts`:

```ts
export interface WalletLike {
  /** Public address used in `accepts[].payTo` matching when relevant. */
  address: string;
  /**
   * Sign the chosen payment requirement and return the base64-encoded
   * `X-PAYMENT` header value the SDK will attach to the retry request.
   */
  signX402Payload(req: X402PaymentRequirement): Promise<string>;
}
```

Two methods. `address` is used by some skills for `payTo` matching; `signX402Payload` does the cryptography and returns the header string. The SDK never sees private keys.

## lobster.cash (recommended for local dev)

[lobster.cash](https://lobster.cash) is a minimal terminal wallet for x402 payments. It signs from a keypair stored in the OS keychain.

```bash
npm install -g @crossmint/lobster-cli
unbrowse setup        # pair lobster.cash to your agent profile
```

`unbrowse setup` invokes `npx @crossmint/lobster-cli setup`, which writes the active agent record to `~/.lobster/agents.json`. The SDK picks it up automatically when you call `Unbrowse.local()` because the runtime binary owns the wallet handle and signs server-side. From your code's perspective, paid calls just succeed — no `WalletLike` to pass.

If you want to opt out of the runtime-managed wallet and sign in-process, construct a `WalletLike` against lobster's programmatic API and pass it to `payAndRetry`.

## Crossmint (production smart wallets)

[Crossmint](https://www.crossmint.com) provides EIP-4337 smart wallets for programmatic agents — gas abstraction, spending limits, signer rotation. Wire one up by implementing `WalletLike` against the Crossmint server SDK. See Crossmint's own docs for the signing details; on the Unbrowse side, the integration surface is the same two-method interface.

## Custom wallets — minimal adapter

Any wallet SDK that can produce an EIP-712 (EVM) or signed-message (Solana) blob can satisfy `WalletLike`. Below is an *illustrative* ethers-flavored adapter — treat it as a template, adapt to your wallet SDK:

```ts
import type { WalletLike, X402PaymentRequirement } from "@unbrowse/sdk";

// Illustrative — adapt to your wallet SDK. Don't add `ethers` to your prod
// deps unless you already use it.
function makeEvmWallet(signer: { address: string; signTypedData: Function }): WalletLike {
  return {
    address: signer.address,
    async signX402Payload(req: X402PaymentRequirement): Promise<string> {
      const domain = (req.extra?.domain ?? {}) as Record<string, unknown>;
      const types = (req.extra?.types ?? {}) as Record<string, unknown>;
      const value = {
        from: signer.address,
        to: req.payTo,
        value: req.maxAmountRequired,
        scheme: req.scheme,
      };
      const signature = await signer.signTypedData(domain, types, value);
      const payload = {
        x402Version: 1,
        scheme: req.scheme,
        network: req.network,
        payload: { signature, value },
      };
      return Buffer.from(JSON.stringify(payload)).toString("base64");
    },
  };
}
```

Once you have a `WalletLike`, the call site looks identical regardless of which wallet it wraps:

```ts
import { Unbrowse, PaymentRequiredError, payAndRetry } from "@unbrowse/sdk";

const u = await Unbrowse.local();
const wallet = makeEvmWallet(mySigner);

try {
  await u.execute("skill_paid_demo", { params: { q: "stripe receipts" } });
} catch (err) {
  if (err instanceof PaymentRequiredError) {
    await payAndRetry(err, wallet, (header) =>
      u.execute(
        "skill_paid_demo",
        { params: { q: "stripe receipts" } },
        { headers: { "X-PAYMENT": header } },
      ),
    );
  } else {
    throw err;
  }
}
```

## Funding the wallet

The backend defaults to **USDC on Solana mainnet** (`X402_NETWORK_MODE = "mainnet"` in `backend/wrangler.toml`; the `solana` chain config in `backend/src/middleware/x402-gate.ts::SUPPORTED_CHAINS` uses USDC mint `EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v`). The exact accepted asset and chain are declared on every 402 response — read `accepts[].network` and `accepts[].extra` for the token contract/mint address. Any USDC bridge or fiat on-ramp that delivers to the chains in your `accepts[]` list will work.

A few practical notes:

- The platform's settlement wallet is on the same chain as `accepts[0].network`, so a one-time on-ramp to that chain covers all skills priced on it.
- Per-call amounts are small (`maxAmountRequired` is typically $0.001 – $0.10), so prioritize a chain with cheap gas.
- Don't hard-code a chain in your code — read `accepts[]` and let your wallet pick the route it can sign on.

## What the SDK does NOT do

- **No signing.** All cryptography lives in the wallet you supply.
- **No on-ramp.** Funding the wallet is your job.
- **No multi-route negotiation.** `payAndRetry` picks `accepts[0]`. If you want to negotiate (cheapest network, preferred token), implement your own loop over `error.accepts` before calling `wallet.signX402Payload`.

See [`errors.md`](./errors.md) for the full error taxonomy and [`sponsor-mode.md`](./sponsor-mode.md) for when you can skip the wallet entirely.

_Audited Day 6 (Dominion): 2026-05-14_
