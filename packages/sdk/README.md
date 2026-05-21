# @unbrowse/sdk (v6 legacy)

TypeScript SDK for Unbrowse — the local agent browser that spawns the `unbrowse` binary and talks to it over a local Unix socket.

> **For new code, use [`@unbrowse/client`](../sdk-v2/) instead.** It is a thin HTTP-first SDK that hits `beta-api.unbrowse.ai` directly, runs in browsers + edge runtimes, has zero runtime deps, and never spawns a binary. This v6 package stays published and supported for users who specifically need the local-binary path (passive HAR capture against new domains the marketplace hasn't covered yet).

The SDK auto-spawns the `unbrowse` binary if it isn't already running, so a single `await Unbrowse.local()` is all you need to go from `npm install` to your first resolve.

Current version: **6.16.0-preview.0**.

> The SDK (this package) is MIT-licensed. The `unbrowse` runtime binary it talks to is distributed via npm. See [`OPEN-SOURCE-NOTICE.md`](../../docs/OPEN-SOURCE-NOTICE.md).
## Install

```bash
npm install @unbrowse/sdk
```

The SDK ships the spawn path lazily — `Unbrowse.connect()` callers never pull `child_process`, so it stays tree-shakeable in serverless and edge bundles.

## Quick start

```ts
import { Unbrowse } from "@unbrowse/sdk";

const u = await Unbrowse.local();
const r = await u.resolve({ intent: "list tomorrow's events", url: "https://calendar.google.com" });
console.log(r.result);
```

That's it — `Unbrowse.local()` probes `127.0.0.1:6969`, connects if a daemon is alive, and spawns the `unbrowse` CLI as a child process if not. The spawned daemon's lifecycle is owned by your process; it shuts down cleanly on exit.

## Three factories, three lifecycles

```ts
// 1. Common case — probe then spawn. The right answer 95% of the time.
const u = await Unbrowse.local();

// 2. External daemon already running (Docker, sidecar, dev server).
const u = await Unbrowse.connect("http://localhost:6969");

// 3. Always spawn fresh — owned lifecycle, useful for tests and isolated workers.
const u = await Unbrowse.spawn({ port: 7969 });
```

All three return the same `Unbrowse` client interface. Pass `{ apiKey }` to any factory to override the auto-generated marketplace key.

## Resolve and execute

```ts
const resolved = await u.resolve({
  intent: "get feed posts",
  url: "https://news.ycombinator.com",
});

// Re-run later with explicit projection
const rerun = await u.execute(resolved, { projection: { raw: true } });

// Or by skill id, with params
const quote = await u.execute("skill_123", { params: { symbol: "NVDA" } });
```

## Payments

Unbrowse routes monetize on use via [x402](https://www.x402.org). Every paid execute (priced skills, `search`, `resolve` over a priced shortlist) is gated by a `402 Payment Required` flow. The SDK turns that into a typed error you can catch and retry. v6.16 settles on [Faremeter Flex](https://docs.faremeter.xyz/flex/overview) — your wallet signs an off-chain authorization with a session key, the facilitator settles on-chain in batches, and splits to contributors land atomically.

```ts
import { Unbrowse, PaymentRequiredError, payAndRetryFlex } from "@unbrowse/sdk";

try {
  await u.execute("skill_premium_123", { params: { ticker: "NVDA" } });
} catch (err) {
  if (err instanceof PaymentRequiredError) {
    await payAndRetryFlex(err, wallet, (header) =>
      u.execute(
        "skill_premium_123",
        { params: { ticker: "NVDA" } },
        { headers: { "X-PAYMENT": header } },
      ),
    ); // signs the Flex authorization, retries with proof attached
  }
}
```

`PaymentRequiredError` is thrown at the HTTP-parser layer and carries `accepts[]` — the canonical x402 terms array. `payAndRetryFlex(error, wallet, retry)` is a free function exported from `@unbrowse/sdk`; it picks `accepts[0]`, has your session key sign it, and calls your `retry(paymentHeader)` to replay the original request with `X-PAYMENT` attached.

For metered routes there's a higher-level helper that handles the catch + retry for you:

```ts
const result = await u.executeMetered<{ data: string; usage_units: number }>(
  "skill_id",
  input,
  { wallet, onUsage: (units) => console.log("consumed", units, "units") },
);
```

### Sponsor mode — first calls covered by the platform

Brand-new agents get a daily allowance of platform-sponsored execute calls before they need to fund a wallet, so creators start earning USDC the moment their captured routes are reused. Sponsored responses include `X-Sponsored: <ledger_id>`.

When the daily allowance is exhausted you get `SponsorExhaustedError` — pair a wallet and switch to `payAndRetryFlex`. Opt out per-request by passing `{ headers: { "X-No-Sponsor": "1" } }` if you'd rather pay yourself from the first call.

Full payment docs and worked examples: [`docs/payments/`](./docs/payments/). Wallet + escrow + session-key setup: [`../../docs/wallets.md`](../../docs/wallets.md). Upgrading from v6.15's `exact`-scheme integration: [`../../docs/x402-flex-migration.md`](../../docs/x402-flex-migration.md).

## Auth

```ts
// Interactive login — opens a real browser window for first-time auth.
await u.login({ url: "https://calendar.google.com" });

// Or import cookies from your local browser storage.
await u.importAuth({ url: "https://x.com/home", browser: "auto" });
```

## Search

```ts
const global = await u.search({ intent: "get stock prices", k: 5 });

const domain = await u.searchDomain({
  intent: "find trending repositories",
  domain: "github.com",
  k: 3,
});
```

## Error handling

```ts
import { Unbrowse, UnbrowseApiError } from "@unbrowse/sdk";

try {
  await u.resolve({ intent: "get inbox", url: "https://mail.google.com" });
} catch (err) {
  if (err instanceof UnbrowseApiError) {
    console.error(err.status, err.path, err.data);
  }
  throw err;
}
```

`UnbrowseApiError` is the generic wrapper. `PaymentRequiredError` and `SponsorExhaustedError` are payment-specific subclasses; both expose `accepts[]` so you can introspect what the gate wants.

## Notes

- Default `baseUrl` is `http://localhost:6969`. `Unbrowse.local()` picks this up automatically.
- Default `apiKey` reads from `UNBROWSE_API_KEY` when present.
- `resolve({ url })` maps the URL into both `params.url` and `context.url`, matching the CLI path.
- Response types are strongest on inputs and core trace/skill metadata, lighter on payload bodies, because endpoint payload shape varies by site.

## More

- Complete docs: [`docs/`](./docs/)
- Use case recipes: [`docs/examples/`](./docs/examples/)
- API reference: [`docs/api-reference/`](./docs/api-reference/)
- Payment surface: [`docs/payments/`](./docs/payments/)

_Audited Day 6 (Dominion): 2026-05-14_
