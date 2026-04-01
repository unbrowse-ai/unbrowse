# Requirements — Unbrowse v1

## v1 Requirements

### Passive Capture
- [ ] **PASSIVE-01**: Passive network capture — index all API traffic while the browser operates normally, no explicit capture step required
- [ ] **PASSIVE-02**: Kuri builtin extension integration — wire chrome.webRequest network observer data into unbrowse's capture pipeline, supplement with CDP for response bodies
- [ ] **PASSIVE-03**: Background indexing — reverse-engineer endpoints from passively observed traffic without blocking the user's navigation or agent's browsing
- [ ] **PASSIVE-04**: Cache-first resolution — second call to any site resolves from local skill cache or marketplace, never re-captures unless forced

### Browser Replacement
- [ ] **BROWSER-01**: Drop-in browser replacement API — agents can use unbrowse as their browser instead of Playwright/Puppeteer/agent-browser, with the same navigation/action primitives
- [ ] **BROWSER-02**: UI action support — kuri hook for clicking elements, filling forms, triggering POST requests via browser interaction (dependency: Rach delivers kuri-side hook)

### Endpoint Graph
- [ ] **GRAPH-01**: Dependency prefetch — when resolving an endpoint, identify and prefetch related endpoints (e.g., list + detail) so agents get complete context in a single round-trip
- [ ] **GRAPH-02**: Endpoint dependency graph — track relationships between endpoints (parent/child, pagination, auth dependencies) for smarter resolution and execution

### Platform
- [ ] **TELEMETRY-01**: Auto-issue creation — when agents encounter errors or unexpected behavior, automatically file GitHub issues with telemetry (request context, error traces, kuri version)
- [ ] **MARKETPLACE-01**: Wire graph DB to marketplace — connect the existing graph database to the marketplace API so skills can be published, discovered, and consumed by other agents
- [ ] **MARKETPLACE-02**: Marketplace payments — implement wallet-based payment system for skill usage (simple wallet solution, not cross-chain)

## v2 Requirements (Deferred)

- [ ] **BROWSER-03**: OpenClaw native integration — replace browser in OpenClaw agent framework
- [ ] **AUTH-01**: Login-as-dependency — agents can register fresh accounts on sites and have the auth flow mapped into the skill graph
- [ ] **AUTH-02**: OAuth/SSO flow capture — capture and replay complex auth flows (OAuth redirects, SSO, 2FA)

## Out of Scope

- Cross-chain/crypto payments — start simple with wallets, revisit after traction
- Custom rendering engine browser — Rach's separate project
- Rewriting kuri internals — kuri is Rach's domain
- Headless-only capture — passive capture from real browser sessions replaces this approach

## Traceability

| Requirement | Phase | Status |
|-------------|-------|--------|
| PASSIVE-01  | —     | —      |
| PASSIVE-02  | —     | —      |
| PASSIVE-03  | —     | —      |
| PASSIVE-04  | —     | —      |
| BROWSER-01  | —     | —      |
| BROWSER-02  | —     | —      |
| GRAPH-01    | —     | —      |
| GRAPH-02    | —     | —      |
| TELEMETRY-01| —     | —      |
| MARKETPLACE-01 | —  | —      |
| MARKETPLACE-02 | —  | —      |
