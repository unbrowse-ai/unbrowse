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

The shipped **CLI runs in-process** (no long-lived daemon). For SDK `Unbrowse.local()` / `spawn`, a binary runtime is attached or started as needed. Optional `unbrowse serve` exposes an HTTP facade for pairing or legacy HTTP clients — not required for normal CLI use.

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
| `baseUrl` | `UNBROWSE_URL` | (loopback when using `serve` / `connect`) | Only needed for explicit HTTP facade or remote runtime. |
| `apiKey` | `UNBROWSE_API_KEY` | none | Required for remote runtimes; auto-set by `unbrowse account --register`. |
| `clientId` | none | none | Per-worker tag for payout attribution. |
| `timeoutMs` | none | none | Default per-call timeout. |
| `fetch` | none | global `fetch` | Override for proxy/instrumentation. |
| `headers` | none | none | Extra default headers. |

## Next

- [Your first validator](./first-validator.md)
- [API: resolve](../api-reference/resolve.md)
