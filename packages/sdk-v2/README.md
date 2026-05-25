# @unbrowse/client

Thin HTTP-first SDK for the Unbrowse API. Browser + Node 18+. Zero runtime dependencies.

> This is the v7 successor to `@unbrowse/sdk` (which still publishes the v6 binary-spawn client for legacy users). New code should use `@unbrowse/client`; existing v6 users keep working unchanged until they migrate.

## Install

```bash
npm i @unbrowse/client
```

## Quickstart (3 lines)

```ts
import { Unbrowse } from "@unbrowse/client";

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

## Worker-side fetch + IProyal residential proxy

Browsers, edge runtimes, and any context where direct outbound fetches would expose the user IP or hit geo/anti-bot blocks should route through the worker:

```ts
// Low-level: ask the worker to fetch a URL on your behalf.
const r = await unbrowse.proxy.fetch({
  url: "https://www.reddit.com/r/singularity/top.json",
  method: "GET",
});
// r.status, r.headers, r.body, r.proxy_used, r.duration_ms

// Route through IProyal residential proxy so the request egresses from a residential IP.
const r2 = await unbrowse.proxy.fetch({
  url: "https://geo-fenced.example.com/api/data",
  proxy: "residential",
});

// Check whether residential mode is configured before requesting it.
const caps = await unbrowse.proxy.capabilities();
// { modes: ["direct", "residential"], residential_configured: true, ... }
```

`execute()` accepts `transport: "worker-proxy" | "direct"` and `proxy: "direct" | "residential"` so any captured endpoint can be routed the same way.

## Resources

```ts
await unbrowse.account.me();             // user_id, email, email_verified, created_at
await unbrowse.account.credits();        // balance_usd, used_usd, granted_usd
await unbrowse.account.sponsorStatus();  // daily sponsor remaining (per-agent + global)

await unbrowse.keys.list();              // { keys: ApiKey[] } with funding
await unbrowse.keys.create({ name: "prod" });
// → { keyId, key (plaintext, ONCE), name, created_at, message }
await unbrowse.keys.revoke(keyId);
await unbrowse.keys.rotate(keyId);       // revokes old, returns new key plaintext
```

> Key-management endpoints (`/v1/account/keys`) authenticate via the magic-link cookie session, not bearer API key. Sign in at the dashboard once to mint your first key; after that, `new Unbrowse({ apiKey })` covers every other call.

## Errors

Every error inherits from `UnbrowseError`. Typed for easy handling:

```ts
import { Unbrowse, UnbrowseRateLimitError, UnbrowsePaymentRequiredError } from "@unbrowse/client";

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

## Local runtime capture (advanced)

Most users do not need this. If you specifically need a local browser session for a new domain the marketplace does not yet cover, use the legacy local-runtime package:

```bash
npm i @unbrowse/local
```

```ts
import { spawnUnbrowseRuntime } from "@unbrowse/local";
// pre-v7 binary-spawn API preserved here
```

The default `@unbrowse/client` package has no local-runtime dependency and runs in browsers + edge runtimes.

## Stability

- v7.x: this thin HTTP-first surface.
- v6.x: legacy binary-spawn SDK; receives security fixes only through 2026-12-31.
