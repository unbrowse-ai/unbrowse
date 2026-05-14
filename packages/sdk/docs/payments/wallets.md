# Payments — Wallet contracts

This doc describes the SDK's wallet *interfaces*. For the user-facing onboarding flow (pair wallet → fund escrow → register session key) read [`docs/wallets.md`](../../../../docs/wallets.md) in the monorepo, or visit `/account/wallet` in the web app.

The SDK does not sign anything. It hands a typed payment requirement to a wallet you supply and attaches whatever string the wallet returns to the retry request as `X-PAYMENT`. Any wallet that can produce that string works.

## Two interfaces, two paths

### `FlexWalletLike` — v6.16 Flex (default for paid routes today)

From `packages/sdk/src/flex.ts`:

```ts
export interface FlexWalletLike {
  /** The wallet that owns the escrow PDA. */
  address: string;
  /** The Ed25519 session key registered against the escrow; signs authorizations off-chain. */
  sessionKeyAddress: string;
  /** Sign a Flex authorization and return the base64 signature for the X-PAYMENT envelope. */
  signFlexAuthorization(auth: FlexAuthorization): Promise<string>;
}
```

Use this when calling Unbrowse paid routes in v6.16. The wallet signs an Ed25519 authorization against the platform's Faremeter Flex program; the SDK packs the signature into a `FlexPaymentPayload` envelope and bases64s it into `X-PAYMENT`.

### `WalletLike` — generic x402 (legacy + chain-agnostic)

From `packages/sdk/src/x402.ts`:

```ts
export interface WalletLike {
  address: string;
  signX402Payload(req: X402PaymentRequirement): Promise<string>;
}
```

The generic interface for any x402 scheme. The SDK keeps this exported so callers integrating with non-Flex schemes (or older v6.15 routes) can still wire a wallet. For new code targeting v6.16 paid routes, use `FlexWalletLike`.

The SDK never sees private keys in either path.

## lobster.cash (recommended for local dev)

[lobster.cash](https://lobster.cash) is a minimal terminal wallet for x402 payments. It signs from a keypair stored in the OS keychain.

```bash
npm install -g @crossmint/lobster-cli
unbrowse setup        # pair lobster.cash to your agent profile
```

`unbrowse setup` invokes `npx @crossmint/lobster-cli setup`, which writes the active agent record to `~/.lobster/agents.json`. The SDK picks it up automatically when you call `Unbrowse.local()` because the runtime binary owns the wallet handle and signs server-side. From your code's perspective, paid calls just succeed — no `FlexWalletLike` to pass.

If you want to opt out of the runtime-managed wallet and sign in-process, construct a `FlexWalletLike` against lobster's programmatic API and pass it to `payAndRetryFlex`.

## Crossmint smart wallets

[Crossmint](https://www.crossmint.com) provides smart wallets for programmatic agents — gas abstraction, spending limits, signer rotation. Wire one up by implementing `FlexWalletLike` against the Crossmint server SDK. See Crossmint's own docs for the signing details; on the Unbrowse side, the integration surface is the three-field interface above.

## Custom wallet — minimal Solana adapter

Any wallet SDK that can produce an Ed25519 signature over a Flex authorization message can satisfy `FlexWalletLike`. Below is an *illustrative* adapter — treat it as a template, adapt to your wallet SDK:

```ts
import type { FlexWalletLike, FlexAuthorization } from "@unbrowse/sdk";

// Illustrative — adapt to your wallet SDK. Don't add `@solana/web3.js` to
// your prod deps unless you already use it.
function makeSolanaFlexWallet(signer: {
  publicKey: string;
  sessionKey: { publicKey: string; sign: (bytes: Uint8Array) => Promise<Uint8Array> };
}): FlexWalletLike {
  return {
    address: signer.publicKey,
    sessionKeyAddress: signer.sessionKey.publicKey,
    async signFlexAuthorization(auth: FlexAuthorization): Promise<string> {
      // Serialize the authorization to canonical bytes, sign with session key,
      // return base64. The Flex spec defines the exact serialization; the
      // @faremeter/flex-solana package provides `signPaymentAuthorization`
      // if you want to use it directly.
      const { signPaymentAuthorization } = await import("@faremeter/flex-solana");
      const sigBytes = await signPaymentAuthorization(auth, signer.sessionKey);
      return Buffer.from(sigBytes).toString("base64");
    },
  };
}
```

Once you have a `FlexWalletLike`, the call site looks identical regardless of which wallet it wraps:

```ts
import { Unbrowse, PaymentRequiredError, payAndRetryFlex } from "@unbrowse/sdk";

const u = await Unbrowse.local();
const wallet = makeSolanaFlexWallet(mySigner);

try {
  await u.execute("skill_paid_demo", { params: { q: "stripe receipts" } });
} catch (err) {
  if (err instanceof PaymentRequiredError) {
    await payAndRetryFlex(err, wallet, (header) =>
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

The backend settles in **USDC on Solana mainnet** (`X402_NETWORK_MODE = "mainnet"` in deployment config; USDC mint `EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v`). The exact accepted asset and chain are declared on every 402 response — read `accepts[].network` and `accepts[].asset` to confirm.

A few practical notes:

- Per-call amounts are small (`maxAmount` is typically $0.001 – $0.10), so chain-cheap settlement matters.
- Funding flow with v6.16 Flex: bridge USDC to your Solana wallet → run `unbrowse setup` to fund a Flex escrow → register a session key. Once those three steps are done, paid calls authorize against the escrow without further on-chain ops per request.
- Don't hard-code a chain in your code — read `accepts[]` and let your wallet pick the route it can sign on. EVM Flex is on Faremeter's roadmap; until then, v6.16 paid routes are Solana-only.

## What the SDK does NOT do

- **No signing.** All cryptography lives in the wallet you supply.
- **No on-ramp.** Funding the wallet is your job.
- **No multi-route negotiation.** `payAndRetryFlex` picks `accepts[0]`. If you want to negotiate (cheapest network, preferred token), implement your own loop over `error.accepts` before calling `wallet.signFlexAuthorization`.

See [`errors.md`](./errors.md) for the full error taxonomy and [`sponsor-mode.md`](./sponsor-mode.md) for when you can skip the wallet entirely.
