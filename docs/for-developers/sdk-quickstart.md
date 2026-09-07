# SDK Quickstart

`unbrowse/sdk` is the TypeScript client for the current Unbrowse contract: one
typed-hole request from intent plus optional URL/params/approval. It runs in browsers, edge
runtimes, and Node.

```bash
npm i unbrowse
```

## Web3-native auth (preferred)

The credential root is a wallet signature. Pass a `walletSigner` callback that
returns the three web3 auth headers (`X-Unbrowse-Wallet`, `X-Unbrowse-Auth-Ts`,
`X-Unbrowse-Signature`) and the backend authenticates the caller as
`wallet:<pk>` — a full principal, never key-gated. The unbrowse CLI ships a
ready signer at `src/lib/wallet-auth-headers.ts:mergedAuthHeaders` that reads
the local wallet at `~/.unbrowse/wallet.json`; external consumers wire their
own ed25519 signer (any lib that produces the headers will do).

```ts
import { createHole, mergedAuthHeaders } from "unbrowse/sdk";

const hole = createHole({
  client: { walletSigner: mergedAuthHeaders },
});

const result = await hole.fill({
  intent: "list tomorrow's events",
  url: "https://calendar.google.com",
});
```

## Deprecated web2 wrapper (account-bound flows only)

If you still need payouts accrual / dashboard sync / ToS surface tied to an
email account, layer a `ubr_` api-key over the wallet. A wallet-only caller
is already a full principal — the key is ONLY for account-bound continuity
and will be retired.

```ts
import { createHole, mergedAuthHeaders } from "unbrowse/sdk";

const hole = createHole({
  client: { walletSigner: mergedAuthHeaders, apiKey: process.env.UNBROWSE_API_KEY },
});
```

The shell equivalent is:

```bash
unbrowse "list tomorrow's events"
unbrowse "list tomorrow's events" --url "https://calendar.google.com"
```

Need to inspect route selection? The legacy `Unbrowse` client still exposes
`resolve`/`execute` for debugging and compatibility, but new agents should start
from `createHole().fill(...)`.

Reused routes can be priced. A paid call returns an HTTP 402 that the SDK raises as
a typed error you can catch and retry after settling payment; brand-new agents get a
sponsored allowance first. The same wallet that authenticates the request signs
the x402 payment envelope — "who you are" and "who pays" are the same handle.

The open/closed source split is described in the
[Open Source Notice](../OPEN-SOURCE-NOTICE.md).
