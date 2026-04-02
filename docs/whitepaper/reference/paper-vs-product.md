# Paper vs. Product

An honest audit of claims made in "Internal APIs Are All You Need" against the current state of shipped code. Each claim is categorized as **Shipped**, **Partial**, or **Not Yet**.

---

## Shipped

These capabilities are fully implemented and working in the current release.

| Paper Claim | Status | Notes |
|---|---|---|
| Three-path execution (cache, marketplace, browser) | **Shipped** | The 10-step resolve cascade is the core execution loop. All three tiers are functional and used in production. |
| Composite scoring (40/30/15/15) | **Shipped** | Endpoint candidates are ranked by embedding similarity (40%), reliability (30%), freshness (15%), and verification status (15%). The formula is implemented as described in the paper. |
| Skill lifecycle (active/deprecated/disabled) | **Shipped** | Skills transition between states based on verification results. Disabled skills are excluded from resolution. |
| Verification loop | **Shipped** | A 6-hour background cycle re-tests endpoint availability and schema consistency. Failed verifications trigger lifecycle state transitions. |
| DOM extraction as fallback | **Shipped** | Multiple extraction strategies (SSR fast-path, table extraction, repeating patterns, SPA data, domain-specific extractors) are implemented and used when API routes are unavailable. |
| Passive indexing during browse sessions | **Shipped** | HAR recording, fetch/XHR interceptor, and extension observer run on every browse session. Traffic is merged and enriched on session close. |
| Auth cookie extraction from real browsers | **Shipped** | Chrome and Firefox SQLite cookie databases are read directly. Cookies are injected into Kuri sessions via CDP `setCookie`. Auto-login on `auth_required` completes the auth lifecycle. |
| Marketplace with vector search | **Shipped** | Over 500 domains and ~10,000 endpoints indexed. Vector similarity search over semantic descriptions plus keyword fallback. Hosted on Cloudflare Workers. |
| Kuri as bundled browser runtime | **Shipped** | Kuri (Zig-native CDP broker, 464KB binary, ~3ms cold start) ships bundled in the npm package. No separate browser installation required beyond Chrome itself. |
| Capture pipeline (traffic to published skill) | **Shipped** | The full pipeline -- extract endpoints, extract auth, store credentials, merge, describe, augment, build graph, publish -- runs on every capture event. |
| Route cache for sub-100ms execution | **Shipped** | Local route cache hits bypass marketplace search entirely. 18 benchmark domains execute in under 100ms from warm cache. |
| MCP server integration | **Shipped** | The CLI's API surface is exposed as Model Context Protocol tools, usable by any MCP-compatible agent. |
| Semantic enrichment via LLM | **Shipped** | Endpoint descriptors are augmented with LLM-generated descriptions of purpose, parameter semantics, and return value meaning. These descriptions power the embedding-based search. |
| Freshness decay formula | **Shipped** | `1 / (1 + d/30)` is implemented and applied to the freshness signal in composite scoring. A 30-day-old endpoint scores 0.5 on freshness. |

## Partial

These capabilities are implemented but not yet used to their full potential as described in the paper.

| Paper Claim | Status | Notes |
|---|---|---|
| Operation graph for multi-step planning | **Partial** | The DAG is built during skill enrichment -- endpoints are linked by `requires`/`provides` bindings derived from URL template parameters and response schemas. However, the graph is not yet used for automated multi-step execution planning. Currently, it serves as metadata for understanding endpoint relationships. The execution engine does not yet chain multiple endpoints automatically based on graph traversal. |
| Delta-based attribution | **Partial** | Schema diffs and cosine dissimilarity between skill versions are computed during merges. These deltas quantify how much a contributor changed a skill. However, the attribution data is not yet connected to any payment or credit system. The diffs are stored but not acted upon economically. |
| URL template parameterization | **Partial** | URL segments are templatized (e.g., `/r/{subreddit}/hot`), but semantic matching of template parameters to user intent is incomplete. The paper describes intelligent parameter binding where the system understands that `{subreddit}` should be filled with a subreddit name from the query. Current implementation handles simple cases but struggles with ambiguous templates -- e.g., confusing `/r/singularity` with `/r/programming` when both match the same template. |
| Endpoint description quality | **Partial** | LLM augmentation generates descriptions, but they sometimes fail to capture the distinguishing semantics of similar endpoints. Two endpoints with the same URL template but different parameter values (different subreddits, different search queries) may receive descriptions too similar for the embedding search to differentiate. |

## Not Yet

These capabilities are described in the paper but have no implementation in the current codebase.

| Paper Claim | Status | Notes |
|---|---|---|
| x402 micropayments | **Not Yet** | The paper describes a payment protocol where agents pay per-route-use in USDC on Solana via the x402 standard. No payment infrastructure exists in the current system. Routes are shared freely through the marketplace. |
| TEE attestation for credential isolation | **Not Yet** | The paper proposes Trusted Execution Environments for isolating credential handling so that API keys and tokens are never exposed to the skill execution layer. Currently, credentials are stored in an encrypted local vault and the system keychain, but without hardware-level isolation guarantees. |
| Dynamic route pricing | **Not Yet** | The paper describes demand-based pricing where popular routes cost more and rarely-used routes are cheaper. No pricing mechanism exists; all marketplace access is free. |
| Ostrom commons governance | **Not Yet** | The paper references Elinor Ostrom's principles for governing shared resources, proposing community-driven rules for skill quality, deprecation, and dispute resolution. No governance system exists beyond the automated verification loop. |
| Opt-in site-owner participation | **Not Yet** | The paper envisions site owners publishing official endpoint descriptors, receiving attribution fees, and controlling access to their APIs. No site-owner interface or opt-in mechanism exists. |
| robots.txt compliance layer | **Not Yet** | The paper mentions respecting robots.txt directives when discovering endpoints. The current system does not check robots.txt before capturing traffic or executing endpoints. |
| Cross-agent session persistence | **Not Yet** | The paper describes persisting browse session state across agent restarts so that a new agent instance can resume where the previous one left off. Sessions are currently ephemeral -- they exist only for the lifetime of the Kuri process. |
| Three-tier pricing model | **Not Yet** | The paper defines three fee tiers: one-time skill install, per-execution, and per-query. No fee collection, metering, or billing infrastructure exists. |
| 70/30 contributor fee split | **Not Yet** | The paper proposes that 70% of route fees go to contributors (weighted by delta attribution) and 30% to infrastructure. Without payments, there is no fee split. |

---

## Summary

The core technical system described in the paper -- three-path execution, capture pipeline, composite scoring, skill lifecycle, and marketplace -- is fully shipped. The economic layer (payments, pricing, attribution payouts) and trust infrastructure (TEE, governance) remain on the roadmap. The operation graph exists structurally but is not yet driving automated multi-step execution.

The gap between paper and product is primarily in the economic and governance layers. The technical claims about speed, cost reduction, and coverage are substantiated by the benchmark and the working system.
