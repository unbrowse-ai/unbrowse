# For Technical Readers

The fastest way to understand the Unbrowse that runs today. Stricter than the paper.

## Positioning

Unbrowse is a browser engine and a compiler. It compiles a website's own requests into an API, and the API into tools.

The measured performance claims stay with their sources:

- The paper reports 3.6x mean and 5.4x median speedup on warmed routes versus Playwright across 94 domains, and 90–96% per-task cost reduction.
- The service's production lean evaluation measured median warm replay at 1,974 ms versus 36,723 ms median browse on its demo site. See [Evaluation](./evaluation.md).

Closest alternatives:

- Playwright / Puppeteer-style browser automation
- hand-written scrapers and one-off API reverse engineering
- teams keeping their own private route cache

## Architecture

**Client (this repo, open source).**

- `src/cli.ts`: the `unbrowse` CLI.
- `src/client.ts`: the REST client from the service's own codebase.
- `src/types.ts`, `src/mcp-install.ts`: its run types and MCP install helpers.
- `skill/SKILL.md`: the agent contract.

The client runs no browser and keeps no index.

**Hosted service (closed source).**

- Cloud browser: patchright, headful, recording every request, response, websocket frame, page and storage change.
- Learn loop: request families, cross-session diffs, producer→consumer bindings, outcome selection, harness compile.
- Replay: first-party HTTP, with a Chrome-fingerprint transport and clearance for bot challenges, a one-shot browser bootstrap for headers only the page can compute, and a render fallback.
- Routing: discover ranking with health hints; Jev picks among eligible candidates, deterministic fallback.
- Public registry: crawl and auto-share, publish gate, revalidation.
- Vault: server-sealed Agent vault and zero-knowledge Private vault.
- Metering: verified successes only; x402 pay-per-call.

## What a capability is

Not a saved URL. A capability is a harness: an ordered set of requests with:

- typed inputs, mid-run choices and optional parameters
- bindings from each token and id to the response that produced it
- guards and an independent outcome check
- a lifecycle (`observed`, `candidate`, `validated`) per package digest

It is stored as `unbrowse/v1alpha1` YAML and executed as a typed form. Compiled packages hold placeholders, never captured session values.

## Correctness rules worth knowing

- `succeeded` requires a verified business outcome. HTTP 200 is not enough.
- A dispatched write is never re-sent. A lost response is `outcome_unknown`.
- Reads may replay a last observed value for an unexplained field; writes never guess.
- A 200 bot page is a challenge, not a result.
- Changing an upstream input invalidates what depends on it; stale options are rejected.
- A typed value that no request carried means nothing is indexed (`typed_input_unused`).

## Surfaces

- Remote MCP at `/mcp`, Streamable HTTP.
- REST at `/api/v1`: runs, learn, learned capabilities, usage, sites, vault references.
- Each compiled site: `/api/v1/sites/<host>/mcp` and `/api/v1/sites/<host>/openapi.json`.
- Auth: API key or OAuth 2.1 with PKCE. The principal decides the workspace.

## Where it stands

Shipped and closed in the service's acceptance ledger: the learn loop, cloud browser, HTTP replay, challenge handling, render fallback, per-user durable storage, Jev routing, metering, discover hints.

Running with acceptance checks open: public registry, per-site tools, password manager, auto sign-in, session reuse, x402, OAuth for MCP, the zero-knowledge Private vault.

Not built: per-route pricing, payouts, validator markets, attestation.

See [System Today](./system-today.md) and [Paper vs Product Status](./paper-vs-product.md).
