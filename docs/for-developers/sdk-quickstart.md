# TypeScript SDK quickstart

The SDK ships with `unbrowse` 11.1.1. It works in Node 18+, browsers, and edge
runtimes with no runtime dependencies.

```bash
npm install unbrowse
```

## Authenticate

Create an account key with the CLI, then store it in your environment:

```bash
unbrowse register --email you@example.com
export UNBROWSE_API_KEY=ubr_...
```

The client reads `UNBROWSE_API_KEY` automatically. You can also pass `apiKey`
explicitly when different tenants use the same process.

```ts
import { Unbrowse } from "unbrowse/sdk";

const unbrowse = new Unbrowse();

const resolved = await unbrowse.resolve({
  intent: "find the newest TypeScript releases",
  contextUrl: "https://github.com/microsoft/TypeScript/releases",
});

const endpoint = resolved.available_operations?.[0];
if (!endpoint) throw new Error(resolved.next_step ?? "No matching route");

const result = await unbrowse.execute({
  endpoint_id: endpoint.endpoint_id,
});
```

## One-call hole API

For agents that do not need to inspect route selection, use the higher-level
hole API:

```ts
import { createHole } from "unbrowse/sdk";

const result = await createHole().fill({
  intent: "list tomorrow's events",
  url: "https://calendar.google.com",
});

console.log(result.answer ?? result.items);
```

## Credits

Usage is deducted from account credits through the normal account API. Read the
live balance from the account resource:

```ts
const credits = await unbrowse.account.credits();
console.log(credits.balance_uc / 1_000_000);
```

`balance_uc` uses micro-credit units: `1_000_000` equals one USD-denominated
credit. Earned credits remain in the ledger and may be redeemed when redemption
becomes available.

When a request costs more than the available balance, the SDK throws
`UnbrowseInsufficientCreditsError`.

```ts
import { UnbrowseInsufficientCreditsError } from "unbrowse/sdk";

try {
  await unbrowse.execute({ endpoint_id: endpoint.endpoint_id });
} catch (error) {
  if (error instanceof UnbrowseInsufficientCreditsError) {
    console.error("Add credits before retrying this request");
  }
  throw error;
}
```

All state-changing executes receive an idempotency key automatically, so a
network retry does not consume credits twice.
