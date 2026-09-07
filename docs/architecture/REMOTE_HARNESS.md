# Remote Harness — Server Side of the Unbrowse OS

> Companion to [AGENTIC_HARNESS.md](./AGENTIC_HARNESS.md). Local harness (`src/`) owns browser + credentials + lifecycle evidence; remote harness (`backend/`) owns ranking, compilation, and scoped egress. Neither may do the other's job.

## Why remote harness exists

Local is untrusted and offline-capable; remote is the shared, policy-enforcing, ranked view every agent queries. Splitting into two halves enforces the thin-client invariant: server never sees values, client never sees inference IP — `src/capture/obfuscate.ts` + `reveng-server-first.ts` (`scripts/thin-client-gate.sh`) is the boundary proof.

## Pattern mapping (remote half)

| Harness pattern | Remote application | Seam |
|---|---|---|
| Lazy skills | `GET /v1/skills/:id` returns frontmatter only; full DAG behind `?expand=dag` with cache | `backend/src/routes/skills.ts` |
| Layered memory | Remote has its own 4 layers: curated allowlists → staged candidate DAG → validation tallies → public sanitized graph (hash-chained via `sealed-ledger`) | `backend/src/services/marketplace.ts` |
| Per-call safety | Same classification as local — reads auto-rank, mutations/payments/publication ask via permit | `backend/src/middleware/auth.ts` + permit check in `POST /v1/skills` |
| Isolation | Reveng/index/ranking run in Workers isolates, not on request path; background queue via KV+DO | `backend/wrangler.toml` KV namespaces |
| Lifecycle hooks | Mirror of `src/runtime/route-lifecycle.ts` — server persists shadow/public with same states, but only after client-supplied `permit_id` proves local `publish_eligible` | `backend/src/services/marketplace.ts` |
| Ordered bootstrap | Worker boots config → KV → auth gate before handling `POST /v1/reveng` | `backend/src/index.ts` |

## Canonical remote transitions

Client: `validated --(publish_requested + permit)--> publish_eligible --POST /v1/skills--> shadow_published --(aggregate attestations)--> public`
Server rejects any `POST /v1/skills` without a fresh `permit_id` tied to `(principal_scope, skill_id, endpoint_fingerprint, intent_shape_hash)` — same key as `src/runtime/route-lifecycle.ts:routeLifecycleKey`. Idempotent on `permit_id`.

## Egress capability (when remote execution is needed)

Local remains capability holder for origin TLS. Remote may issue a blind CONNECT lease or provider subcredential bound to `{origin, method, route fingerprint, principal, audience, expiry, max_uses}` — never the provider's raw API key. Fail-closed: legacy `POST /v1/proxy` terminating fetch stays disabled.

## Status

Shipped: ranking + compilation server-side, thin-client reveng, sanitized staged graph, KV-backed queues. Remaining: Durable Object adoption for capture/validation/publish spools end-to-end (see AGENTIC_HARNESS P1).
