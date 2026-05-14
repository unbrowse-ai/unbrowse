# Payments — Errors

Four error classes ship in v6.16. All extend `UnbrowseApiError`, so a single `catch (err)` block can be narrowed with `instanceof`.

## Error reference

| Class | Extends | When thrown | Fields | How to recover |
|---|---|---|---|---|
| `UnbrowseApiError` | `Error` | Any non-2xx from `/v1/*` that doesn't map to a more specific class. | `status: number`, `path: string`, `data: unknown`, `headers: Headers` | Inspect `status` and `data.error`. Retry or surface to the caller. |
| `PaymentRequiredError` | `UnbrowseApiError` | The backend returned `402 Payment Required` with a parsable `accepts[]`. | `accepts: X402PaymentRequirement[]`, `resourceUrl: string`, `skillId?: string` | Call `payAndRetry(err, wallet, retry)` to settle and replay. |
| `SponsorExhaustedError` | `PaymentRequiredError` | 402 + `X-Sponsor-Exhausted: 1`. The platform sponsor would have paid but its cap is hit. | + `reason: "agent_cap" \| "global_cap" \| "no_wallet"`, `remainingCreditUsd: number` | Pair a wallet and call `payAndRetry`. Identical recovery path to the parent. |
| `RuntimeUnavailableError` | `UnbrowseApiError` | The SDK could not locate, spawn, or reach a local `unbrowse` runtime. | `cause: "spawn_failed" \| "probe_failed" \| "binary_missing"`, `attemptedPort?: number` | `binary_missing` → install `unbrowse`. `spawn_failed` → check logs / port collision. `probe_failed` → adopt an existing runtime with `Unbrowse.connect(baseUrl)`. |

All four are exported from the package root:

```ts
import {
  UnbrowseApiError,
  PaymentRequiredError,
  SponsorExhaustedError,
  RuntimeUnavailableError,
} from "@unbrowse/sdk";
```

## Idiomatic catch ladders

### Sponsor → wallet → bubble

Order matters: `SponsorExhaustedError` is a *subclass* of `PaymentRequiredError`, so check it first.

```ts
import {
  Unbrowse,
  SponsorExhaustedError,
  PaymentRequiredError,
  RuntimeUnavailableError,
  payAndRetry,
} from "@unbrowse/sdk";

let u: Unbrowse;
try {
  u = await Unbrowse.local();
} catch (err) {
  if (err instanceof RuntimeUnavailableError) {
    if (err.cause === "binary_missing") {
      console.error("Install the runtime: npm i -g unbrowse");
    } else {
      console.error("Runtime spawn failed:", err.message);
    }
    process.exit(1);
  }
  throw err;
}
```

### The full ladder on a paid call

```ts
async function callPaidSkill() {
  try {
    return await u.execute("skill_paid_demo", { params: { ticker: "NVDA" } });
  } catch (err) {
    if (err instanceof SponsorExhaustedError) {
      console.log(
        `sponsor done (${err.reason}); remaining=$${err.remainingCreditUsd}`,
      );
      const wallet = await loadWallet();
      return payAndRetry(err, wallet, (header) =>
        u.execute(
          "skill_paid_demo",
          { params: { ticker: "NVDA" } },
          { headers: { "X-PAYMENT": header } },
        ),
      );
    }
    if (err instanceof PaymentRequiredError) {
      // Not sponsored at all. Wallet is required.
      const wallet = await loadWallet();
      return payAndRetry(err, wallet, (header) =>
        u.execute(
          "skill_paid_demo",
          { params: { ticker: "NVDA" } },
          { headers: { "X-PAYMENT": header } },
        ),
      );
    }
    if (err instanceof UnbrowseApiError) {
      console.error(`HTTP ${err.status} on ${err.path}:`, err.data);
    }
    throw err;
  }
}
```

## Notes on parsing

- `PaymentRequiredError.accepts` is built from either the canonical x402 shape (`{ accepts: [...] }`) or the Unbrowse-nested shape (`{ data: { accepts: [...] } }`). Both work; you don't need to know which one the backend used.
- `skillId` is populated from the response body if present, otherwise extracted from the request path (`/v1/skills/:skillId/execute`). It may be `undefined` for non-skill paid routes.
- `RuntimeUnavailableError.path` is set to `http://127.0.0.1:<port>` when a port was attempted, otherwise the literal string `"<runtime>"`. Use `attemptedPort` for the typed value.
- `payAndRetry` throws the original `error` unchanged if `error.accepts` is empty — there's nothing to sign. Treat that as "the resource is paid but offered no settlement route", which is a server bug worth reporting via `feedback`.
