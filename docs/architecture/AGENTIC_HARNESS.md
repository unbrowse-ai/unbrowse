# Unbrowse as an Agentic Harness

> Companion: [REMOTE_HARNESS.md](./REMOTE_HARNESS.md) — server half of the same OS.
>
> Status: living architecture plus executable invariants. The canonical resolver lifecycle,
> publication permits, and remote transport gate are shipped; legacy queue/operator convergence
> and durable-job integration remain active work and are labeled below.

Unbrowse should behave as a harness around an agent's web intent, not as a catalog of
browser and API tools. The public contract remains one hole:

```text
intent + URL -> result | one next_step
```

The harness owns selection, capture, validation, promotion, publication, recovery, and
cleanup.

## Pattern mapping

| Harness pattern | Unbrowse application | Current seam |
|---|---|---|
| Lazy skills | Hosts discover only frontmatter; the full `SKILL.md` loads on activation. Root and npm copies must be byte-identical. | `SKILL.md`, `packages/skill/SKILL.md`, `tests/skill-harness-contract.test.ts` |
| Layered memory | Separate curated policy, local learned routes, execution evidence, and shared sanitized skills. Never treat a capture as validated memory. | config, local skill cache, `src/lib/graph-core/trace-store.ts`, marketplace |
| Per-call safety | Classify each operation invocation, not an endpoint forever. Reads may auto-run; mutations, payments, terms, CAPTCHA, and sensitive publication are ask/deny gates. | orchestrator action classification, publish admission, auth/payment gates |
| Context budget | The agent sees result, compact plan, and one recovery step—not HAR, DOM dumps, route catalogs, or internal ranking traces. | `src/agent-path.ts`, MCP agent surface |
| Isolation | Capture/index/publish work runs outside the foreground answer path with typed durable jobs. The foreground does not inherit task logs. | `src/runtime/job-store.ts` plus the live index queue integration are shipped and tested; other job kinds remain |
| Lifecycle hooks | One dispatcher owns observe, validate, promote, demote, publish, and cleanup side effects. Hooks do not leak into agent instructions. | durable reducer/interaction dispatcher + canonical resolver; legacy queue/operator convergence remains |
| Ordered bootstrap | Config and transport initialize before trust; secrets/proxy material only after trust; diagnostics/version remain fast paths. | setup/runtime bootstrap target |

## Memory model

Do not collapse all route knowledge into one cache.

1. **Instruction memory — curated and stable**
   - contribution policy, sensitive-domain policy, approval rules, trusted origins
   - human/project authored; never modified by capture
2. **Discovery memory — local and untrusted**
   - observed request shapes, candidate DAG, browser baseline fingerprint
   - an observation is evidence, not permission and not a publishable fact
3. **Validation memory — local execution evidence**
   - independent API replay result, parity/schema/cardinality verdict, freshness, failures
   - bounded by retention and decay; failures demote rather than accumulate forever
4. **Shared skill memory — remote and sanitized**
   - typed holes, route/DAG shape, public semantics, aggregate attestations
   - no cookies, tokens, HAR bodies, response bodies, PII, or raw credential values

Promotion between layers is explicit and gated. There is no automatic path from an
observed request to public shared memory.

## Canonical route lifecycle

Persist one record per `(principal scope, skill, endpoint, intent shape)`:

```ts
type RouteState =
  | "discovered"
  | "validation_pending"
  | "validated"
  | "publish_eligible"
  | "shadow_published"
  | "public"
  | "stale"
  | "blocked";
```

Required evidence fields:

```ts
interface RouteLifecycleRecord {
  state: RouteState;
  browser_observations: number;
  api_validation_successes: number;
  consecutive_failures: number;
  baseline_fingerprint?: string;
  dag_fingerprint?: string;
  validated_at?: string;
  published_at?: string;
  last_failure_at?: string;
}
```

Transitions:

1. **Cold interaction:** browse/capture, passively observe first-party traffic, compile the
   local DAG, store a browser baseline, transition `discovered -> validation_pending`.
2. **Next matching interaction:** replay the candidate API and compare it with intent,
   baseline, schema/cardinality, safety, and freshness. Pass -> `validated`; fail -> remain
   pending or become `stale` after the failure threshold.
3. **Steady state:** validated matches are API-first. A browser is not opened merely to
   rediscover the same route. Drift, auth changes, or bad parity demote to `stale` and permit
   one new discovery pass.
4. **Publication:** transition through `publish_eligible` only after sanitization,
   contribution policy, ownership/community-shadow policy, and independent evidence gates.
   Publication is idempotent and records the artifact fingerprint.

Do not promise “always API” as an unconditional invariant: correctness, policy, drift, or
revoked authorization must be allowed to reopen discovery.

## Single lifecycle dispatcher

All side effects should flow through one dispatcher rather than capture, execute, CLI, and
API handlers independently publishing or mutating caches:

```ts
dispatchRouteLifecycle(event, context) -> {
  decision: "allow" | "deny" | "ask";
  next_state: RouteState;
  foreground?: AgentResult;
  background_jobs: HarnessJob[];
}
```

Events include `browser_observed`, `api_replay_succeeded`, `api_replay_failed`,
`schema_drifted`, `publish_requested`, `approval_granted`, and `session_closed`.

Rules:

- deny beats ask beats allow;
- protected publication and unsafe mutations are bypass-immune asks;
- workspace/contribution trust is checked before any external hook or publication;
- terminal lifecycle decisions are append-only audit events;
- the agent receives only the result or one executable `next_step`.

## Background work

Every capture/index/validation/publish unit needs a typed ID and permanent terminal state:

```text
cap_<id>  running -> completed | failed | killed
idx_<id>  running -> completed | failed | killed
val_<id>  running -> completed | failed | killed
pub_<id>  running -> completed | failed | killed
```

Job payload and output are disk-backed. Memory retains only status, offsets, and compact
metadata. Completion notification is idempotent; terminal jobs are not evicted until their
owner has received the result. Shutdown handlers are registered during bootstrap and drain
or persist every running job within a fixed deadline.

## Thin-client and remote execution boundary

The remote may rank shared routes, compile sanitized skills, and issue short-lived scoped
egress leases. Origin TLS and response bodies remain local. The legacy `/v1/proxy` terminating
fetch is fail-closed by default; production residential reuse requires a blind CONNECT lease or
provider-issued origin-scoped subcredential. The local side owns browser access and user auth.

A remote capability must bind at least:

```text
origin + method + route fingerprint + principal + audience + expiry + max uses
```

It must not reveal provider credentials to the client. Server-side challenge handling is
for policy-permitted access; it must not bypass authorization, payment, robots, terms, or
human-consent gates. Auth-bearing traffic must not be sent through a TLS-terminating proxy
without an explicit sealed transport design.

## Implementation status (verified)

- **Shipped:** fsync-backed principal-scoped route reducer/store; cold observation → independent
  replay validation → API-only decisions; browser-derived response-snapshot bypass; corrupt
  state quarantine and dead-lock recovery; fenced one-use, artifact-bound publish leases;
  explicit-consent defaults; top-level-allowlisted manifest + DAG publication through one central
  transport with a permit idempotency key; standalone graph/schema publication disabled; agent-surface MCP
  admission; host-issued one-shot permission tokens at the shared execute route; cooperative route
  deadline/disconnect abort; typed durable index jobs with restart recovery.
- **Fail-closed while converging:** legacy publication callers without lifecycle proof cannot
  reach remote transport. Ambiguous remote publish commits consume their permit rather than retrying
  automatically. This preserves local indexing and avoids duplicate sends.
- **Remaining integration:** connect every legacy worker/operator/SDK seam to the canonical
  planner, adopt the durable job store in the remaining capture/validation/publish spools, and carry browser-process and notification
  receipts end-to-end. Do not describe these as shipped until their transport witnesses pass.

## Progressive delivery

### P0 — make the lifecycle true

1. Add the durable route lifecycle store and pure transition function.
2. Route every successful/failed execution and browser observation through it.
3. Prevent capture-only and validation-pending routes from publishing.
4. Ensure result caches cannot skip the validation interaction.
5. Publish manifest + DAG + evidence as one signed, sanitized artifact.
6. Add a three-interaction witness: browse once, validate once, API-only thereafter.

### P1 — centralize harness behavior

1. Replace scattered publish/index side effects with the lifecycle dispatcher.
2. Give background jobs typed IDs, strict states, durable output, and notification-gated GC.
3. Unify bare CLI, `get`, MCP, SDK, and server resolution behind one planner.
4. Add one permission gate for execution, egress, payment, and publication.

### P2 — harden remote execution

1. Fix egress capability negotiation and restrict it to anonymous/public traffic initially.
2. Add origin/method/TTL-bound remote capabilities and audit receipts.
3. Only then consider a sealed credential-bound tunnel or remote browser execution.

## Executable acceptance criteria

- Root and packaged skills are identical and remain within a fixed context budget.
- First cold call opens at most one capture and publishes nothing.
- The validation call executes the learned API, verifies parity, and publishes at most once.
- A third matching call executes the API without opening a browser.
- Failed parity never promotes or publishes and invalidates any cached result that could
  conceal the failure.
- Mutations and protected publication produce `ask`; explicit policy denials produce `deny`.
- Published artifacts contain no credential values, raw HAR/response bodies, or PII.
- Terminal jobs survive process interruption and are never evicted before notification.
