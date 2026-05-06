# Signed-Same-Origin Endpoints: Fix From The Root

Date: 2026-05-06
Status: proposal

## Problem

X SearchTimeline (and a whole class of endpoints on LinkedIn, Reddit, GitHub fine-grained, Cloudflare/PerimeterX/DataDome-fronted sites) replay as 403 even when our cookies, queryId, and request body are correct. Today's ladder treats this as "stale endpoint, fall back to browser session." Falling back works but is the wrong long-term answer:

- Every browser-session fallback is multi-second and requires a live Chrome.
- Marketplace skills become unusable for other agents — they pull a recipe that says "open Chrome" instead of a callable HTTP route.
- The flywheel breaks: capture → publish → cheaper next time only holds for unprotected REST. The entire signed-same-origin tier is dead weight in the marketplace.

The 403 has multiple stacked causes. Today we debug them one at a time. Root cause: our HTTP executor is missing two layers a real browser has — a TLS/HTTP-stack identity that matches Chrome, and the ability to compute per-request signed headers from the site's own JS.

## Root-cause map

For a single signed-same-origin request, layers from bottom to top:

| # | Layer | Real Chrome | Today's `unbrowse execute` | Failure mode |
|---|---|---|---|---|
| 1 | TLS ClientHello (JA3/JA4) | Chrome BoringSSL fingerprint | Node OpenSSL fingerprint | Edge bot-mgmt blocks before request body read |
| 2 | HTTP/2 frame order, header case | Chrome's order | undici's order | Same — passive fingerprint |
| 3 | TLS-tied cookies (`ct0`, session) | Browser jar | Injected from Chrome SQLite ✓ | OK |
| 4 | Static auth constants (Bearer, queryId manifest) | Read from bundle | Captured once, frozen | `queryId` rotates with deploys |
| 5 | Per-request signed headers (`x-client-transaction-id`, csrf) | Computed by page JS | Replayed verbatim | Single-use signature → 403 |

`recipe_replay → 403` was diagnosed as layer 5. It's actually layers 1, 4, **and** 5 stacked. Fixing layer 5 alone leaves us blocked at layer 1.

"Fix from the root" = address layers 1–2 and layers 4–5 in the same release. Cookies (layer 3) already work. Once all five align, the same single HTTP call a real browser makes is the call we make.

## Plan

### Part A — TLS/HTTP-stack impersonation (layers 1–2)

Vendor a TLS-impersonating HTTP client and route the executor through it.

**Approach.** Add an `ImpersonatingHttpClient` interface in `src/http/`. Two concrete backends:

1. `rnet` (Rust binding, BoringSSL + h2 frame matching). Vendor the platform-specific binary the same way Kuri is vendored — `vendor/<platform>/<arch>/`. ~5–8MB per platform.
2. Subprocess fallback to a vendored `curl-impersonate-chrome` binary for environments where the Node addon won't load.

Default profile: `chrome131` (or whatever ships when this lands). Profile name is a skill field; some endpoints will need `firefox` or `safari` to match what the cookies were issued under.

**Where it plugs in.** Replace `fetch(url, init)` calls in `src/execution/index.ts` with `httpClient.request(url, init, { profile })`. Behind feature flag `UNBROWSE_HTTP_IMPERSONATE=1` initially. Bench-local A/B under flag, then default-on once we see no regression on unprotected endpoints.

**Acceptance.**
- `BROWSER_BLOCK` bench bucket count drops measurably (Cloudflare-fronted sites that currently challenge the homepage become indexable).
- No regression in `PASS` count on unprotected endpoints (HN, GitHub public, Reddit, etc.).
- TLS profile observable: emit JA4 in `decision_trace` so the agent can debug.

### Part B — Signer extraction and bundle constants (layers 4–5)

For each signed-same-origin endpoint, attach a self-contained JS function plus its constants to the skill, run in a sandbox at execute time.

**Skill schema extension.** `endpoint.signer`:

```ts
interface EndpointSigner {
  source: string;                    // self-contained ES module exporting sign()
  inputs:  Array<"method"|"url"|"now"|"cookies"|"body">;
  outputs: Array<"headers"|"queryParams">;
  constants: Record<string, unknown>;// Bearer, queryId manifest, animation key, etc.
  bundleProvenance: {
    bundleUrl: string;               // e.g. https://abs.twimg.com/responsive-web/.../main.{hash}.js
    bundleHash: string;              // sha256 of the bundle as fetched
    extractedAt: string;
  };
  refresh: {
    trigger: "bundle_hash_change";
    probe: { url: string; selector: "main_js_url" | "x_path_in_html" };
  };
}
```

**Pipeline addition.** Extend the existing layer-2 reverse-engineer (`src/reverse-engineer/bundle-scanner.ts`) with a *signer extractor*:

1. AST-parse the bundle (acorn or swc).
2. Locate any function whose return value flows into `setRequestHeader(name, ...)` or a `Headers` literal where `name` is one of: `x-client-transaction-id`, `x-csrf-token`, `authorization`, or any header named `x-*`. Generic — no domain check.
3. Slice the function plus its transitive dependencies into a self-contained module.
4. Snapshot referenced constants (any string literal `> 32` chars referenced by the signer, plus any object literal that looks like a queryId manifest — heuristic: object with ≥10 keys whose values match `/^[A-Za-z0-9_-]{20,32}$/`).
5. Verify-before-publish: sign a known-good request with the extracted signer, fire it through the impersonating client, assert response shape matches captured signal. Pass = publish to local skill registry. Fail = stay local-only, mark `verification_status: "unverified"`.

**Sandbox.** Use Node's `vm.SourceTextModule` or a Worker thread — not `eval`. Inputs are scalars and the cookie jar; outputs are a headers object. No network access from inside the sandbox.

**Refresh policy.** Skill carries `bundleHash`. On a 403 from a previously-passing signed endpoint, executor probes the homepage HTML for the current `main.js` URL. If hash differs → re-run extractor → re-verify → republish. Endpoint stays "live" through a deploy without human intervention.

**Acceptance.**
- X SearchTimeline replays with 200 from a fresh executor process in `< 100ms` (no Kuri tab, no DOM).
- LinkedIn voyager `/voyager/api/...` replays with 200 (csrf + tracking-header signing).
- A site with rotated bundle hash auto-recovers within one extra HTTP probe.
- Bundle-extracted signers cross-machine: a marketplace consumer pulling the skill on a fresh machine can replay without ever having opened a browser.

### Part C — Ladder reorder

Once A and B land, executor ladder collapses to:

1. **HTTP w/ impersonating client + bundle-extracted signer** (the new rung 1). Covers everything currently on rung 1 plus most of what currently falls to rung 2.
2. **In-page fetch** stays as a fallback for sites with active anti-tamper (canvas-replay validation, runtime DOM checks the signer can't satisfy out of the bundle).
3. **Live rediscover** unchanged.

Update `decision_trace` to expose which rung fired and why escalation happened. Keep the existing `signed_same_origin` heuristic (cookies + `x-*` or `Authorization: Bearer`) — it's still the gate that says "use a signer if available, don't ship a raw recipe."

## Phasing

**Phase 1 — TLS impersonation.** ~3–5 days.
- Vendor `rnet` + binary, plus subprocess curl-impersonate fallback.
- `ImpersonatingHttpClient` interface, wired into executor behind flag.
- Bench-local A/B under flag. Default-on once green.
- Add JA4 intent to `decision_trace` as `tls_impersonate` when the sandbox impersonating client fires.

**Phase 2 — Signer extraction MVP.** ~5–7 days.
- AST walker for "function flowing into setRequestHeader/Headers."
- Constant snapshotter.
- Sandbox runner (`vm.SourceTextModule`).
- Verify-before-publish wired into existing pipeline.
- Validate on X SearchTimeline as marquee case. Don't generalize yet — prove the mechanism on one site end to end.

**Phase 3 — Refresh + cross-site validation.** ~3–5 days.
- Bundle-hash probe + auto re-extract.
- Run extractor against LinkedIn, Reddit, GitHub fine-grained, one Cloudflare-protected site. Collect per-site notes; only fold back generic improvements.
- Publish refreshed bench results. "PRODUCT_FAIL on signed-same-origin" bucket should be ~0.

**Phase 4 — Marketplace propagation.** ~2 days.
- Sanitize signer source on publish (strip comments, no hardcoded user identifiers).
- Document new skill schema field for SDK consumers.
- Remote-agent bench validating consumers get the new recipe and replay locally.

Total: roughly 2–3 weeks of focused work. Phases 1 and 2 are parallelizable.

## Bans (so this doesn't decay into per-domain hacks)

- No per-domain extractor switches. The signer extractor is "find a function that flows into setRequestHeader" — site-agnostic.
- No allowlist of header names beyond `x-*` / `authorization` / `csrf*`. If a site invents a new header name, the heuristic catches it through dataflow, not a string list.
- No manually-written signers checked into the repo for any specific site. Signers are *artifacts of extraction*, same way captured endpoints are artifacts of capture.
- No frozen bundle constants. Always carry `bundleHash` and a refresh path. A signer without a refresh policy is a time bomb.
- No skipping the impersonating client. A fresh signature delivered over a Node TLS handshake is still flagged at the edge. Ship A and B together; one without the other regresses to today's behavior.

## Open questions

- `rnet` license + binary distribution: confirm we can vendor and redistribute.
- Sandbox CPU isolation: a malicious bundle could ship an infinite loop. `vm.SourceTextModule` has no built-in timeout — Worker thread + `terminate()` after N ms is safer.
- Per-skill profile selection (`chrome` vs `firefox`): heuristic from captured `User-Agent`, but users mix browsers. Probably skill-level default with executor-level override.
- Marketplace signer review: agent-augmented metadata is auto-generated today. Signer source is *executable code* downloaded from the marketplace and run locally. Need a `signer_review_required: true` policy gate before any signer flows to other agents — at minimum the sanitizer step in Phase 4, ideally an automated AST-diff against known-safe shapes.

## Why this is the right move now

The replay-then-rediscover ladder works but our marketplace recipes for signed-same-origin sites are practically dead — they say "open Chrome." X, LinkedIn, every SaaS that ships a JS-signed API is in this bucket. That's a lot of the agent web. Fixing this turns "open Chrome" recipes into "call this URL with these signed headers" recipes — the form other agents can actually consume. The marketplace becomes valuable for the hardest sites instead of just the easy ones.

Strictly aligned with the Agent UX north star: less browser-open, fewer errors, faster replays, marketplace recipes that are real recipes.
