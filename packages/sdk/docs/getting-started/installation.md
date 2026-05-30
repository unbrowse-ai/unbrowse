# Installation

## Prerequisites

- Node >= 20
- A running Unbrowse runtime: either local (`unbrowse setup`) or a remote one you control.

## Install

```bash
npm install @unbrowse/sdk
# or
bun add @unbrowse/sdk
# or
pnpm add @unbrowse/sdk
```

## Start the runtime

```bash
npx unbrowse setup
```

The runtime auto-starts on demand at `http://localhost:6969` whenever an SDK or CLI call needs it. There is no separate `server start` command.

## Verify

```ts
import { Unbrowse } from "@unbrowse/sdk";

const u = new Unbrowse();
console.log(await u.health());
// { status: "ok", package_version: "6.9.x", code_hash: "...", pid: 12345 }
```

## Configuration

| Option | Env var | Default | Notes |
|---|---|---|---|
| `baseUrl` | `UNBROWSE_URL` | `http://localhost:6969` | Point at a remote runtime if not local. |
| `apiKey` | `UNBROWSE_API_KEY` | none | Required for remote runtimes; auto-set by `unbrowse account --register`. |
| `clientId` | none | none | Per-worker tag for payout attribution. |
| `timeoutMs` | none | none | Default per-call timeout. |
| `fetch` | none | global `fetch` | Override for proxy/instrumentation. |
| `headers` | none | none | Extra default headers. |

## Next

- [Your first validator](./first-validator.md)
- [API: resolve](../api-reference/resolve.md)
