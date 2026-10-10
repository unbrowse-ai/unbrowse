# Public Registry and Maintenance

Unbrowse starts with a simple fact:

- one agent learns a route
- later agents reuse it
- reuse beats browsing again on speed, cost and failure rate

Once routes are shared, they need upkeep. A saved route is only worth something if the next agent can trust it.

## Two spaces

**Private space.** Everything a workspace has learned or connected: public sites and passworded apps. It is searched first. Nothing in it is visible to anyone else unless it qualifies for sharing (below).

**Public registry.** Pre-indexed site capabilities any workspace can discover and run, named `public.<host>.<goal>`. A caller's runs, usage and session cache stay in the caller's workspace. Health is shared.

## How entries get in

Two ways:

1. **Crawl.** The service's indexer walks site lists. Per site it checks robots.txt, probes the site's own search over HTTP (OpenSearch descriptions, GET search forms), falls back to a browser driver, and learns page reads. Every site ends in a named outcome.
2. **Auto-share.** When a user runs a read-only, secretless capability on a public host, it is scrubbed and published. The user's own values are dropped. The owner can opt out. Logins, secret-carrying and write capabilities are never shared.

## The publish gate

Only read-only, secretless, one-input lookups publish. Before publishing, a scrubbed copy with no cookies must:

- answer two probe words
- answer one word it has never seen, and show it
- fail a nonsense query

Stored entries have cookies, authorization and session values stripped.

## Keeping entries true

- A revalidation pass re-runs public capabilities with fresh words and records the result.
- A tool whose latest real run failed is checked first.
- Repeated failures unpublish it.
- Discover leaves out public tools whose recent runs fail, unless the query names their site, and says how many it withheld.
- Discover hints show health, warm/rendered/cold, p50/p95 latency and success rate from real runs.

## Every entry is a tool

Each compiled site is its own MCP server (`/api/v1/sites/<host>/mcp`) and OpenAPI 3.1 document (`/api/v1/sites/<host>/openapi.json`). Tools carry input and output schemas. An agent can install one site as an MCP server, or search across all of them through `unbrowse_discover`.

## What the registry is not

- Not a marketplace with per-route prices. Calls bill on the same flat meter as any run.
- Not attributed. Contributors and maintainers are not tracked or paid.
- Not a store of writes or logins. It holds reads only.

The paper's roles (contributors, maintainers, validators, infrastructure) describe how a shared route graph could be run and paid for. Today the service plays all of them itself. See [Coming Soon](./coming-soon.md).

## Status

The registry, crawl, auto-share, revalidation and per-site tools are running. Their acceptance checks are open. The registry's own reliability bar is not met yet: see [Evaluation](./evaluation.md).
