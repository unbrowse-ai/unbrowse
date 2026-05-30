# @unbrowse/sdk Documentation

Thin TypeScript SDK for the Unbrowse local server. Wraps `http://localhost:6969` (or a remote runtime) with type-safe helpers.

## Sections

- [Getting started](./getting-started/installation.md)
  - [Installation](./getting-started/installation.md)
  - [Your first validator](./getting-started/first-validator.md)
  - [Pairing a wallet](./payments/wallets.md)
- [API reference](./api-reference/README.md)
  - [`resolve`](./api-reference/resolve.md)
  - [`execute`](./api-reference/execute.md)
  - [Auth (`login`, `importAuth`)](./api-reference/auth.md)
  - [Earnings & rewards](./api-reference/rewards.md)
- [Payments](./payments/quickstart.md)
  - [Quickstart](./payments/quickstart.md)
  - [Wallets](./payments/wallets.md)
  - [Sponsor mode](./payments/sponsor-mode.md)
  - [Errors](./payments/errors.md)
- [Examples](./examples/README.md)
  - [Swarm validator](./examples/swarm-validator.md)
  - [Login then mine](./examples/login-then-mine.md)
  - [Data extraction worker](./examples/data-extraction.md)

## Status

- License: MIT
- Source: `packages/sdk/src` (in this repo)
- Tracks: the local-server `/v1/*` HTTP surface

For the closed-source engine the SDK talks to, see the [Open Source Notice](../../../docs/OPEN-SOURCE-NOTICE.md).
