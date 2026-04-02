# System Today

A comprehensive description of what is shipped and working in Unbrowse as of the current release.

---

## Three-Path Execution

Every resolve request follows a 10-step cascade that spans three execution tiers:

**Tier 1 -- Local Cache.** The system checks the route cache for a prior successful execution matching the domain and intent. On hit, it executes the cached endpoint directly. This path completes in under 100ms for 18 of the 94 benchmark domains.

**Tier 2 -- Shared Route Graph (Marketplace).** On a local miss, the system queries the marketplace using vector similarity search. The query encodes the user's intent as an embedding and retrieves candidate endpoints ranked by composite score (40% embedding similarity, 30% reliability, 15% freshness, 15% verification). The top candidates are attempted in ranked order. The marketplace currently indexes over 500 domains and approximately 10,000 endpoints.

**Tier 3 -- Browser Fallback.** If no cached or marketplace route satisfies the request, the system falls back to live browser-based discovery. Kuri (the bundled Zig-native CDP broker, 464KB, ~3ms cold start) launches a browser session with stealth extensions and anti-bot evasion. The system navigates to the target URL, captures all network traffic, extracts endpoints, and attempts to fulfill the original request. This is the slowest path (median 8.2s cold-start) but guarantees coverage.

The 10-step cascade within these tiers proceeds as: (1) route cache lookup, (2) local skill match, (3) marketplace vector search, (4) marketplace keyword fallback, (5) first-pass browser capture (8-second budget), (6) DOM extraction from rendered page, (7) browse session handoff to calling agent, (8) passive capture during agent-driven browsing, (9) live capture with extended timeout, (10) error with diagnostic context.

## Capture Pipeline

When network traffic is captured -- whether through passive indexing during a browse session or explicit capture commands -- it flows through a full enrichment pipeline:

1. **Traffic merge.** HAR recording via CDP and the fetch/XHR JavaScript interceptor (`INTERCEPTOR_SCRIPT`) run simultaneously. The interceptor catches async requests that HAR misses on single-page applications. An extension observer provides a third capture source. All three are merged and deduplicated on session close or navigation.

2. **Endpoint extraction.** Raw HTTP entries are filtered (removing static assets, tracking pixels, and known noise), then parsed into endpoint descriptors with URL templates, methods, headers, and response bodies.

3. **Auth header extraction.** Authorization headers, cookies, and tokens are identified and classified. Bearer tokens, API keys, session cookies, and CSRF tokens are each handled with type-specific logic.

4. **Credential storage.** Extracted credentials are stored in the local vault, keyed by domain. Kuri auth profiles are saved to the system keychain for persistence across sessions.

5. **Endpoint merging.** New endpoints are merged with any existing skill for the domain. URL templates are deduplicated, schemas are unified, and conflicting entries are resolved by recency.

6. **Local description generation.** A first pass generates natural-language descriptions for each endpoint using the URL structure, parameter names, and response shape -- without LLM calls.

7. **LLM semantic augmentation.** An LLM enriches each endpoint with detailed descriptions of its purpose, parameter semantics, and return value meaning. This metadata powers the embedding-based similarity search.

8. **Operation graph construction.** The system analyzes all endpoints in the skill to build a DAG of dependencies. URL template parameters are matched against response fields from other endpoints to infer `requires`/`provides` bindings.

9. **Publish.** The completed skill is cached locally and published to the marketplace. A background indexing job handles marketplace-side vector embedding and search index updates.

## DOM Extraction

When API-based execution is insufficient or unavailable, the system falls back to DOM extraction with multiple strategies:

- **SSR fast-path**: for server-rendered pages, the raw HTML is parsed without launching a full browser
- **Table extraction**: structured data in HTML tables is converted to typed records
- **Repeating pattern detection**: lists of similar elements (product cards, search results, feed items) are identified by DOM structure similarity and extracted as arrays
- **SPA data extraction**: JavaScript-rendered content is captured after hydration completes
- **Domain-specific extractors**: hand-tuned extraction logic for high-value domains where generic strategies underperform

DOM extraction serves as both a fallback when no API route exists and a validation source -- extracted DOM data can be compared against API responses to verify endpoint correctness.

## Authentication

Unbrowse handles authentication automatically across several mechanisms:

- **Browser cookie extraction.** On every `go`/`goto` command, cookies are extracted from the user's real Chrome or Firefox profile by reading their SQLite cookie databases directly. These cookies are injected into Kuri's browser session via CDP `setCookie`, giving the headless browser the same logged-in state as the user's real browser.

- **Kuri auth profiles.** Authentication state is persisted per domain in the system keychain. Profiles are loaded automatically on session start and saved on session close.

- **Vault storage.** API keys, bearer tokens, and other credentials discovered during traffic capture are stored in an encrypted local vault, keyed by domain.

- **Auto-login on `auth_required`.** When an endpoint returns an authentication error, the system automatically attempts re-authentication using stored credentials and retries the request. The full login lifecycle -- credential lookup, auth request, token refresh -- is handled without user intervention.

## CLI Interface

The CLI exposes two primary interaction modes:

**One-step execution:** `unbrowse resolve "query" --execute` combines route resolution and execution in a single command. The system finds the best endpoint, fills parameters from the query, executes the request, and returns structured data.

**Browse commands:** `go`, `snap`, `click`, `fill`, and `close` provide granular browser control for cases that require manual exploration. Every browse session runs the capture pipeline passively -- all observed traffic is indexed on close.

**Site packs:** pre-configured bundles of skills for common domain groups, installable with a single command.

## MCP Server

The same API surface exposed by the CLI is available as a Model Context Protocol server. AI agents that speak MCP can call `resolve`, `browse`, `snap`, and other tools directly, making Unbrowse a drop-in capability provider for any MCP-compatible agent framework.

## Passive Indexing

Every browse session -- whether initiated by the user or handed off to an external agent -- captures all network traffic in the background. When the session closes, captured traffic flows through the full enrichment pipeline. This means the system improves continuously: every page visit potentially discovers new endpoints and enriches existing skills, with zero additional effort from the user.

## Marketplace

The shared route graph currently contains:

- **500+ domains** with published skills
- **~10,000 endpoints** with semantic descriptions and schemas
- **Vector search** over endpoint descriptions for intent-based resolution
- **Keyword fallback** for exact-match and partial-match queries
- **Composite scoring** for candidate ranking across similarity, reliability, freshness, and verification signals

The marketplace is hosted on Cloudflare Workers with the API at `beta-api.unbrowse.ai`. Skills are published automatically after local enrichment and are available to all users immediately.
