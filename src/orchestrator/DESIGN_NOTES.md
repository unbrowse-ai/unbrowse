# src/orchestrator — Design Notes

## What lives here

Single dispatcher (the OS): selects routes, owns `resolve → browse → observe → compile DAG → replay-validate → promote → publish → reuse`. Validated routes become API-only — browser never reopens for `(principal_scope, fingerprint, intent_shape_hash)`.

## The invariant

**Always consult lifecycle before browsing.** `getRouteLifecycle(identity)` → `decideRouteLifecycleAction(record)` ∈ `{browser_discover, api_validate, api_execute, stop_blocked}`. `discovered|stale → browser_discover`, `validation_pending → api_validate` (parity-checked via `baseline_fingerprint`/`dag_fingerprint`), `validated|publish_eligible|shadow_published|public → api_execute`. Failures demote to `stale` after threshold (2). Use `executeRouteLifecycleInteraction` — never manufacture browser evidence in tests.

## How to add behavior

- New transition: edit `src/runtime/route-lifecycle.ts:reduceRouteLifecycle` (pure) + add a test in `tests/route-lifecycle.test.ts`. Publication requires `api_validation_succeeded` + `publish_eligible` + sanitized artifact + permit — never publish from `discovered`.
- New ranking signal: extend `client/rank-server-first.ts`, not the dispatcher. Dispatcher only reads state; it doesn't rank.
- New publication path: go through `persistRouteLifecycleOutcome` + `issueRoutePublishPermit`; respect `src/harness/memory.ts` last-run/transcript for agent `next_step` fidelity.

## Thin-client boundary

Only `endpoint_fingerprint + intent_shape_hash` cross to remote (for ranking). Remote compiles/ranks, local holds browser + credentials. Legacy `/v1/proxy` terminating fetch is fail-closed — blind CONNECT lease or subcredential required for residential egress.

## Auth artifact bridge (new)

Auth-walled `x.com/home` was a terminal `deny` even when a valid jar existed on disk.
`src/auth/artifact-bridge.ts:buildAuthArtifact(domain)` sources `findBestBrowserSession(domain)` -> `hasAuthenticatedSession` -> 0600 `writeObscuraJar` + `header`. `src/orchestrator/browser-fallback.ts:shouldFallbackToBrowser` now escalates `auth_blocked` as `auth_blocked_but_artifact_present:domain` when `hasAuthArtifact(domain)` is true, so the `force_capture` retry opens obscura **with the jar** (`src/capture/obscura-index.ts` auto-creates an ephemeral dir if `cookiesDir` absent). Opt-out via `UNBROWSE_IMPORT_BROWSER_COOKIES=0`. No values cross the thin-client boundary; jar is `0600` tmp, header stays inside the retry fetch.

