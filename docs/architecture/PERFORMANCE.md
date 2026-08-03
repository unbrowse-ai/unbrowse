# Unbrowse Architecture — Performance & Speed

> **At a glance** — Unbrowse is fast because it avoids the browser tax: it
> replays a learned request path instead of re-driving Chrome, serves repeats
> from a correctness-guaranteed cache, and escalates egress only as far as a
> block forces it. The headline speedups are peer-reviewed or witnessed by a
> reproducible bench; this doc says which is which.

> Reviewed 2026-06-17 against build v9.4.12. Companion to [../benchmarks.md](../benchmarks.md),
> [../caching.md](../caching.md), and [OVERVIEW.md](./OVERVIEW.md).

## 1. The speed thesis: replay over re-drive

The resolve → execute pipeline picks the **cheapest capable layer** for an
intent rather than always opening a browser:

| Layer | Typical cost | When |
|---|---|---|
| Route-cache (local) | near-zero, instant | a previously captured endpoint with a still-valid recipe |
| Marketplace (shared graph) | low, server-side | a route someone else already indexed |
| Live capture (browser tax) | high, seconds | nothing indexed yet, or the recipe went stale |

Intent → route binding is `src/intent-match.ts` (form detection + API-type
inference); the execute pipeline is `src/execution/index.ts`. When a route is
missing or stale, execution escalates through SSR fast-path → curl-impersonate →
stealth browser → paid unblocker → full browser, stopping at the first rung that
works (§3, §4). The whole decision is instrumented (§5).

## 2. Caching: correctness-guaranteed, pointer-reactive

Unbrowse's cache never silently serves stale data — freshness is **dependency
driven**, not a guessed TTL (`docs/caching.md`, `src/values/pointer-cache.ts`):

- **Content addressing** (`src/values/content-address.ts`) — pointers are
  `sha256:<hex>` of bytes; a genesis hash anchors the chain. `valueSetPointer`
  gives an order-independent pointer for a set of resolved values; `intentKey`
  scopes an intent pointer.
- **Pointer-reactive invalidation** — each cache entry pins the addresses of its
  dependencies. A read is a HIT only if **every** dependency's current address
  still equals the pinned one; when any dependency's value changes its address
  changes, so dependents recompute automatically. Reads are O(1)
  (`recomputeCount` is observable).
- **Wallet-sealed entries** (`src/trust/sealed-cache.ts`) — sensitive cache
  values are encrypted to the wallet; they still respect pointer dependencies.

Short-lived operational TTLs that *are* time-based: residential sticky sessions
~25 min (under the proxy's own lifetime), x402 proxy-authorization ~5 min.

## 3. Egress tiering: cheapest IP first, escalate honestly

`src/execution/egress-chain.ts` walks a three-rung ladder and returns the best
outcome; it never leaks credentials to a tier that could read them:

1. **LOCAL** — direct `fetch` from the client's own IP. Returned immediately
   unless the status is a block (0/401/403/429/5xx). Skipped for auth-bearing
   requests (see [AUTH.md](./AUTH.md#4-auth-bearing-execution--token-resolution)).
2. **SERVER clean IP** — `POST /v1/proxy` (`src/execution/server-proxy-fallback.ts`);
   the server tries its own datacenter IP first and escalates only if blocked.
   Also skipped for auth-bearing requests (the server tier terminates TLS).
3. **CLIENT residential proxy** — last resort (`src/execution/proxy-fetch.ts`);
   residential egress with a sticky session for IP-bound clearance, or a paid
   x402 unblocker chain.

`isBlock(status)` classifies blocks; `egressFetchWithBlockCheck` catches
soft-blocks (a 2xx body that is actually an error/challenge page); the
`authExcluded` flag is the honest "stayed local, never leaked the credential"
result.

## 4. Fast paths

| Path | File | What it saves |
|---|---|---|
| SSR fast-path | `src/capture/ssr-fastpath.ts` | On a bot-block, fetches the page via libcurl-impersonate (TLS fingerprint spoof) inside the Kuri sandbox — no browser spin-up. Returns null on non-2xx / tiny HTML (non-fatal). |
| Graph prefetch | `src/capture/prefetch.ts` | Traverses parent→child operation edges and runs up to 3 satisfiable GET endpoints in parallel (2s timeout) so an agent gets list + detail in one round-trip. |
| Fetch ladder | `src/capture/fetch-ladder.ts` | Ordered anti-bot escalation: curl-impersonate direct (12s) → curl-impersonate via proxy (45s); advances only on a detected block phrase; refuses to cache error pages. |
| curl-impersonate fallback | `src/capture/curl-impersonate-fallback.ts` | JA3/JA4 TLS spoof helper, stealth-browser fallback for JS challenges, and the x402 paid-unblocker chain with per-provider negative caching. |
| Recipe replay hints | `src/execution/recipe-replay-hints.ts` | Reuses a captured recipe's known-good request shape to skip rediscovery. |

## 5. Telemetry that measures the path

- `src/routing-telemetry.ts` — per-step routing events
  (`routing_session_started/_candidates_ranked/_step_executed/_completed`) with
  `execution_latency_ms`, candidate/binding counts, `source`
  (route-cache / marketplace / live-capture / dom-fallback / …), and a classified
  `failure_reason`. State is captured as `state_hash_before/after`, results as
  `response_hash` — never raw bodies.
- `src/telemetry.ts` — anonymized `RouteTraceArtifact`s under `~/.unbrowse/traces/`
  (see [PRIVACY.md](./PRIVACY.md#5-local-storage--at-rest-protection)). Opt-out
  `UNBROWSE_DISABLE_TRACES=1`.

## 6. The numbers — substantiated vs marketing

**Substantiated (cite these):**

| Claim | Source | Status |
|---|---|---|
| **3.6× mean / 5.4× median** speedup over a browser across 94 live domains; ~40× fewer tokens | peer-reviewed paper *Internal APIs Are All You Need* (arXiv:2604.00694) | externally validated |
| **~30× faster, ~90× cheaper** than driving a browser | same paper | externally validated |
| **21.1s cold → 4.1s warm** (≈80% faster) on a fixed probe set as the route cache fills | `docs/benchmarks.md` | reproducible witness |
| Anti-bot: **9/9 vs naive 0/9** on a JS-challenge-gated platform | `docs/benchmarks.md` | ground-truth validated |

**Marketing simplification — do not cite as measured:** "sub-200ms cache hit"
has no direct latency witness in code or bench. The cache *read* is O(1), but the
network round-trip for the actual call dominates end-to-end; the substantiated
figure is the cold→warm probe-set result above. Prefer the witnessed numbers.

## One-line model

Speed = replay instead of re-drive + a cache that recomputes only when a real
dependency changed + egress that escalates no further than a block forces.

## See also
- Benchmark methodology & history → [../benchmarks.md](../benchmarks.md), [../benchmarks-history.md](../benchmarks-history.md)
- Caching design → [../caching.md](../caching.md)
- Egress & auth interaction → [AUTH.md](./AUTH.md)
