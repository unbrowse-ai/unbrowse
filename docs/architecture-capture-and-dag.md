# Capture, Replay, and the Operation DAG

How Unbrowse turns a real browser session into a replayable, dependency-aware
skill — and why the same code path works on every domain.

This is the architectural reference. For agent-experience gaps and known
holes, see `agent-experience-issues.md`. For the dev harness that drives
patches against this surface, see `harness/recursive/README.md`.

## TL;DR

Unbrowse never guesses an endpoint. It observes everything a browser actually
downloaded, reconstructs the exact request, and links endpoints together by
the values they produce/require so multi-step workflows replay deterministically.

```
[Browser session]
  ├── Network (HAR + JS interceptor)        \
  ├── SSR / embedded JSON (__NEXT_DATA__…)   \   capture/index.ts
  ├── JS bundle inference (route patterns)    >  reverse-engineer/index.ts
  └── Rendered DOM (page artifact)           /
                       │
                       ▼
            [Endpoint descriptors]
              requires[], provides[], example_request, example_response,
              response_schema, semantic.action_kind, semantic.resource_kind
                       │
                       ▼
           [buildSkillOperationGraph]              graph/index.ts
              nodes = operations
              edges = (provides → requires) keyed by semantic_type
                       │
                       ▼
                [Workflow DAG]
              executable in topological order; missing_bindings surfaced
              to the agent for manual fill
                       │
                       ▼
              [executeEndpoint]                    execution/index.ts
              replay_contract: parameter_specs + prerequisite_specs +
              next_state — byte-exact reconstruction of what the browser sent
```

## 1. Capture sources

All four sources run on every domain. No per-site enable flags, no
`if domain === "x.com"` switches.

| Source | Where | Fires on |
|---|---|---|
| Network: HAR | Kuri at the CDP layer | every request the browser makes |
| Network: JS interceptor | `INTERCEPTOR_SCRIPT` injected by `runtime/browser-host.ts` | fetch + XHR (catches what HAR misses on SPAs) |
| SSR / embedded JSON | `extraction/index.ts`, `capture/index.ts` | `__NEXT_DATA__`, Apollo state, JSON-LD blocks, Nuxt/SSR payloads |
| JS bundle inference | `execution/index.ts` (`isBundleInferredEndpoint`) | route patterns extractable from webpack chunks |
| Rendered DOM | `execution/index.ts:buildPageArtifactCapture` | structured data from the rendered page when the above yield nothing |

HAR + interceptor are merged on session close. Bundle-inferred routes are
gated as `bundle_routes_only` until corroborated by either an observed
response or extractable DOM data — so synthetic guesses never reach the
marketplace. DOM artifacts are admitted only when a quality check passes
(`pageArtifact.quality_note` blocks low-quality fallbacks).

## 2. Endpoint descriptors

Each captured endpoint becomes an `EndpointDescriptor` with:

- `url_template` with named slots (`/posts/{id}?q={q}&limit={limit}`)
- `method`, captured `headers`, `body` shape
- `response_schema` inferred from observed responses (`inferred_from_samples` count)
- `semantic.requires[]` — params with `key`, `semantic_type`, `source` (`path_template` | `observed_query` | `semantic_requires`), `confidence`
- `semantic.provides[]` — response fields with `key`, `semantic_type` (`form_identifier`, `latest_sender_name`, …), `source`
- `example_request`, `example_response_compact` — preserved verbatim for replay
- `auth_required`, `verification_status`, `reliability_score`

`semantic_type` is the linkage currency. `inferProvidesFromFields`
(`graph/index.ts:463`) walks the response schema and assigns canonical types
based on field names + observed values + structure. `inferRequires` does the
same for inputs. The names are domain-agnostic
(`form_identifier`, not `tweet_id`).

## 3. The operation DAG

`buildSkillOperationGraph` (`graph/index.ts:1190`) consumes the endpoint
descriptors and emits a graph:

- **Nodes** — `operation_id`, `endpoint_id`, plus the descriptor's
  `requires[]` / `provides[]` / `description_in/out` / examples.
- **Edges** — created when one node's `provides[].key` matches another node's
  `requires[].key` of compatible `semantic_type`. `classifyEdgeKind` labels
  the edge (`prefetch`, `dependency`, `pagination`, …).
- **Hard-excluded** operations (`isOperationHardExcluded`, L1145) are removed
  before edge construction — auth probes, telemetry, healthchecks, etc. never
  appear as DAG nodes.

The skill manifest persists the full graph in `operation_graph: { entry_operation_ids, operations, edges }`.

### Workflow DAG = per-resolve projection

When the agent calls resolve, the response includes a `workflow_dag` shaped
to the current intent + context:

```json
{
  "workflow_dag": {
    "skill_id": "...",
    "intent": "...",
    "missing_bindings": ["q", "limit", "page", "source"],
    "operations": [...],
    "edges": []
  }
}
```

`missing_bindings` is the set of `requires` that no upstream node in scope
can produce — these are what the agent must supply (via `-p key=val` on the
CLI, or `params` over the wire). Everything else can be filled by walking
the DAG.

### Reachability and prefetch

- `computeReachableEndpoints` (L1392) — given a set of known bindings, walks
  forward through the DAG. Returns every operation that becomes runnable.
- `getOperationPrefetchTargets` (L1336) — for a not-yet-runnable target,
  walks backward to find the upstream operations that produce its missing
  inputs. Used by execute to topologically sort prerequisites.
- `buildEffectiveBindings` (L1323) — accumulates bindings as upstream
  operations complete, advancing the walk one step.

This is the multi-step replay engine. An agent asks for "the email at
position 0" without knowing it needs `doc_id` first — the DAG walk runs the
search, harvests `doc_id` from `provides`, then runs the detail endpoint
with that binding.

### Feedback loop

`orchestrator/dag-feedback.ts` writes execution outcomes back to the graph.
Successful paths gain weight; failed ones lose it. Feeds into the ranker on
subsequent resolves so the agent's last-known-good route surfaces first.

## 4. Replay precision

`executeEndpoint` reconstructs the byte-exact request. The `replay_contract`
on the trace shows what was reconstructed:

- `parameter_specs[]` — each param's `name`, `location` (`path` | `query` | `body` | `header`), `type`, `required`, `source_kind`, `confidence`. The agent reads this to know what it must supply and what is auto-filled.
- `prerequisite_specs[]` — page-context constraints (e.g., `trigger_url` the request was originally observed from) that the executor enforces or warns about.
- `next_state[]` — observed page destinations and response-shape summary; lets the next operation in the workflow start with correct expectations.
- `payment_requirement` — x402 status if the endpoint is gated by a paywall.
- `sample_request_url` — the literal URL we observed; the diff between this
  and the replayed URL is the agent-supplied params.

Path order, query string ordering, and headers come from the captured
example, not from regex stitching. SSRF protection rejects private IPs and
non-HTTP protocols at execute time.

## 5. Generalisation guarantee

The ranker (`execution/index.ts:rankEndpoints`) is **forbidden** from
containing per-domain registries. Quoting `CLAUDE.md` (project-canon):

> Per-domain registries (e.g. "if domain == x.com and path == /search then
> op SearchTimeline +220") are banned — they don't generalize and they
> masquerade as judgment.

All ranker signals are evidence-derived: BM25 over endpoint text,
URL-path-keyword overlap with intent, schema richness, host pattern
(`api.` / `io.` / `docs.`), method tiebreak, response-shape bonuses.
GraphQL ergonomics (`decomposeGraphqlEndpoint`) parse the captured
`variables` JSON shape structurally — no x.com / linkedin alias tables.

When BM25 ties, disambiguation is delegated to an LLM judge via
`unbrowse rank` (primitive emits evidence; agent reads + decides).

## 6. Known holes (driven by `harness/recursive/`)

The architecture is sound; specific paths still need work. Tracked in
`docs/agent-experience-issues.md` and live-corpus rows in
`harness/recursive/corpus.txt`. Status as of 2026-04-30:

**Closed (with regression tests):**

- **A1** wrong-template literal-leak — `rankEndpoints` penalises -200 per
  non-templated URL segment that doesn't appear in intent or contextUrl.
  Caught r/programming returning for r/singularity intent.
- **A4** GraphQL POST detection by request-body shape (operationName,
  doc_id, fb_api_req_friendly_name, variables+extensions) regardless of
  URL. Catches Facebook persisted queries, LinkedIn voyager, Apollo.
- **B4** SSR payload silent truncation past `MAX_HTML_SIZE`. JSON-LD and
  `__NEXT_DATA__` extracted before truncation now; multiple ld+json blocks
  all surfaced; `__NEXT_DATA__` uses indexOf forward walk.
- **C2** `-p key=val` silently dropped — fixed in CLI parser.
- **C5** captured-error-response (new class) — endpoints whose captured
  example is the API's error envelope (`{status:fail, errors:[…CRITICAL]}`)
  with only error-shaped schema keys get rejected at admission.
- **C7** runnable-false-on-directly-callable-URL (new class) — operations
  with no required bindings AND a fully-resolved URL now report
  `runnable: true` even when not in `chunk.available_operation_ids`.
- **E1** stale endpoints don't auto-deprecate — `recordDagSessionAction`
  now decays `reliability_score` per failure so the existing
  `MIN_PUBLISH_RELIABILITY=0.2` gate filters organically.
- **F2** browser-capture `no_endpoints` returns actionable `next_step`
  (`open_browse_session` vs `abandon_or_authenticate`) with concrete
  suggested commands instead of a one-word error.
- **G1** phantom-endpoint hallucination (new class) — DOM-extracted
  homepage replays with no params and no array-of-items shape get
  rejected at the admission gate.

**Still open:**

- **A2** stale cached skill returned without freshness check (separate
  from E1's reliability decay; this is about the skill cache itself).
- **A3** SSR-only sites with no real API — partially mitigated by B4
  capture, but the agent UX of "this page renders but has no callable
  API" still needs sharper signalling.
- **B1** Kuri HAR misses async fetch/XHR on some SPAs.
- **C3** `--extract` returns `[]` when raw body has data (path mismatch).
- **C4** execute error doesn't tell agent what to do (overlaps F2 but
  for HTTP errors, not browser-capture errors).
- **D1-D3** browse-session handoff: vague next_step, passive capture
  not aggressive enough during handoff, cold Kuri start times out.
- **H1** LinkedIn execute returns empty data despite resolve success.
- **H2-H7** various per-domain blind spots flagged in the 447-session
  analysis.
## 7. Where to read the code

| Concern | Path |
|---|---|
| Capture orchestration | `src/capture/index.ts` |
| JS interceptor injection | `src/runtime/browser-host.ts` |
| Reverse-engineering / endpoint inference | `src/reverse-engineer/index.ts` |
| Operation graph construction + walks | `src/graph/index.ts` |
| Endpoint execution + replay contract | `src/execution/index.ts` |
| DAG feedback loop | `src/orchestrator/dag-feedback.ts` |
| Resolve / Execute API surface | `src/api/routes.ts` |
| CLI parsing (incl. `-p key=val`) | `src/cli.ts:parseArgs` |
| Skill manifest types | `src/types/skill.ts` |

For tests proving the DAG walks behave correctly:
`tests/graph-dependencies.test.ts`, `graph-edge-upsert.test.ts`,
`graph-provides.test.ts`, `graph-session.test.ts`, `dag-feedback.test.ts`,
`reachable-endpoints.test.ts`, `capture-dependency-prefetch.test.ts`.
