# src/runtime — Design Notes

## What lives here

`route-lifecycle.ts` — fsync-backed principal-scoped store + `reduceRouteLifecycle` pure reducer + `executeRouteLifecycleInteraction` + permit leases (`permit_id`, `claim_id` fencing, idempotent `permit_id`-keyed transport). `job-store.ts` — typed durable jobs `idx_<id>` with `running→completed|failed|killed`, disk-backed payload, notification-gated GC. `permission-gate.ts` — deny>ask>allow, operation-bound one-shot approval tokens, bypass-immune mutation/payment/publication. `lifecycle.ts` — phase attribution for `AGENTIC_HARNESS.md` memory model.

## Invariants

- Every transition is append-only; `routeLifecycleKey = sha256(principal_scope|skill_id|endpoint_fingerprint|intent_shape_hash)` — never raw intent/values.
- `isPublished` gates matter: `browser_observed` on `blocked` is no-op; `api_validation_succeeded` without prior `browser_observations` or mismatched `baseline_fingerprint` is `stale`, not proof.
- `HUMAN_GATED_EFFECTS = {mutation, payment, publication, authentication, challenge}` always `ask` until a host-issued one-shot token claims it (single use, TTL, max 10 min).
- `requiresTrustedWorkspace` ∈ `{hook, publication, mutation}` — deny if `!workspace_trusted`.

## How to add a state

Extend `RouteLifecycleState` + `RouteLifecycleEvent` in `route-lifecycle.ts`, update `reduceRouteLifecycle` and `decideRouteLifecycleAction`, add a witness in `tests/route-lifecycle.test.ts`. Never edit `job-store.ts` transitions directly — reducer is the single source.
