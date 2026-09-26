# Paper vs Product Status

This page maps the paper, *Internal APIs Are All You Need* (arXiv:2604.00694), to the hosted Unbrowse service that runs today.

Status meanings:

- `Shipped`: running in the hosted service, and its acceptance check is closed with evidence.
- `Shipped, check open`: running in the hosted service; its acceptance check is not yet closed.
- `Partial`: some of the claim exists, in a narrower or different form.
- `Changed`: the product solves the same problem a different way.
- `Not shipped`: described in the paper, not in the service.

The client in this repo is a thin transport. Every row below is service behavior.

## Capability layer

| Paper claim | Status | What exists today |
| --- | --- | --- |
| Agents should call first-party routes, not drive the DOM | Shipped | Learned capabilities replay over first-party HTTP. The browser is for discovery and for reads HTTP cannot finish. |
| Passive indexing from normal use | Shipped | The cloud browser records every session. `browse.finish` compiles it. The first request is fulfilled while indexing. |
| Learning from recorded traffic | Shipped | `unbrowse.learn` compiles HAR files or traces. Cross-session diffs find inputs; producer→consumer tracing binds tokens and ids. |
| Three paths: local cache, shared graph, browser fallback | Changed | Private space, then public registry, then the cloud browser. A render fallback covers reads HTTP cannot finish. The client keeps no local cache. |
| Shared route graph | Partial | A public registry of scrubbed, re-verified read-only capabilities (check open). It holds reads, not a general graph of writes. Multi-step flows live inside one capability's harness. |
| Intent resolution by composite score (embedding, reliability, freshness, verification) | Changed | Discover ranks and returns health hints (p50/p95, success rate, warm/rendered/cold). Jev picks among eligible candidates, with a deterministic fallback. No embedding-weighted formula. |
| Schema drift detection | Shipped | HTML where JSON was learned fails as `schema_or_auth_drift` and can fall back to rendering. A version-aware compatibility ledger excludes mismatched bindings until targeted revalidation. |
| Route lifecycle | Shipped | `observed` → `candidate` → `validated`, per package digest. |
| Periodic re-verification | Shipped, check open | Registry revalidation with fresh words; repeated failures unpublish. |
| "HTTP 200 is not success" | Shipped | `succeeded` requires an independently verified business outcome. |
| Per-route package (`SKILL.md`, `auth.json`, generated `api.ts`) | Partial | Each capability is `unbrowse/v1alpha1` harness YAML plus a SKILL.md. Each site is an MCP server and an OpenAPI 3.1 document (check open). No `auth.json` or generated `api.ts`. |
| MCP support | Shipped | Remote MCP at `/mcp`, an adapter over the same runs as REST `/api/v1`, which `@unbrowse/sdk` and the CLI in this repo call. |
| A2A / ANP protocol coverage | Not shipped | |

## Credentials

| Paper claim | Status | What exists today |
| --- | --- | --- |
| Credentials are never published | Shipped | The registry strips cookies, authorization and session values. Login-backed and write capabilities are never shared. |
| Local encrypted credential vault | Changed | The vault is server-side and envelope-encrypted per workspace (shipped). A zero-knowledge Private vault, decryptable only in the owner's browser, is the newest piece (check open). |
| Auth reuse across runs | Shipped, check open | Auto sign-in on replay, cached sessions, login step skipped on later runs. |

## Economic layer

| Paper claim | Status | What exists today |
| --- | --- | --- |
| Adoption condition: route fee below rediscovery cost | Not shipped | Pricing is one flat meter, not priced per route. |
| Metered usage | Shipped | 500 verified calls a month free, then $10 per 10,000. Only verified successes bill. |
| HTTP 402 handshake and x402 settlement | Shipped, check open | x402 v2, USDC on Base, $0.001 per call, settles only on success. No account needed. |
| Solana settlement | Not shipped | x402 runs on Base. |
| Route-level pricing | Not shipped | |
| Fee splits across contributors, maintainers, infra, treasury | Not shipped | |
| Contributor payouts and delta-based attribution | Not shipped | Auto-shared routes carry no payout. |
| Site-owner compensation | Not shipped | |
| Dynamic pricing by savings and trust | Not shipped | |

## Trust and validation

| Paper claim | Status | What exists today |
| --- | --- | --- |
| Run history drives trust | Shipped | Health from each capability's run ledger shows in discover hints. |
| Pre-publish quality gate | Shipped, check open | A scrubbed copy must answer two probe words and one unseen word, fail a nonsense query, and do so without cookies. |
| Broken public tools are hidden | Shipped, check open | Discover withholds failing public tools unless the query names the site, and reports how many it withheld. |
| Signed feedback, validator attestations | Not shipped | |
| Independent validator markets | Not shipped | |
| E2B sandbox validation | Not shipped | |
| TEE attestation | Not shipped | |

## Benchmarks

| Paper claim | Status | Notes |
| --- | --- | --- |
| 94-domain benchmark: 3.6x mean / 5.4x median speedup on warmed routes vs Playwright | Paper result | Not re-run against the current service. |
| 90–96% per-task cost reduction for warmed-cache execution | Paper result | Not re-run. |
| ~8,000 DOM tokens down to ~200 JSON tokens on typical reads | Paper result | Not re-run. |
| Warm replay much faster than browsing | Shipped (own eval) | The service's production lean eval measured median warm replay at 5.4% of median browse time on its demo site. See [Evaluation](./evaluation.md). |

## Read this as

- The paper's core thesis (first-party routes, learn once, replay over HTTP) is what the service does.
- The shared-graph idea ships as a read-only public registry, still maturing.
- The route economy (per-route prices, splits, payouts) and the cryptographic trust layer do not exist. Billing is a flat meter plus x402 pay-per-call.
