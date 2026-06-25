# Unbrowse SDK — server-side proxy contract (CONTRACT.md)

Direction: the SDK is the server-side proxy. An SDK consumer's `client.proxy.fetch(url)` call lands on the worker's `/v1/proxy` route, which consults on-chain data to decide routing, dispatches the fetch (direct, IPRoyal residential, or cached-route replay), and runs an opt-in captcha solver loop when the upstream serves a challenge. The SDK exposes both a turnkey path (backend-via-SDK, charges through the consumer's wallet) and a BYOK path (SDK-direct, consumer's own solver key) for captcha. IPRoyal is the default residential pool, surfaced natively at the SDK layer.

This contract is the spec. The code follows. Backward-compatible: existing `client.proxy.fetch({ url, proxy: "residential" })` calls keep working.

## Payment truth-root: paid wallet primary, API key optional wrapper

Per `backend/src/middleware/auth.ts:89-145`, a verified wallet signature is the PRIMARY credential (`agent_id = wallet:<pk>`), authenticating the caller with NO API key required. The API key is an optional wrapper that binds a wallet to a sponsor escrow and surfaces as the same `agent_id` the bound key has.

Concretely for this contract:
- Every paid path (residential proxy toll, residential fallback surcharge, captcha solver fee, on-chain IQ attestation read cost) settles through the consumer's wallet via the existing `pay.sh` adapter (`UNBROWSE_WALLET_ADAPTER`, the only adapter after the lobster/privy/generic/base removal). The wallet signature is the source of truth for payment.
- An API key (optional) wraps the wallet: it carries a `credit_budget_usd`, binds the wallet to a sponsor escrow, and enables daily-cap enforcement (`sponsor:agent:<agent_id>:<date>` KV counter). A wallet-only caller pays per-call via x402; an API-key-wrapped wallet draws down its sponsor budget and gets the daily-cap circuit breaker.
- The SDK never treats an API key as sufficient on its own for a paid path. A request with an API key whose bound wallet is unfunded returns 402 (`x402_no_wallet` sub-state) — same as a wallet-less caller. The API key does not pay; the wallet it wraps pays.
- Wallet-only callers (no API key) are first-class: they can use `/v1/proxy` with `proxy:"residential"`, captcha turnkey, and on-chain lookup, settling each call via x402. They are rate-limited more aggressively (no daily-cap circuit breaker), but never feature-gated.

The SDK surfaces this by accepting EITHER `wallet` (a signer: `{ adapter: "pay.sh", keyPath?: string }` or `{ signature: <pre-signed trio> }`) OR `apiKey` (string, implies a wallet is bound server-side) in `UnbrowseClientOptions`. If neither is configured, paid paths return 402 with the `x402_no_wallet` trace sub-state — honest, never a fake-success.

## Scope and non-scope

In scope:
- SDK types for captcha options, on-chain route lookup, egress (IPRoyal) config.
- SDK helpers: `onchain.ts` (three-tier lookup), `captcha.ts` (both-modes dispatch), `iproyal.ts` (egress URL resolver).
- Worker route `/v1/proxy` extended with captcha-solve middleware and on-chain route lookup step.
- Tests for each new helper and the worker middleware.
- Regenerated `docs/sdk/*.md` set built via `/banger-skill-builder` anatomy.

Out of scope:
- A new in-process HTTP server mode in the SDK (`unbrowse sdk serve`). The worker is the server-side proxy. If a future ticket asks for a localhost server mode, that is a separate contract.
- Replacing the existing Capzy/x402 backend plumbing. This contract layers on top: the SDK dispatches through the existing route.
- Chrome runtime integration. The chrome primitives KV-chain (`src/chrome/`) is consulted as a read-only preference bias, not modified by the SDK proxy.
- Direct Solana RPC writes from the SDK. The SDK reads attested route rows via `IqClient.readRows`; it does not write.

## The three-tier on-chain lookup (user choice: "All three")

When `proxy.fetch()` is called with `onchain: { lookup: true }`, the worker consults three layers in order before deciding how to fetch. Each layer is a pointer, not a payload (no inlined body / sealed ciphertext crosses a tier boundary).

Tier 1 — Route cache ledger (`contracts.jsonl`). Hash-chained, append-only, djb2 row hash + prev-hash linking. The worker scans for a row whose `intent` + `contextUrl` match the inbound request within a configurable staleness window (`onchain.stale_after_ms`, default 24h). A hit returns `OnChainRouteDecision` with `action: "replay"`, the captured `endpoint_id`, and the `commitment` (sha256 pointer) — never the response body. The SDK replays via `client.execute({ endpoint_id, transport: "worker-proxy" })`.

Tier 2 — Chrome KV-chain preference bias. The worker reads `bookmarkDomains()` (strong signal) and `recentDomains()` (weak signal) from the chrome primitives KV-chain via the existing `loadDefaultPreferences()` interface. If the inbound URL's eTLD+1 is in the strong-signal set (bookmarked), the worker prefers the captured-route path even when tier 1 had a stale miss, and boosts the route's `score`. If only in the weak-signal set (visited), the worker drops the residential proxy cost threshold (a visited domain is more likely to accept a direct fetch). No subdomain/path/query pixels leave the KV layer — eTLD+1 only.

Tier 3 — Solana IQ attestation. `IqClient.readRows` returns batched, signed route-capture attestations written on-chain by the unbrowse contract. A row whose `commitment` matches a tier-1 route cache row attests that the capture was witnessed. A row whose `commitment` has NO tier-1 match is a stale attestation; the worker cannot replay it (it's a pointer to a value the local cache doesn't have), but it confirms the route exists. Tier 3 is the slowest layer (network call) and runs only if tiers 1+2 return no decision.

Decision shape:

```ts
interface OnChainRouteDecision {
  action: "replay" | "live_fetch_direct" | "live_fetch_iproyal" | "live_fetch_with_captcha";
  endpoint_id?: string;          // when action === "replay"
  commitment?: string;           // sha256 pointer to the captured route (never the body)
  attested_on_chain?: boolean;   // tier-3 corroborated the route cache hit
  preference_bias?: "strong" | "weak" | null;  // tier-2 signal
  reason: string;                // human-readable, lands in the trace
}
```

## Captcha solver surface (user choice: "Both")

The SDK accepts a `captcha` option on `proxy.fetch()`. Two modes:

Turnkey (default for consumer convenience):
```ts
captcha: { auto_solve: true, vendor?: "auto" | "2captcha" | "capzy" }
```
The worker dispatches through the existing x402/Capzy plumbing at `src/execution/captcha-solve.ts`. Cost settles through the consumer's wallet via `pay.sh` (the only adapter). A wallet-less caller returns 402 `x402_no_wallet` — the turnkey path never silently free-rides. An API-key-wrapped wallet draws the solver fee down from the sponsor budget instead of per-call x402, but the wallet still pays. The vendor field is a hint; `auto` picks Capzy when `UNBROWSE_CAPZY_KEY` is set, falls back to paysponge/2Captcha otherwise.

BYOK (consumer brings their own solver key):
```ts
captcha: {
  auto_solve: true,
  mode: "byok",
  vendor: "capsolver" | "2captcha",
  api_key: "<consumer's key>",
}
```
The SDK calls the solver directly from the SDK consumer's runtime — worker relay is bypassed entirely for the solve call. The worker still observes the solved token and replays the original request (so metering still applies to the replayed fetch, settled via the consumer's wallet). BYOK does NOT exempt the caller from the wallet requirement on the underlying `/v1/proxy` call: the replayed fetch still costs a worker hop, and that hop is paid. CapSolver's unified `TurnstileTaskProxyless`/`HCaptchaTaskProxyless`/`ReCaptchaV2TaskProxyless` task schema is the canonical shape; 2Captcha uses the same task names via its compatible API.

Detection: a captcha challenge is detected by HTTP 403 with `cf-mitigated: challenge` header, OR HTTP 200 with `data-sitekey="..."` in the body (reCAPTCHA / hCaptcha / Turnstile / FunCaptcha widgets all emit this marker). The middleware extracts sitekey via the existing `extractSitekey` helper and dispatches to the solver; on success it injects the solved token per vendor rules (g-recaptcha-response, h-captcha-response, cf-turnstile-response) and replays the request once. On solver failure or no sitekey, the response is returned unchanged with `captcha_solver_status: "failed"` — never a fake-success.

## IPRoyal native at the SDK layer

The existing runtime-layer resolver (`src/execution/proxy-fetch.ts:resolveEgressProxy`) is mirrored as a pure SDK helper at `packages/sdk-v2/src/iproyal.ts`. Same precedence: `UNBROWSE_DIRECT_EGRESS` > `UNBROWSE_PROXY_URL` > IPRoyal (env or `~/.identity/iproyal-creds` file). The SDK consumer can override per-call:

```ts
proxy.fetch({
  url,
  egress: {
    mode: "residential",           // forces IPRoyal
    country: "my",                 // country-lock suffix
    session_id: "sess-abc",        // sticky session
  }
})
```

The `egress` option is sugar over `proxy: "residential"`. When both are passed and conflict, `egress.mode` wins. `country` and `session_id` append to the IPRoyal password as `_country-<cc>_session-<id>` per IPRoyal's documented convention.

Credentials resolution is identical to the runtime layer: env first, file second, never in source, never in logs. The redaction happens before any stderr write.

## Statelessness invariants (mirrors `src/chrome/CONTRACT.md`)

- No module-level state in the SDK helpers. The `Unbrowse` client instance is the only stateful object; helpers take and return values.
- Egress URL resolution is a pure function of `(env, opts)` — same inputs, same output, no side effects.
- Wallet signature is not cached at module scope. Each paid call re-signs via the configured adapter. A wallet adapter that caches its session internally (`pay.sh` does, bounded by its own TTL) is the adapter's concern, not the SDK's.
- The on-chain lookup reads only; it never writes to `contracts.jsonl`, the chrome KV-chain, or Solana. Writes happen on the unbrowse runtime side (route capture, KV puts) — never on the SDK proxy side.
- Captcha token caching is bounded by the solver's own TTL (typically 120s for Turnstile, longer for reCAPTCHA). The SDK caches a solved token in-memory keyed by `(sitekey, page_url)` for the duration of a single `proxy.fetch` call chain (initial + one replay). No cross-call token caching — a fresh solve per call.
- Idempotency: a `proxy.fetch` call with the same `(url, method, body, idempotency_key)` returns the same response without re-charging the consumer's wallet. The worker already enforces this; the SDK surfaces it via the existing `Idempotency-Key` header.
- An API key never pays on its own. The wallet it wraps pays. Code paths that check `agent_id` for paid authorization must also verify a wallet is bound (server-side via the existing sponsor-bindings KV) — a dangling API key with no bound wallet returns 402 `x402_no_wallet`, never a free ride.

## Pointer-over-payload

- The OnChainRouteDecision carries `commitment` (sha256), never the route body, never sealed ciphertext.
- The captcha dispatched-token in the trace is the solver's `token_id` (a pointer), not the solved response value. The solved response is injected into the replayed request and discarded from logs.
- The IPRoyal credentials never appear in any SDK return value, log line, or trace. The egress IP is surfaced as `egress_ip` on the response (already the case in `WorkerProxyResponse`); the full proxy URL is not.

## Default-preference contract

When `onchain: { lookup: true, use_preferences: true }`:
- A bookmarked eTLD+1 (strong signal) prefers the captured-route path even on a tier-1 stale miss, and boosts the route's `score` by 1.5x when tier 1 has a hit.
- A recently-visited eTLD+1 (weak signal) drops the residential-proxy cost threshold — visited domains are more likely to accept direct fetch.
- Neither signal present: tier 1 alone decides.

This mirrors the strong/weak preference contract already shipped in `src/chrome/`. The SDK does not store preferences; it reads them via the same `loadDefaultPreferences()` helper.

## Status tracker

- [x] CONTRACT.md — this file
- [ ] proxy-types.ts extended
- [ ] onchain.ts
- [ ] captcha.ts
- [ ] iproyal.ts
- [ ] client.ts ProxyResource wired
- [ ] backend/src/routes/proxy.ts extended
- [ ] tests/sdk-proxy-onchain.test.ts
- [ ] tests/sdk-proxy-captcha.test.ts
- [ ] tests/sdk-iproyal-resolver.test.ts
- [ ] docs/sdk/*.md regenerated via /banger-skill-builder
- [ ] tsc + bun test green
