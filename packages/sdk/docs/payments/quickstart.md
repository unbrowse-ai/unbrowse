# Payments — Quickstart

The Unbrowse backend speaks [x402](https://x402.org): when a paid skill needs settlement, the server returns HTTP `402 Payment Required` with a JSON body listing acceptable payment routes under `accepts[]`. The agent picks one, signs it, and retries the same request with an `X-PAYMENT` header carrying the base64-encoded signed payload.

The SDK gives you three primitives:

- `PaymentRequiredError` — typed 402 with `error.accepts: X402PaymentRequirement[]`.
- `payAndRetry(error, wallet, retry)` — settle the error using your wallet, replay the call.
- `SponsorExhaustedError` — a subclass of the above, thrown when the platform sponsor wallet ran out for this agent today.

The three blocks below are the canonical paths.

## 1. Anonymous call (no wallet) — inspect the 402

If you call a paid skill without a wallet and without sponsor credit, you get a typed `PaymentRequiredError`. Read `accepts` to see what the resource costs.

```ts
import { Unbrowse, PaymentRequiredError } from "@unbrowse/sdk";

const u = await Unbrowse.local();

try {
  await u.execute("skill_paid_demo", { params: { ticker: "NVDA" } });
} catch (err) {
  if (err instanceof PaymentRequiredError) {
    console.log("Resource:", err.resourceUrl);
    console.log("Skill:", err.skillId);
    for (const opt of err.accepts) {
      console.log(
        `- ${opt.scheme} on ${opt.network}: ` +
          `${opt.maxAmountRequired} atomic units to ${opt.payTo}`,
      );
    }
  } else {
    throw err;
  }
}
```

The body the SDK parses looks like this (canonical x402 shape on v6.16+):

```json
{
  "error": "payment_required",
  "accepts": [
    {
      "scheme": "@faremeter/flex",
      "network": "solana-mainnet",
      "asset": "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
      "payTo": "<agent-escrow-pda>",
      "maxAmountRequired": "1000",
      "resource": "https://beta-api.unbrowse.ai/v1/skills/skill_paid_demo/execute",
      "mimeType": "application/json",
      "extra": { "flexAuthorizationDraft": { /* ... */ }, "programId": "..." }
    }
  ]
}
```

`maxAmountRequired` is in atomic units of the asset on the named `network` (e.g. `"1000"` of USDC = $0.001 at 6 decimals).

## 2. Pair a wallet, settle, retry

`payAndRetryFlex` takes a Flex-shaped wallet (or a v6.15 `WalletLike` for legacy `exact`-scheme routes), picks the first acceptable requirement, signs it, and replays the original request with `X-PAYMENT` attached.

```ts
import {
  Unbrowse,
  PaymentRequiredError,
  payAndRetryFlex,
} from "@unbrowse/sdk";

const u = await Unbrowse.local();
const wallet = await loadFlexWallet(); // your wallet impl — see wallets.md

async function paidExecute() {
  try {
    return await u.execute("skill_paid_demo", { params: { ticker: "NVDA" } });
  } catch (err) {
    if (err instanceof PaymentRequiredError) {
      return payAndRetryFlex(err, wallet, (paymentHeader) =>
        u.execute(
          "skill_paid_demo",
          { params: { ticker: "NVDA" } },
          { headers: { "X-PAYMENT": paymentHeader } },
        ),
      );
    }
    throw err;
  }
}

const result = await paidExecute();
console.log(result);
```

See [`wallets.md`](./wallets.md) for the wallet contract and reference integrations (lobster.cash, Crossmint, custom). Wallet + escrow + session-key setup is in [`../../../../docs/wallets.md`](../../../../docs/wallets.md).

## 3. Sponsored mode — no wallet needed for first calls

By default the Unbrowse platform sponsors a daily allowance of execute calls per agent before you need to fund a wallet. Your code does not change: paid skills just succeed. The response carries two headers:

- `X-Sponsored: <ledger_id>` — the settlement was paid by the platform.
- `X-Sponsor-Remaining-Usd: <number>` — how much sponsor credit you have left today.

```ts
import { Unbrowse } from "@unbrowse/sdk";

const u = await Unbrowse.local({ apiKey: process.env.UNBROWSE_API_KEY });

const result = await u.execute("skill_paid_demo", { params: { ticker: "NVDA" } });
console.log(result);

// Inspect remaining sponsor credit via the dashboard:
const dash = await u.dashboard();
console.log("sponsor:", dash); // includes spending + sponsor ledger entries
```

To read the per-response sponsor headers, use the lower-level `request` method and inspect the `Headers` on a custom `fetch`:

```ts
const u = await Unbrowse.local({
  fetch: async (url, init) => {
    const res = await fetch(url, init);
    const sponsored = res.headers.get("X-Sponsored");
    const remaining = res.headers.get("X-Sponsor-Remaining-Usd");
    if (sponsored) console.log("sponsored=", sponsored, "remaining=$", remaining);
    return res;
  },
});
```

When sponsor credit is exhausted, the SDK throws [`SponsorExhaustedError`](./errors.md). Pair a wallet and retry — see [`sponsor-mode.md`](./sponsor-mode.md) for the full lifecycle.
