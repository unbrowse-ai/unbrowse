# @unbrowse/sdk

Thin HTTP-first SDK for the Unbrowse API. Browser + Node 18+. Zero runtime dependencies.

## Install

```bash
npm i @unbrowse/sdk
```

## Quickstart (3 lines)

```ts
import { Unbrowse } from "@unbrowse/sdk";

const unbrowse = new Unbrowse({ apiKey: process.env.UNBROWSE_API_KEY });
const result = await unbrowse.resolve({ intent: "search hackernews for AI agent papers" });
```

## What you get back

```ts
const result = await unbrowse.resolve({ intent: "..." });
// result.available_operations: AvailableEndpoint[]
// result.status: "ok" | "empty" | "browse_session_open" | "auth_required" | "no_cached_match"
// result._request_id: pass to support if anything looks off

const data = await unbrowse.execute({
  endpoint_id: result.available_operations![0].endpoint_id,
  params: { q: "agents" },
});
// data.success, data.data, data.status_code, data._request_id
```

## Resources

```ts
await unbrowse.account.usage();         // your daily spend + cap
await unbrowse.account.sponsorStatus(); // sponsor wallet status (Lewis-subsidized tier)
await unbrowse.keys.list();             // your API keys
await unbrowse.keys.create({ name: "prod" }); // returns { plaintext } once
await unbrowse.keys.revoke(keyId);
```

## Errors

Every error inherits from `UnbrowseError`. Typed for easy handling:

```ts
import { Unbrowse, UnbrowseRateLimitError, UnbrowsePaymentRequiredError } from "@unbrowse/sdk";

try {
  await unbrowse.resolve({ intent });
} catch (e) {
  if (e instanceof UnbrowseRateLimitError) {
    console.log(`rate limited, retry after ${e.retry_after_ms}ms`);
  } else if (e instanceof UnbrowsePaymentRequiredError) {
    // sponsor cap exhausted; e.body has x402 payment requirements
    console.log("top up wallet:", e.body);
  } else {
    throw e;
  }
}
```

The hierarchy:

```
UnbrowseError
├─ UnbrowseAPIError          (any 4xx/5xx)
│  ├─ UnbrowseAuthenticationError   (401)
│  ├─ UnbrowsePaymentRequiredError  (402, x402 hint)
│  ├─ UnbrowsePermissionError       (403)
│  ├─ UnbrowseNotFoundError         (404)
│  ├─ UnbrowseBadRequestError       (400)
│  ├─ UnbrowseRateLimitError        (429, carries retry_after_ms)
│  └─ UnbrowseServerError           (5xx)
└─ UnbrowseConnectionError   (network)
   └─ UnbrowseTimeoutError
```

## Configuration

```ts
new Unbrowse({
  apiKey: "ubr_live_...",         // or env UNBROWSE_API_KEY
  baseURL: "https://beta-api.unbrowse.ai", // or env UNBROWSE_BASE_URL
  timeout: 60_000,                 // ms
  maxRetries: 2,                   // exponential backoff with jitter on 429 / 5xx / network
  fetch: customFetch,              // inject your own (tracing, mocking)
  defaultHeaders: { "x-custom": "..." },
  logLevel: "debug",               // or env UNBROWSE_LOG
});
```

## On-device kuri (advanced)

Most users do not need this. If you specifically need to run the local Kuri browser binary on a developer machine (capturing traffic for a new domain that the marketplace does not yet cover), install the separate runtime:

```bash
npm i @unbrowse/local
```

```ts
import { spawnUnbrowseRuntime } from "@unbrowse/local";
// pre-v7 binary-spawn API preserved here
```

The default `@unbrowse/sdk` package has no Kuri dependency and runs in browsers + edge runtimes.

## Stability

- v7.x: this thin HTTP-first surface.
- v6.x: legacy binary-spawn SDK; receives security fixes only through 2026-12-31.
