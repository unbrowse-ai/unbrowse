# Deep Reveng — Sandboxed Bundle Replay

**Status**: Planned, not started
**Owner**: Lewis
**Branch target**: `submodules/kuri @ adding-extensions` (lekt9/kuri fork)
**Depends on**: nothing — all primitives in place

---

## The insight

Anti-bot bundles (PerimeterX, Datadome, Akamai, Kasada, Shape, Imperva) and JS-computed-token flows (signed URLs, msToken, HMAC mutation signing, in-JS auth) all share one shape: **the browser runs JS that reads N inputs, performs pure transforms (often with a server-fetched salt mid-flight), and produces a token/cookie**. The token gets POSTed back, server returns an auth cookie, subsequent calls carry that cookie.

The naive ways to defeat this:
1. **Reverse the math** — symbolically execute the bundle, derive a static algorithm. Per-vendor research project. Bundle rotates daily. Loses.
2. **Run full Chrome** — works, costs ~3s and ~250MB per call. Doesn't scale to agent infra.

The right way:

**Be a faithful enough environment that the bundle fetches its own salts, runs its own computation, and hands us the cookie.** We don't reverse the algorithm. We *are* the salt provider, by virtue of being a sufficient browser.

That collapses "research project per vendor" → "engineering project, once."

## Architecture

```
┌─ V8/QuickJS isolate                          ~50ms cold
│  └─ shim layer:                              ← embedded JS shim
│     navigator/document/window/screen/         (~5–10KB)
│     performance/crypto.subtle/Worker/
│     IndexedDB/localStorage/postMessage/
│     fetch/XMLHttpRequest
│
├─ Fingerprint pool                            ← real Chrome samples
│  {ua, canvasHash, webglVendor, audioCtx,      (rotated per-domain
│   fonts[], plugins[], screen, timezone}        to defeat coherence)
│
├─ TLS-mimic outbound                          ← curl-impersonate
│  fetch/XHR exit through here                  (matches Chrome JA4)
│  ▶ THIS is where salts come in for free —    cookies flow back
│    bundle calls /_px/init, real server,      into shared jar
│    real response, real per-session salt
│
├─ Shared cookie jar  ← survives across bundle run + the real API call
│
└─ (optional, tier 2) behavior synth: mouse path, scroll velocity, jitter
```

Headline numbers vs full Chrome: **~50ms vs ~3s, ~10MB vs ~250MB.** The agent-infra unit-economics gap.

## Why this is generic, not a one-trick

The same runtime handles every "JS computes something we need" problem:

- **Anti-bot tokens** — PerimeterX, Datadome, Akamai, Kasada, Shape, Imperva, Cloudflare Turnstile.
- **Signed URLs** — HMAC keys baked into JS bundles (TikTok, Instagram).
- **Encrypted payloads** — `msToken`, Cloudflare CF-Token rotation, Reddit `_xsrf`.
- **In-JS auth flows** — banks, airlines, SaaS that compute session keys client-side.
- **Crypto signing of write requests** — GraphQL APIs that sign mutations client-side.

It's literally **the missing primitive between curl and Chromium**. That's why it's worth productizing.

## Slot into Unbrowse resolve race

```
route_cache    (instant)
marketplace    (instant)
server_fetch   (~100ms)        ← current
bundle_replay  (~300ms)  NEW   ← runs cached bundle in sandbox, refreshes cookie, then server_fetch
browser_capture (~3s)          ← last resort
```

`bundle_replay` consumes captured artifacts: bundle JS, the bootstrap request sequence, the fingerprint that worked last time. Stored in the skill alongside the endpoint, same shape as everything else.

## Why we're putting it in Kuri (not Unbrowse Node-side)

Kuri already has:

- **QuickJS embedded** (`src/js_engine.zig`, 31KB on our fork — already extended). Single dep: `quickjs_ng`.
- **CDP client + stealth.js** (`src/cdp/`). Real-Chrome capture path is already wired.
- **HAR recorder** (`src/cdp/har.zig`). Captures bootstrap sequences. This is the *snapshot input* for replay.
- **Standalone fetcher** (`src/fetch_main.zig`). Outbound HTTP — needs upgrade to TLS-mimic.
- **HTTP API + router** (`src/server/router.zig`). New `/v1/sandbox/replay` endpoint slots in here.

We **own the fork** at `lekt9/kuri @ adding-extensions`, 13 commits ahead of upstream `v0.3.3`. No coordination blocking, no upstream PR required. Offer back later if it lands clean.

What we'd *not* gain by building Node-side instead:
- A second JS runtime to maintain (Node `isolated-vm` + Zig QuickJS).
- Cross-process IPC for HAR replay.
- Duplicated TLS layer.

The decision: **extend the binary we already ship.**

## What we considered and rejected

| Alternative | Why rejected |
|---|---|
| `OpenSandbox` (Alibaba) | Docker/k8s **process-level** sandbox. Wrong abstraction layer — we need *in-process JS shim*, not a container. |
| `OpenShell` (NVIDIA) | Same — process sandbox with YAML policies. Wrong layer. |
| `pathik` (Rach) | Go-based crawler, no bot evasion, no JS execution. Different optimization axis. |
| Node `isolated-vm` + curl-impersonate Node binding | Works, but introduces a parallel runtime. Kuri already has QuickJS. Don't fragment. |
| Reverse the math per-vendor | Per-vendor research, bundle rotates daily, doesn't generalize. |

## Concrete file diff

### Kuri side (`submodules/kuri/`)

| File | Change | Approx size |
|---|---|---|
| `src/sandbox/shim.js` | NEW. `@embedFile`'d Web API shim — `navigator`, `document`, `window`, `screen`, `location`, `performance`, `crypto.subtle`, `fetch`, `XMLHttpRequest`, `Worker`, `localStorage`, `postMessage`, `MessageChannel`. Pure JS, no Zig. | 5–10KB |
| `src/sandbox/runtime.zig` | NEW. Wraps `JsEngine` + injects `shim.js` + accepts a `Fingerprint` struct that replaces `navigator.userAgent` / `screen.*` / `canvas.toDataURL` return values per call. | ~300 lines |
| `src/sandbox/network.zig` | NEW. Outbound `fetch`/XHR exit point. Calls into `curl-impersonate` via Zig `@cImport` for JA4-mimic'd requests. Cookie jar shared with calling Unbrowse process. | ~400 lines |
| `src/sandbox/fingerprint.zig` | NEW. Loads JSON pool (sampled-from-real-Chrome data), picks one per replay session, rotates per-domain. | ~150 lines |
| `build.zig.zon` | Add `curl_impersonate` dep (C library, vendor-bundled or fetched). | +6 lines |
| `build.zig` | Link `curl-impersonate` C objects, `@cImport` headers. | +20 lines |
| `src/server/router.zig` | Add `POST /v1/sandbox/replay`. Body: `{ bundle_url, bootstrap_har, fingerprint_id?, target_origin }`. Returns: `{ cookies[], headers{}, ms }`. | +80 lines |
| `src/cdp/har.zig` | Add export helper to extract just the cookie-issuing chain so router can pass it into the sandbox. | +40 lines |

### Unbrowse side (`src/`)

| File | Change |
|---|---|
| `src/execution/strategies/bundle-replay.ts` | NEW. New strategy in resolve race. Calls Kuri `/v1/sandbox/replay`. Budget 300ms. |
| `src/capture/index.ts` | When `browser_block_signals` includes `vendor:*`, emit a `bundle_snapshot` artifact alongside the endpoint capture. |
| `src/storage/skill-schema.ts` | Add `bundle_snapshot` field on endpoint records: `{ bundle_url, bootstrap_har_id, fingerprint_used, captured_at }`. |
| `src/execution/index.ts` | Wire `bundle_replay` into the strategy switch with budget config. |

## Rollout sequencing (de-risked)

**Phase 1 — JS shim only, no TLS mimic.** Land `shim.js` + `runtime.zig` + router endpoint. Pipe outbound through Kuri's existing Zig HTTP stack (will fail PerimeterX at the salt round-trip due to JA4 fingerprint, but proves the JS shim works on lighter targets — signed-URL bundles, in-JS HMAC signing, `msToken`-style flows). De-risks the runtime work.

**Phase 2 — Add `curl-impersonate` FFI.** This is the dep with the most variance (build complexity on macOS / Linux / Windows, version pinning to a recent Chrome JA4). Isolated change — runtime layer already proven.

**Phase 3 — Fingerprint pool.** Ship with one entry sampled from Lewis's real Chrome via Kuri-agent. Expand later.

**Phase 4 — Marketplace integration.** When `bundle_replay` succeeds, publish the `bundle_snapshot` to the marketplace alongside the endpoint. Other agents downloading the skill get the replay recipe for free.

## Test targets

Phase 1 (JS shim only):
- TikTok `msToken` generation (in-JS, no salt round-trip needed for some endpoints).
- Reddit `_xsrf` extraction (in-page JS, no fingerprint check).
- Any GraphQL API that signs mutations with a JS-derived HMAC.

Phase 2 (with TLS mimic):
- **Reddit** (PerimeterX) — reproducible block from the deep-reveng conversation 2026-05-04.
- **Cloudflare Turnstile** sites.
- **DataDome**-protected target (any e-commerce — Sephora, Footlocker).

Pass criteria: `unbrowse resolve --intent X --url Y` returns data without spawning Chrome and within ~500ms total.

## What still fails (be honest)

1. **GPU-tied canvas/WebGL pixel readback** — solvable with precomputed-valid-hash pool; rotate.
2. **WASM challenges** (Akamai 2024+) — QuickJS handles WASM but has no JIT, so heavy bundles run 5–10x slower than V8. Still beats full Chrome (3s); 500ms–1s budget.
3. **Required behavioral signals** (some Datadome configs) — need motion synth, defer to Phase 5 or fall through to full Chrome.
4. **WebRTC IP leak detection** — stub cleanly in shim or proxy gets unmasked.
5. **Server-side velocity heuristics** — even a perfect runtime gets rate-limited if you call from one IP. Not our problem to solve here.

## Why nobody has shipped this generally

Scraper world models the threat as "hide among real users" → optimizes residential proxies, not runtime efficiency. For agent infra at scale where you have 1000 concurrent calls, the runtime is the bottleneck. Unit economics flip.

Pieces exist in the wider ecosystem (`curl-impersonate`, `utls`, `tls-client`, `isolated-vm`, `nodriver`, `patchright`) but none are packaged as "agent infrastructure." Kuri-native binary + impersonated TLS + JS shim in one process is something nobody ships today.

## Strategic positioning

This is exactly the capability that reinforces **"Unbrowse is infrastructure, not a tool."** Every agent web call routes through us *because* we have this and curl doesn't and Playwright does it 60x slower. It is the moat that makes "Unbrowse as the default browser for every agent" a defensible claim, not a marketing one.

It also feeds the marketplace flywheel: each successful `bundle_replay` publishes a `bundle_snapshot` recipe → next agent on the same domain skips even the bundle re-run → eventually the snapshot itself becomes a tradeable artifact (this is x402-priceable).

## Decision log

- **2026-05-04** — agreed approach in deep-reveng conversation. Plan written down. Nothing started.
- **Owner**: Lewis. Pickup point: scaffold `submodules/kuri/src/sandbox/runtime.zig` + `shim.js` as the smallest landable PR against `adding-extensions`. Phase 1 first; do not bring in `curl-impersonate` until shim layer is proven.
