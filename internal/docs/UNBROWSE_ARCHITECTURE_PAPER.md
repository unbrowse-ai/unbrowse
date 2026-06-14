# Unbrowse as a Verifiable Capability Substrate

## Route Reuse, Capability Composition, and the Maintained Trust Layer for Agents

Status: internal architecture paper  
Audience: founders, engineering, research, and paper authors  
Sources: `docs/whitepaper/`, `paper/crypto-was-all-you-needed.md`, `paper/unbrowse-maintenance-network.md`, `internal/docs/concepts/`, and ManicMind architecture notes

---

## Abstract

Unbrowse is usually explained as a faster way for agents to use websites: observe the internal API route once, store the reusable skill, and let later agents execute the route instead of replaying a browser. That is the wedge, but it is not the full architecture. The durable system is a verifiable capability substrate: a shared graph of typed capabilities, each with an interface, provenance, trust state, cache identity, execution path, and settlement policy.

The public whitepaper explains why internal APIs beat browser-first execution when a reusable route exists. The maintenance-network papers explain why a shared graph needs freshness, attribution, and accountability. The signed-stack papers explain why agent actions need identity, witness, seal, cache, and ledger primitives. The missing unifying frame is that all of these are the same architectural object at different layers: a capability record that can be resolved, executed, witnessed, cached, challenged, and paid for.

This paper states that internal architecture. It also names the boundaries we must keep honest: the shipped product has route capture, marketplace reuse, ranking, verification, x402-compatible settlement, and local credential handling; the fuller validator market, cryptographic attestation economy, and bonded route-maintenance network remain partial or reference-stage. The architecture should be built so those layers can arrive without corrupting the shipped wedge.

The project history around ManicMind, ArkLib, Superpattern, ARC, CodeGraff, TinyLLM, imabettingman, and the earlier unbrowse-skill docs gives one additional requirement: architecture is not just a shape diagram. It is a set of boundaries, gates, witnesses, and negative results that prevent the system from claiming more than it has earned.

---

## 1. The Wedge Is Route Reuse, Not Browsing

The first Unbrowse truth is simple:

1. A browser can discover what a website really calls.
2. That discovered route can be normalized into a reusable skill.
3. Later agents can resolve and execute the skill without rediscovering the site.

The product loop in the whitepaper companion docs is already this:

```text
resolve intent -> reuse cache or marketplace route -> capture if missing -> execute -> feed quality back into ranking
```

The important distinction is that Unbrowse is not a generic browser automation wrapper. The browser is the discovery and parity fallback. The durable asset is the maintained map of callable interfaces plus the trust metadata that lets another agent rely on them.

The architectural consequence is that the core system should optimize for route reuse, not browser control. Browser fidelity matters only where the route cannot yet stand alone or where authentication/session behavior requires a browser-like context.

---

## 2. The Capability Record

The internal primitive should be a typed capability record.

```text
CapabilityRecord {
  id: content-derived or ledger-derived pointer
  subject: what this capability does
  interface: stdio | HTTP | browser | MCP | native bridge | pipe
  input_schema: typed args and auth assumptions
  output_schema: typed result and extraction shape
  execution_path: cache | marketplace | live_capture | browser_context | local_pipe
  witness: verification, replay, health, proof, or challenge record
  cache_key: content address of the executable plan and resolved values
  ledger_row: append-only provenance and state transition
  trust_tier: open | trusted | premium
  settlement_policy: free | paid | split | bondable
}
```

This collapses several systems that are currently described separately:

- a web route is a capability record
- a marketplace skill is a capability record
- an MCP tool is a capability record
- an installable agent skill is a capability record
- a local binary or pipe stage is a capability record
- a validator proof or maintenance attestation is a capability record about another capability record

This is the bridge from "routes" to "agent capability commons." The web route graph is the first valuable instance, not the only possible instance.

The record should keep shape and payload separate. Shape fields are small enumerable values kept inline: kind, interface, verb, lifecycle state, trust tier, timestamps, and transition reason. Payload fields are pointers: captured examples, response bodies, credentials, provenance text, benchmark logs, and receipts. The signature must bind the resolved payload hash, not just the pointer string.

### Compatibility Ladder

The skill/capability record should also be a compatibility standard. Clients should not need to know whether a result came from a native route, an installed skill, an MCP tool, a borrowed local primitive, a marketplace endpoint, or a browser fallback. They should target one return contract.

The standard client-facing envelope is:

```text
CapabilityResult {
  status: ok | needs_input | payment_required | auth_required | unavailable | error
  kind: stable capability kind name
  version: schema version
  source: native_route | installed_skill | mcp_tool | local_primitive | standard_adapter |
          marketplace_endpoint | indexer_contribution | browser_capture_fallback | unavailable
  data: typed result pointer or inline small value
  requirements: auth, payment, approval, dependency, browser, or waiting blocks
  artifacts: content-addressed outputs, receipts, screenshots, traces
  evidence: journal rows, verification receipts, and launch witnesses
  next_action: retry, approve, install, sign_in, pay, browse, wait, abort
}
```

Backend resolution can then borrow primitives through a nested fallback hierarchy:

```text
client asks for capability kind
  -> native route
  -> installed skill implementation
  -> MCP/tool implementation with same schema
  -> local primitive with compatible kind/version
  -> agent standard adapter
  -> marketplace route or paid endpoint
  -> indexer contribution row promoted into policy or discovery
  -> browser capture/replay fallback
  -> typed requirement/unavailable block
```

The kind name is the crossing contract. The cloud may know only `kind: cargo.build` or `kind: web.search.execute`; the local runtime maps that kind to a binary, skill, MCP tool, route, or browser plan inside the user's trust boundary. This lets Unbrowse borrow primitives without forcing every client to learn every backend implementation.

Compatibility should be nested, not flat. A narrow skill can satisfy a broader standard if it returns the required envelope fields and declares which optional fields it cannot provide. A richer backend can add artifacts, traces, and verification receipts without breaking thin clients. The rule is backward-compatible minimum shape plus explicit capability extensions, never opaque ad hoc JSON.

This is also why generic catch-all tools are weaker than named typed cells. A single `paid_fetch` or `run_tool` endpoint makes the model hand-construct URLs, payloads, and policy. Named capability kinds give clients discoverability, schemas, permissions, result shape, and fallback semantics.

### Bridge Manifest and Shipped Acceptance Contract

This compatibility ladder is now an executable contract, not only prose. The source of truth is `src/superpattern/bridge-manifest.ts`, surfaced locally by:

```bash
unbrowse contract surface
```

and by the backend route:

```text
GET /v1/contract/surface
```

The manifest must expose:

- `claim: one-node-layered-stack`
- `cli_bridge.tool: unbrowse contract surface`
- `cli_bridge.exposes: holes-only`
- `cli_bridge.canonical_verbs: [create, act, read]`
- `compatibility.result_contract.name: CapabilityResult`
- `compatibility.result_contract.invariant: backward-compatible-minimum-shape`
- `compatibility.fallback_hierarchy[]`, in ranked order
- `compatibility.indexer_contribution.format: capability-knowledge-row`
- legacy aliases such as `resolve -> read resolve`, `execute -> act execute`, and `publish -> create publish`

The paper therefore admits only one client-facing compatibility contract. The CLI may keep old command names for users, but agents should reason through `create`, `act`, and `read`. Backward compatibility is a declared alias table, not a second architecture.

Acceptance criteria for this layer:

1. Local CLI stdout for `unbrowse contract surface` is parseable JSON with no log prelude.
2. Local CLI `unbrowse read version --json` reaches the v7 eval path and returns `op_kind: eval:version`.
3. Backend `/v1/contract/surface` returns the same compatibility object as the local manifest.
4. Staging `/v1/contract/surface` serves the same `CapabilityResult` contract and fallback order after deploy.
5. Public-facing copy describes the client as a bridge boundary, not as the owner of server graph/control internals.
6. Tests cover unit shape, backend route parity, CLI e2e, agentic UX parseability, and paper-to-manifest alignment.

### Bookmark-Derived Agent Harness

Agentic UX should be tested against the surfaces the operator actually revisits, but local browser history is private substrate. The architecture therefore treats browser profile metadata as a host-only signal. `unbrowse read auth-inventory --json` can scan Chrome, Dia's Chromium profile, and Firefox; it returns domain rows, visit counts, bookmark booleans, cookie names, and scores, but never emits bookmark paths, history paths, query strings, cookie values, or decrypted payloads.

Dia is now a first-class inventory source because it is the browser where many agent tasks actually happen. The CLI supports:

```bash
unbrowse read auth-inventory --json --dia-only
```

and the source ledger distinguishes Dia from Chrome:

```text
dia:/Users/.../Dia/User Data/Default
```

The prompt harness compiles that host-only inventory into cases:

```bash
bun scripts/bookmark-prompt-harness.ts --dia-only --selftest \
  --out harness/probes/bookmark-derived-corpus.txt \
  --cases harness/probes/bookmark-derived-cases.json
```

Each generated case has:

- an origin-only URL such as `https://github.com`
- a canonical command shape: `read resolve`
- a dry-run CLI plan such as `unbrowse read resolve --intent ... --url https://github.com --json`
- a lane such as `auth-workflow`, `code-repository`, `ai-service-console`, `documentation-help`, or `web-research`
- a Plan -> Build -> Test -> Judge tree
- acceptance rules requiring the capability envelope to return useful data, requirements, or `next_action`

This gives Unbrowse a practical agentic UX harness without converting private browsing history into a dataset. The harness may learn that Dia frequently visits GitHub, X, Gmail, AI service consoles, documentation, or market/account surfaces. It may not learn which exact private repository path, mail thread, Notion page path, or query token was visited. The case generator deliberately emits origins and intents, not raw URLs.

The harness is also a bridge-contract witness. Before reporting success in `--selftest`, it calls `unbrowse contract surface`, requires clean parseable JSON, verifies that `read` is a canonical bridge verb, and runs `unbrowse read version --json` through the installed local package. A generated prompt is therefore not only a benchmark row; it is a client compatibility test that asks whether a real agent can select `read resolve`, receive a `CapabilityResult`, and continue through data, requirements, evidence, or fallback action.

Unit tests prove the generator and privacy boundary; they do not prove agent experience. Agent-experience acceptance requires a live harness drive:

```bash
bash harness/probes/agent-experience.sh \
  --corpus /tmp/unbrowse-dia-smoke-corpus.txt \
  --timeout 45
```

The harness writes `harness/runs/<run-id>/manifest.json`. The agent then judges that manifest using `harness/probes/JUDGE.md`. A green unit suite cannot replace this judgment. It can only make the harness easier to trust.

Direct-document successes must still be agent-shaped. If the CLI can answer from a page document without opening a browser, the result must include an `available_operations` entry, `suggested_next_operation_id`, and `next_action`. Raw page data with no next operation is a partial UX failure even when the HTTP and extraction work succeeded.

Live witness on 2026-06-12:

```bash
UNBROWSE_NO_SWEEP=1 bun scripts/bookmark-prompt-harness.ts --dia-only --limit 4 --selftest \
  --out /tmp/unbrowse-dia-agent-corpus.txt \
  --cases /tmp/unbrowse-dia-agent-cases.json

UNBROWSE_NO_SWEEP=1 UNBROWSE_BIN=unbrowse bash harness/probes/agent-experience.sh \
  --corpus /tmp/unbrowse-dia-agent-corpus.txt
```

The first run, `harness/runs/2026-06-12T05-19-59Z-1b1b01e5/manifest.json`, proved the bridge contract but exposed a UX gap: auth-shaped cases returned a generic direct-document operation or external-search source, not a precise auth handoff. The corrected run, `harness/runs/2026-06-12T05-28-24Z-83c870a7/manifest.json`, closed that gap. A later run exposed a second agent-experience bug: `mail.google.com` could compute the auth handoff but lose the race to the CLI timeout, yielding `cli_timeout` instead of a dispatchable next action. A source-mode witness, `harness/runs/2026-06-12T06-59-32Z-bc872523/manifest.json`, re-drove the four Dia-derived probes after fixing the parser and auth-gate path. The first installed-package witness, `harness/runs/2026-06-12T08-47-18Z-b26ecf0d/manifest.json`, proved the package path but still used the legacy `resolve` alias inside the harness. The canonical installed-package witness is `harness/runs/2026-06-12T09-03-02Z-fcaab9ba/manifest.json`, produced through `npm i -g .`, `UNBROWSE_BIN=unbrowse`, and `resolve_cmd: read resolve`. After the explicit login-keychain auth fix and a fresh `npm i -g .`, `harness/runs/2026-06-12T09-52-44Z-70a02786/manifest.json` re-drove the same Dia-derived installed-CLI path and again settled all four probes with `resolve_cmd: read resolve`. A five-probe acceptance witness, `harness/runs/2026-06-12T11-26-01Z-17dd98bf/manifest.json`, extended coverage to a documentation/web-research lane (`docs.getfoundry.app`) alongside the auth (`x.com`, `mail.google.com`, `fal.ai`) and public-repository (`github.com`) lanes. All five probes exited `0`, every probe reported `browser_avoided: true` with `kuri_pids_alive_after_run: 0` and `visible_chrome_present: false`, and the agent judged every probe WORKS or WORKS-WITH-NOTE against `harness/probes/JUDGE.md`: auth-shaped lanes returned `suggested_next_operation_id: auth-handoff` with a `requirements.auth_handoff` block and an `unbrowse auth '<origin>'` next action (`mail.google.com` settled in 337ms, no `cli_timeout`), the public lane returned `direct-document-read` first, and the documentation lane resolved through the keyed web-search provider with a `read resolve` retry command. The same session armed the gated staging acceptance test (`UNBROWSE_STAGING_ACCEPTANCE=1`), which passed: live `unbrowse-backend-staging.lewis-6d8.workers.dev/v1/contract/surface` matched the local `bridgeManifest()` on `claim`, `cli_bridge.canonical_verbs`, `compatibility.result_contract`, `compatibility.fallback_hierarchy`, `compatibility.indexer_contribution`, and `runtime_authority` — the paper, local CLI manifest, backend handler, and live staging response agree on one `CapabilityResult` compatibility contract.

In the canonical installed-package witness, all four probes exited `0`, avoided visible browser launch, left no Kuri process alive in the manifest, and returned agent operations. Auth-shaped probes (`x.com`, `mail.google.com`, `fal.ai`) put `auth-handoff` first, set `suggested_next_operation_id: auth-handoff`, include `requirements.auth_handoff` with domain, web login URL, reason, login surfaces, and a canonical retry command using `unbrowse read resolve`. They preserve `direct-document-read` as a secondary public-shell operation, but do not wait on expensive public interstitial discovery before handing auth back to the agent. The public GitHub probe returns direct-document first and its `next_action.command` also uses `unbrowse read resolve`. A stricter 45-second rerun, `harness/runs/2026-06-12T08-45-13Z-bac273d8/manifest.json`, and the first canonical run, `harness/runs/2026-06-12T08-59-37Z-492e2939/manifest.json`, are intentionally not acceptance witnesses because `mail.google.com` hit `cli_timeout`; auth-shaped tasks now return a local auth-handoff envelope before that race. This is the intended hierarchy: when the task is public, read the document; when the task is auth-shaped, authenticate first and then retry for authenticated data.

Acceptance criteria for this harness:

1. Dia default profiles are discoverable without passing a Chrome override.
2. `--dia-only` scans Dia and skips Chrome/Firefox default profiles.
3. History and bookmark cases are origin-only and contain no path, query, or hash material.
4. Synthetic Dia tests prove host-only history/bookmark extraction and distinct `dia:` source provenance.
5. Generated cases all use canonical `read resolve` and include Plan -> Build -> Test -> Judge nodes.
6. Generated CLI plans all start with `unbrowse read resolve`, include `--intent`, `--url`, and `--json`, and declare `CapabilityResult` as the expected contract.
7. Harness `--selftest` dogfoods `unbrowse contract surface` and `unbrowse read version --json` before declaring success.
8. Agent-experience claims are accepted only after a live `harness/probes/agent-experience.sh` run produces a manifest and the agent judges it against `harness/probes/JUDGE.md`.
9. Direct-document resolve results include an agent operation, suggested operation id, and next action, even when no route endpoint exists yet.

### Indexer Contributions and Collective Learning

Indexers should be first-class contributors to the capability graph. They do not only submit captured routes; they can submit API recipes, workaround patterns, failure patterns, performance optimizations, schema hints, auth notes, and best-practice playbooks in the same machine-readable contribution format.

A contribution is a candidate capability-knowledge row:

```text
IndexerContribution {
  type: api_recipe | workaround | failure_pattern | performance_optimization | schema_hint | best_practice
  target: domain, service, capability kind, or skill id
  what_failed: failed approaches, errors, wasted calls
  what_worked: reproducible method, endpoint, auth assumptions, steps
  savings: tool calls, latency, token cost, browser work avoided
  provenance: session id, trace pointer, source lines, agent, date
  verification: unverified | issue_open | verified | merged | deprecated
  promotion_target: skill repo, route graph, registry row, docs projection
}
```

The graph consumption order should be:

```text
authoritative skill/capability contract
  -> merged collective-knowledge rows
  -> local cached discoveries
  -> open agent-discovery issues
  -> fresh discovery
  -> contribute back if useful
```

This turns "lookup before browser" into architecture. Before a resolver descends into browser capture for a domain, it should check whether an indexer has already contributed a direct API recipe, JS-bundle mining path, known hostile-browser pattern, or failure warning. The hierarchy is API-first: direct API, API via static bundle analysis, API via network intercept, browser automation, manual interaction. Browser work is a fallback after shared knowledge is exhausted, not the first reflex.

Contribution confidence should decide the lane. A verified recipe can enter through PR-style review into the skill or graph knowledge base. A plausible but unverified discovery can enter as an issue or pending row with `needs_verification`. Failure patterns are valuable even before a replacement path exists, because they prevent repeated waste.

Best practices should use the same lane as recipes. A discovered "how to index this class of site" pattern is not prose advice once it has target, reproduction steps, failure modes, evidence, and savings fields. It is a candidate resolver primitive. The registry can promote it into a skill instruction, route-family detector, verifier fixture, fallback policy, or docs projection depending on which compatibility contract it satisfies.

Indexer contributions should therefore compile toward the same `CapabilityResult` envelope. A direct API recipe may become an executable endpoint; a JS-bundle mining pattern may become a discovery backend; a failure pattern may become an early `unavailable(reason)` or `avoid_path` decision; a best-practice row may become a policy check before browser fallback. The client does not need to know whether the successful answer came from a route, skill, MCP tool, local primitive, paid endpoint, or indexed best-practice fallback. The compatibility standard absorbs the source and exposes the result.

### Harness-First Decomposition

When a user asks for an app-like outcome, the reusable primitive is often not the visible app. It is the data harness, source connector, route family, or action primitive the app depends on. Unbrowse should factor work into:

```text
source harness -> reusable capability record
thin consumer -> one workflow or view over that harness
```

For example, if many tasks need Telegram, GitHub, sportsbook, calendar, or travel data, the reusable asset is the connector/harness that reliably gets that data, not each downstream report or generated UI that consumes it. The consumer can be small because the harness becomes a graph capability available to later requests.

This also gives a rule for when to build a primitive. If a class of tasks repeatedly forces the agent to re-derive the same parser, navigation step, schema extraction, login dance, or route selection logic, build that mechanism as a named gated capability. The model should select and compose primitives; it should not repeatedly rediscover mechanics that can be made executable and tested.

Before building a new primitive, the runtime should inventory declared substrate. Existing dependencies, scaffolded adapters, dormant tools, local skills, and prior-loop artifacts may already contain the mechanism the task needs. Rebuilding a capability that the package graph or registry already declares is not progress; it creates a parallel substrate and hides the real integration gap. The first step is therefore "what executable thing is already declared, and why is it not in the live path?"

Reusable capability types should separate runtime code from instance configuration. If five tasks differ only by account id, keywords, output channel, prompt template, site collection, or alert policy, the right artifact is one generic runtime plus five manifests, not five forked scripts. The manifest carries parameters, schemas, permissions, bindings, and view defaults; the runtime reads the manifest and behaves. Creating a new instance should be a manifest admission path, not a code fork.

If the current repo, runtime, or trust boundary cannot execute the real implementation, do not fake shipped status. The correct artifact is a typed handoff: interfaces, schemas, stubs that fail explicitly, live probes, threat notes, and exact pointers to the repo/runtime that can own the implementation. A handoff seed with a typed signature is useful; code landed where it cannot run is a fabricated green.

### Capability Views

The compatibility standard should include renderable views, not only machine values. A capability that completes should be able to return a `view_spec` describing how its result, requirements, actions, and evidence should render in a client. The client remains a renderer of a small primitive set; the capability owns the presentation contract for its own output.

For UI-bearing capabilities, the view spec is required, not decoration. A route or skill that promises an app, dashboard, approval panel, receipt view, or inspector but emits no view frames is malformed in the same way as a route without an output schema. Fallback client rendering can exist for debugging, but it should not be the shipped surface for a capability whose contract includes UI. The capability owns the presentation contract; the client interprets a shared primitive registry.

The view contract is:

```text
CapabilityView {
  capability_id: stable id
  run_id: durable execution id
  view_version: schema version
  root: primitive node tree or content-addressed view pointer
  actions: typed follow-up actions with capability kinds
  state_binding: pointer to shared UI/runtime state
  redactions: fields hidden from public/client surfaces
}
```

Views should compose the same way capabilities compose. A route execution can embed its payment requirement view, a verification receipt view, a browser-capture screenshot view, or a child capability view inline. The UI therefore follows the operation DAG instead of becoming a hand-authored parallel layer.

The surface must hide developer chrome by default. Run ids, slugs, hashes, raw endpoint ids, and trace internals belong in expandable evidence panes or developer tools, not the primary user surface. The primary view should render human-readable status, action, value, and risk. A screenshot or vision-model UX lane can gate this property for app surfaces.

UI state belongs to the shared runtime store, not to one mounted screen. Consumed requirement ids, active run ids, dismissed panels, last-seen receipts, and in-flight progress survive remounts and transport changes. Otherwise the same requirement or status card reappears because a local view forgot it had already been consumed.

Streaming renderers must preserve chunk boundaries. Normalization that is safe on a complete string can corrupt a partial accumulator; trailing whitespace, pending spec fences, and partial JSON nodes may be load-bearing until the stream closes. Streaming view updates should use add/replace/remove operations over stable node paths rather than reparsing and trimming the whole surface every delta.

### Translation Boundary

Unbrowse needs a translation layer between internal mechanism language and user/client language. Internal records may need exact terms such as endpoint id, trace hash, auth class, replay quarantine, schema drift, verifier receipt, or trust tier. Primary user surfaces should translate those into observable user moments: working, needs sign-in, payment required, verified, cannot verify, route changed, approval needed, saved time, or failed safely.

The rule is:

```text
user moment -> rewrite into user-facing status/action/risk language
implementation detail -> hide by default, expose only in evidence/developer panes
claim scope -> preserve exactly; never upgrade during translation
```

This is not copy polish; it is a boundary. A route card should not leak model ids, codenames, raw HTTP status trivia, trace slugs, MIME types, internal benchmark names, or anti-abuse terms unless the user opens evidence details. Conversely, it must not replace "unverified" with "verified-looking" language or turn a partial/proposed route into a shipped one.

The translation layer should use a small mechanism taxonomy:

- evidence: witness, receipt, replay, verification, provenance
- selection: ranking, routing, retrieval, confidence, fallback
- alignment/policy: permission, approval, auth, safety class, mutation class
- failure/repair: unavailable, blocked, stale, rejected, repaired, retired
- structure: capability kind, schema, dependency, DAG, lifecycle state

Every visible status should map back to one of those mechanisms and to a source row. This keeps public surfaces understandable without losing auditability.

---

## 3. The Three Execution Planes

Unbrowse needs three execution planes that share the same capability record shape.

### Plane A: External Web Descent

This is the whitepaper wedge.

```text
intent -> route shortlist -> execute route -> browser fallback when needed
```

The agent descends from task intent toward website behavior. It uses the highest layer that can complete the task correctly: cache first, marketplace route second, live capture or browser context only when reuse cannot settle the task.

The trust verb here is sign-to-act. The agent proves it is authorized to execute.

### Plane B: Shared Graph Maintenance

This is the maintenance-network layer.

```text
route claim -> proof/verification -> challenge window -> trust-tier state -> payout or penalty
```

The graph is not just stored. It decays and must be maintained. A route freshness claim is useful only when it can be checked, challenged, and attributed. Open routes can remain low-friction. Higher-trust routes need stronger maintenance claims.

The trust verb here is attest-to-quality. The maintainer stands behind a claim about freshness, reliability, schema, and safe execution.

### Plane C: Local Capability Ascent

This is the missing inverse of the web-descent paper.

```text
binary -> pipe -> binary -> capability
```

Many agent tasks are not hostile website traversal. They are local composition: shelling a binary, piping output, calling a native bridge, using a local tool. The same capability record should model this. A pipe edge should be pointer-only, content-addressed, and wallet-approved before values cross process boundaries.

The trust verb here is approve-to-release. The wallet authorizes a value to move from one local capability into the next.

Together, these planes make the full substrate:

```text
web descent:        sign to act outward
graph maintenance:  attest to quality over time
local ascent:       approve value release inward
```

---

## 4. Local/Cloud Isomorphism

ManicMind's Unbrowse notes make a useful doctrine explicit: the cloud holds the moat, the local binary holds pointers to the things only the user's machine can execute.

That split should be architectural, not incidental.

| Side | Owns | Must Not Own |
|---|---|---|
| Cloud graph | route marketplace, ranking, decision traces, contributor lineage, verification state, settlement rows, public route metadata | cookies, browser session payloads, private vault material, local-only binaries |
| Local runtime | browser, cookies, vault, OS process boundary, private capture session, native bridge, execution secrets | canonical ranking truth, marketplace state, global trust claims |

The row schema should mirror across both sides. A local capability pointer and a cloud capability row should describe the same object with the same shape, even when the payload is local-only. Drift between the two is not a harmless cache miss. It is a substrate-isomorphism break and should be raised as a named contract failure.

This gives Unbrowse a clean answer to centralization:

- the moat is the maintained graph
- the user's trust boundary is the local runtime
- the cloud stores pointers and public claims about private capabilities
- the local runtime resolves private pointers into executable context

The local runtime is therefore not a thin client. It is the authority for actions that require the user's machine, browser, wallet, cookies, or filesystem. The cloud is the authority for shared discovery and public trust state.

Cloud/server claims require durable state evidence. A route backed by a per-request ephemeral ledger, a server compiler with zero callers, or a declared envelope field that no server path reads is a stub even if the endpoint returns HTTP 200. The architecture should name which side is substrate today, which side is facade, and which durable store proves the server owns the claimed responsibility.

For a local-first runtime, a pipe or Unix socket is the default boundary. A localhost HTTP server is a distribution surface, not the substrate itself. The same core may expose `serve` for ecosystem clients, but the desktop/app path should not depend on port agreement, TCP health checks, or a daemon it has to supervise when a spawned binary or socket broker would carry the boundary more directly.

When a local broker is enough, it should not open a listening port. A Unix-domain socket or equivalent OS-local channel can delegate access to filesystem permissions and process ownership, removing an avoidable network-auth surface. Remote clients can still use an HTTP or MCP facade, but local cell-to-cell dispatch should behave like an OS primitive the runtime invokes, not a network service the user must secure.

The wire contract should be transport-invariant. A capability can cross native IPC, stdio, socket, HTTP, MCP, or browser message channels, but the envelope, frames, terminal states, and receipts should remain the same shape. Transport names are deployment details unless the transport itself changes authority, latency, isolation, or availability. When the host already has a first-class IPC or native registry, wrapping the same call in an HTTP or MCP child layer is overhead unless it buys a real boundary.

Authority should cross the local/cloud boundary through one declared membrane, not through scattered caller conventions. The UI body knows how to ask for a capability; it should not know which tools, cookies, wallets, or networks satisfy it. The membrane carries explicit fields such as `network_allowed`, `timeout_ms`, `mutation_class`, `payment_class`, and `credential_scope`. The router below the membrane can choose local-only, web, paid, or browser-backed paths, but the permission declaration lives at the crossing point. A boundary test should prove both directions: local-only routes cannot leak upward to network execution, and web routes cannot bypass the membrane's declared authority.

The local substrate should expose intent modes, not a hard-coded host menu. A caller can request local execution, remote execution, browser execution, or paid execution, but it should not enumerate provider-specific backends such as individual cloud hosts, sandboxes, or SSH targets in the capability record. Backend selection belongs to the resolver and policy layer, where latency, trust tier, cost, region, auth, and availability can be ranked. If a requested mode is not shipped, the result is a typed `unavailable(mode_not_shipped)` requirement, not an invented success.

Standard-compatible facades should sit next to the authority they wrap. If an OpenAI-compatible endpoint, MCP server, or HTTP API is only a facade over a local binary or private runtime, the facade must run where it can actually execute that runtime or reach the supervising process. A pure edge worker cannot pretend to own a local subprocess. The wrapper contract should declare process invocation, stdin/stdout behavior, streaming shape, timeout, and deterministic mock runner for tests.

### Stateless Binary Runtime

The product substrate should be a stateless binary, not an Unbrowse server that owns hidden runtime state. Server-shaped entrypoints may still exist for compatibility, MCP hosts, local debugging, or cloud graph APIs, but they are facades over a single-shot capability invocation. The durable state lives in explicit stores: the route graph, content-addressed cache, ledger rows, credential vault, and browser profile authority. The process that executes a command should be disposable.

The local binary contract is:

```text
unbrowse <verb> <capability> --json
  -> read explicit inputs and pointers
  -> acquire only the leases needed for this invocation
  -> execute the selected capability
  -> emit CapabilityResult
  -> release browser/process/file locks
  -> exit with no hidden session authority
```

The contract is also projected in `src/superpattern/bridge-manifest.ts` under:

```text
runtime_authority.local_substrate: stateless_binary
runtime_authority.invocation: unbrowse <verb> <capability> --json
runtime_authority.process_model: single_shot
runtime_authority.browser_primitives.owner: binary_owned_lease
runtime_authority.browser_primitives.module: src/kuri/stateless-primitive.ts
runtime_authority.browser_primitives.returns: CapabilityResult
runtime_authority.forbidden_authorities:
  - long_lived_local_unbrowse_server
  - shared_kuri_tab_registry
  - kuri_broker_http_api
  - background_browser_worker_without_lease
```

This removes a class of race conditions where a long-lived local server, Kuri process, tab registry, or background worker becomes the real owner of browser state. A running helper can exist only as an implementation detail with an explicit lease, heartbeat, timeout, and kill policy. It is not the architecture. The authority boundary is the binary invocation plus the state pointers it is allowed to touch.

Kuri should therefore stop being a second product runtime. Its useful primitives should be baked into the binary behind narrow modules:

```text
direct_cdp.spawn_chrome(scope, mode)
direct_cdp.create_target(url, policy)
direct_cdp.navigate(target, url)
direct_cdp.capture_network(target, filters)
direct_cdp.read_dom(target)
direct_cdp.solve_or_report_interstitial(target)
direct_cdp.release(target)
```

Those primitives can still use Playwright, Chrome DevTools Protocol, a helper process, or a browser driver internally, but callers never talk to a stateful Kuri authority. They call the capability runtime. The runtime owns the lifecycle for the duration of the invocation and records the exact lease in the witness. If the helper dies, the result is `unavailable(browser_runtime_failed)` or a typed fallback path, not a stuck shared session.

This also changes test strategy. A browser-capability test should prove:

1. two concurrent binary invocations cannot claim the same exclusive browser lease;
2. a failed invocation releases tab, process, lockfile, and queue state;
3. no background Kuri process remains after the binary exits;
4. direct-document and cached route paths do not initialize browser state;
5. browser fallback records the lease id, profile scope, and release witness.

The same section absorbs the useful parts of external scraping frameworks such as Scrapling without adopting their architecture wholesale. The reusable ideas are adaptive selector relocation, explicit session-type routing, blocked-request detection, pause/resume checkpoints, proxy and DNS-leak policy, and a parser/fetcher split. In Unbrowse these are not a separate crawler daemon. They are capability primitives inside the stateless binary:

```text
route_fetcher: fast HTTP/TLS/browser-compatible request path
dynamic_fetcher: browser-context fetch when JavaScript execution is required
adaptive_selector: relocate DOM evidence after layout drift
blocked_detector: classify login wall, Cloudflare wall, CAPTCHA, rate limit, or empty shell
crawl_checkpoint: explicit content-addressed queue state for multi-page discovery
network_policy: proxy, DNS, resource-blocking, and robots/terms posture
```

Each primitive must normalize back into `CapabilityResult`, `EndpointDescriptor`, or `IndexerContribution`. If it cannot emit one of those contracts, it is a helper routine, not an architectural primitive. This keeps the binary small at the surface while letting the implementation borrow proven scraper/fetcher mechanics where they reduce browser fallback cost.

The current browser primitive adapter is `src/kuri/stateless-primitive.ts`; the path is retained for import compatibility, but the adapter no longer imports `src/kuri/client.ts` or talks to a Kuri broker. It launches an owned Chrome/CDP lease through `src/cdp/chrome.ts`, creates a fresh target through `src/cdp/target.ts`, applies wallet-scoped auth through CDP `Network.*`, emits a compact interactive snapshot through `Runtime.evaluate`, and closes the lease before returning. Its internal `StatelessResult` is not the client contract; `statelessResultToCapabilityResult` converts success and failure into the bridge envelope. A failed helper therefore returns `status: unavailable`, `source: unavailable`, a typed `requirements.unavailable.reason`, and a `next_action`; a successful helper returns `source: browser_capture_fallback` with a `browser_lease` witness. This is the concrete migration path for ripping Kuri out as an independent product runtime without losing the proven browser mechanics.

---

## 5. The Operation DAG Contract

The earlier unbrowse-skill architecture names the most important product invariant: Unbrowse should never guess an endpoint. It observes real behavior, builds endpoint descriptors, connects them by typed dataflow, and replays only what has an executable contract.

The durable execution shape is:

```text
browser session
  -> captured requests, SSR payloads, bundle hints, DOM artifacts
  -> EndpointDescriptor[]
  -> operation DAG
  -> intent-shaped workflow projection
  -> topological execution with bindings
  -> execution feedback back into graph quality
```

Each endpoint descriptor should carry:

- method, URL template, headers, body shape, and example request
- response schema and compact example response
- `requires[]`: typed bindings the endpoint needs
- `provides[]`: typed values the endpoint can emit
- auth requirement and mutation class
- verification status and reliability score
- replay contract and prerequisite context

The graph edge currency is semantic binding, not domain naming. A route that emits a document id and a route that needs a document id should connect because they share a typed value, not because a hard-coded domain rule knows the site.

This is the difference between scraping and compiling. Scraping extracts a page. Unbrowse compiles observed behavior into a reusable workflow graph.

The operation DAG should be reconstructable from ledger rows. Parent/child edges, `requires`/`provides` bindings, blocked-by edges, verifier corroborations, and lifecycle transitions can have fast materialized read models, but the source of truth is the append-only event stream. Moving the ledger should move the graph; rebuilding projections should reproduce the same executable DAG. Persistent search indexes, catalog rows, and benchmark corpora are accelerators and projections, not independent graph stores.

---

## 6. Firmaments: Hard Boundaries Between Planes

The ARC and Superpattern repos use a useful word for architectural boundaries: firmaments. The important part is not the metaphor; it is the rule:

> No module crosses a boundary except through the named contract.

Unbrowse needs these firmaments:

| Boundary | Above | Below | Crossing Contract |
|---|---|---|---|
| discovery vs execution | intent and candidate selection | byte-exact replay | selected capability id + bindings |
| fuzzy vs exact | semantic search and ranking | content-addressed execution | resolved object hash |
| product vs instrument | CLI/MCP/SDK behavior | benchmarks and gates | named witness artifact |
| public vs internal | docs, papers, README | capture internals and operator logic | paper gate + leak guard |
| auth/money vs route logic | wallets, cookies, payments | route descriptors and graph edges | explicit authority token or payment receipt |
| local pipe vs web route | native processes and files | HTTP/browser calls | pointer-only capability record |

The practical rule is simple: an agent-facing surface may ask the verification layer for a verdict, but it must not import the benchmark as product logic. A ranker may consume reliability scores, but it must not contain per-domain magic tables. A public paper may describe the system's trust model, but it must not reveal the closed capture machinery.

---

## 7. The Public Boundary and the Internal Boundary

The system must maintain two boundaries.

### Public Boundary

Public docs may describe:

- the route-reuse wedge
- local-first capture
- skills and endpoints
- marketplace reuse
- ranking by relevance, reliability, freshness, and verification
- x402-compatible paid access
- practical verification and drift handling
- the fact that richer validator markets and bonded attestations are roadmap or reference-stage

Public docs must not describe:

- closed capture/reverse-engineering internals
- operator-only ranking or anti-abuse mechanisms
- sensitive economic constants not intended for public release
- claims that are not shipped or runnably witnessed

Audience-facing docs and internal docs should live in physically separate strata. SDK docs, API examples, public quickstarts, and open-source notices should not share the same document tree as internal architecture, operator warnings, or private mechanism notes. Each public stratum needs its own validator: example code type-checks, cross-links resolve, public boundary notices exist, and closed-engine details are absent. The boundary is not only editorial; it is a runnable release check.

Handoffs need the same audience separation as papers. A design, skill, or route contribution is not complete because the builder can execute it from shared context. A cold reader with no private chat history should be able to install, run, verify, or reject the artifact using only the declared files, commands, schemas, and examples. Missing payload shapes, implicit env, undocumented setup, or "obvious" local context are architecture defects because they prevent contribution transfer.

Public and product-facing facts should be derived at build or publish time rather than hand-typed into copy. Release version, package hash, capability count, route count, benchmark corpus size, supported transports, and pricing endpoints should come from canonical snapshots or live derivers, then be checked on the served surface. Frozen numbers in prose become lies as soon as the graph moves.

### Internal Boundary

Internal docs can describe the full intended architecture, but they still need an honesty gate:

- every shipped claim points to code or a live command
- every reference claim points to a runnable reference implementation
- every proposed claim is labelled proposed
- every benchmark claim names the exact gate and current status
- every private mechanism stays out of public artifacts unless explicitly cleared

The ManicMind architecture makes this concrete: raw materials stay below the publish boundary; public/published artifacts cross only through a gate. Unbrowse needs the same discipline for papers and product docs.

The internal graph also needs source tiers:

```text
raw trace
  -> admitted source row
  -> candidate knowledge row
  -> verified capability record
  -> generated projection
```

Raw traces are browser captures, session transcripts, tool logs, issue discussions, benchmark logs, screenshots, and route bodies. Admitted source rows are narrow facts with exact provenance pointers: file or trace id, line/range where possible, message type, timestamp, and content hash. Candidate knowledge rows are summaries or recipes derived from those sources. Verified capability records are the promoted graph objects. Generated projections are search indexes, docs, catalogs, and client views.

A generated row must never be the only place a fact exists. If the route graph says "this domain has a direct API recipe," the graph should point back to the admitted source row and, where allowed, to the raw trace or issue that proves it. Durable memory should store verbatim source excerpts or exact pointers, not only paraphrases, because paraphrase drift becomes unrecoverable after context is gone.

Cold-start learning can import user-owned histories, but only as provenance-bearing candidate rows. Shell history, agent transcripts, local command logs, and prior tool envelopes are useful because they are already implicit dispatch records with frequency and context signals. They are also private and noisy. Imports should require explicit scope, source class, redaction policy, content hash, dedup key, and promotion gate before they influence shared ranking or leave the local trust boundary.

Learned artifacts derived from private sessions need two gates before promotion: a redaction witness before training or indexing, and a route witness after serving. Session corpora can become local models, selectors, examples, or retrieval memories, but paths, emails, tokens, keys, cookies, and credential-shaped strings must be scrubbed before they become training material. A non-empty model or index is not enough; the artifact must be served through its intended compatibility surface and reached by the app, CLI, SDK, or resolver that will consume it.

Auto-generated artifacts need cheap anti-cheat prechecks before expensive verification. Known ways to fake success should be linted directly: empty corpora, all-skipped tests, forbidden tokens, undocumented assumptions, generic catch-all tools used where a named capability is required, unverified issue rows treated as merged knowledge, and recipes with no reproduction steps. The expensive verifier then checks a candidate that has already survived the obvious placebo paths.

Citation-grounded artifacts need a pre-emit falsifier before review. Source pointers must resolve to real files, trace ids, URLs, or rows; one source should not be stretched to carry unrelated claims; and duplicate filler should fail before the human or expensive verifier spends time on prose quality. This catches untrue pointers and over-forced grounding while the artifact is still cheap to repair.

---

## 8. Cache, Ledger, and Addressing Are One Spine

The whitepaper already separates cache and ledger correctly:

- the cache stores values by content identity
- the ledger stores ordered commitments to claims about those values

The internal architecture should sharpen this into one invariant:

> A signature binds the resolved value, not merely the pointer string.

If a row signs only "whatever this pointer resolves to," the pointer can be made to lie. If it signs the content hash of the resolved value, the signature is attached to the value itself. This matters for routes, credentials, local pipe outputs, validator proofs, and payment receipts.

The useful internal model is one address space with two resolutions:

- exact pointer: content hash, CID, route id, receipt id
- fuzzy pointer: embedding search, semantic route lookup, nearest capability

Exact addressing gives replay and idempotency. Fuzzy addressing gives discovery. They should meet at resolution time: fuzzy search selects a candidate, but execution and settlement bind the exact resolved object.

Inline rows should stay small enough to replicate and audit. Content-bearing blobs should be deduplicated behind content addresses. This gives the route graph three useful properties: cheap indexing, tamper-evident payloads, and safe redaction when a public artifact needs the shape of a claim without the private payload.

Idempotency should be tested as behavior, not assumed from hashing. A replay cache is trustworthy only if the same semantic input does not re-dispatch, object key order does not change the key, any changed value misses, falsy values are still cached, concurrent identical calls single-flight, rejected runs evict their key, and failures are loud. For scheduled or triggered work, the idempotency key must include the fire identity, not only the task identity, so two legitimate fires of the same task do not collapse into one.

Receipt deduplication should address the stable body, not the time-varying wrapper. A signature, timestamp, or receipt id can legitimately churn on each write. The semantic body hash is the idempotent key. Re-stamping the same body from a wiped index should reproduce the same body imprint even if the outer receipt differs.

Ledger rows should store adapter pointers when live rematerialization is the real truth. A row can contain the envelope, adapter id, adapter input hash, and optional cached output pointer, while the adapter replays the current value on demand. This keeps journals thin and makes cold verification structural: the verifier can rematerialize a route response, file state, CLI output, or generated projection instead of trusting a stale captured blob. Snapshot payloads are still allowed for evidence that must freeze a historical value, but the row should declare whether it is a live adapter reference or a fixed artifact.

---

## 9. Trust Tiers Without Pay-for-Rank

Trust tiers are necessary because not all routes carry the same risk.

```text
open      -> low-friction, best-effort, quality-ranked
trusted   -> maintained, verified, challengeable
premium   -> high-value or authenticated, stronger accountability
```

The hard rule:

> Stake or bonding may buy eligibility to make accountable claims. It must never buy ranking.

Ranking should remain grounded in quality:

- success rate
- freshness
- verification status
- auth validity
- latency
- failure recovery
- challenge history
- repeat usage
- value saved relative to rediscovery

Bonding is a warranty, not an ad slot. This prevents the graph from becoming pay-for-placement.

---

## 10. Settlement and Security Asset Separation

The economics must keep three assets conceptually separate.

| Asset | Job | Must not become |
|---|---|---|
| USDC or stable-denominated rail | usage settlement | ranking power or governance theater |
| host-chain gas | transaction fee | payment unit or bond |
| security/bond asset, if used | stake and slash against integrity claims | payment token or visibility token |

The shipped wedge does not depend on a security asset. The route graph is justified by saved rediscovery cost. A bond asset becomes relevant only when higher-trust maintenance needs downside for false claims.

If a bond asset is used, it must satisfy three measurable conditions:

1. slashing bites in stable terms
2. distribution is measured, not asserted
3. bonded security budget exceeds value at risk

Those are architecture constraints, not marketing claims.

---

## 11. Risk Isolation for Auth, Money, and Mutation

The imabettingman architecture is useful because it treats money-touching execution as a separate risk plane. Unbrowse should adopt the same discipline for website auth, wallet settlement, route publishing, and unsafe mutations.

Rules:

1. Auth material is not a route descriptor.
2. Payment receipts are not ranking signals.
3. Mutation capability is not implied by read capability.
4. Public route metadata never stores credential payloads.
5. Browser capture may observe sensitive material, but publishing stores pointers and schemas, not secrets.
6. Wallet approval, x402 settlement, cookie use, and third-party mutation each produce separate trace rows.
7. Every unsafe mutation has a dry-run path and an explicit confirmation path.

Auth credentials also need a stable local custody target. On macOS, auth-capture and keychain pointer reads must address `~/Library/Keychains/login.keychain-db` explicitly rather than relying on whatever default keychain the launching process inherited. Agent launches through MCP, npm, Bun, or a background supervisor may not have a default keychain session; the correct failure mode is a typed missing-credential or unavailable requirement, not a "Keychain Not Found" system dialog and not a raw `security find-generic-password` subprocess error. The shipped pointer form is `keychain://unbrowse-auth/<domain>`: the pointer is safe to return, the cookie values stay in the OS credential store, and retry guidance points back to `unbrowse auth` / `auth-capture` when the item is absent.

Append-only records are the default. Mutable state is allowed only when it is the local cache view of an append-only history, or when the write uses atomic replacement and the previous value can be reconstructed from trace.

This separation lets Unbrowse add higher-trust routes and paid execution without making the route graph itself a custody surface.

Deployment state is part of the risk plane. Environment variables, secrets, wallet endpoints, callback URLs, and runner URLs should be declared and covered before deploy. A release gate should walk every required environment reference and prove it is satisfied by checked-in nonsecret config, encrypted secret storage, or a documented operator-provided binding. A deployment that can wipe or omit plaintext environment state must fail before it runs, not after production starts returning typed `unavailable`.

Runtime version pins are deployment state too. If a package, native module, browser driver, model runner, or local binary is validated only under a pinned runtime, the gate should assert the effective executable path and version, not just rely on a shell activation command. PATH precedence can silently select a newer toolchain while the logs point at unrelated build errors. Release witnesses should record `which`/version evidence for load-bearing runtimes and fail when the active process does not match the repo pin.

Sealed artifacts should bind to the environment they are allowed to run in. If a route bundle, verifier, benchmark artifact, or private runner is intended for a specific gateway, domain, workspace, or trust tier, the seal should include that expected environment in the derived key or validation commitment. Repacking the same artifact with the same inputs should be deterministic; repointing it to an unapproved endpoint should fail closed. This is not a claim of unbreakable cryptography. It is a practical guard against accidental repointing, stale bundles, and casual exfiltration.

Scarce or authority-bearing operations should be server-side atomic primitives, not client-enforced sequences. If the product grants credits, publishes premium routes, mints marketplace access, spends a wallet allowance, or assigns a scarce slot, the cap and grant should happen in one authoritative transaction that returns the resulting state. Clients may request; they do not enforce scarcity.

Money and custody state must reconcile against the external source of truth. A local ledger, config file, doc-stated wallet, or cached settlement row is a cache, not custody reality. For on-chain settlement, the chain and payment receipts are the source. For card or hosted billing, the provider ledger is the source. For route marketplace payouts, the canonical settlement service is the source. Unbrowse should run reconciliation jobs that compare configured wallet/account ids, local rows, pending payouts, and external balances or receipts, and raise drift as a named failure.

Mirrors follow real receipts, not speculative sizing. If Unbrowse mirrors a payment, payout, route publish, or contributor split into another system, the mirror row should carry the real source receipt id, amount, asset, payee, and timestamp. It should not synthesize `pending` identifiers or run a parallel sizing policy. A mirror is a projection of something that happened, not a second decision engine.

Live-money paths need three independent brakes: a bounded per-operation cap, mandatory dry-run, and explicit arming before execution. These gates are separate because each catches a different class of mistake: bad signal, bad transaction construction, and wrong authority. For x402 or future split-payment flows, the user-visible payment requirement should disclose the destination and any eventual fanout before signature. Deferred cranks or splitters are acceptable only when the user's signed intent and custody path remain inspectable.

---

## 12. Verification Is a Product Layer, Not a Footer

The largest failure mode in agent systems is self-deception: a model or loop says something is done without a third-party-checkable witness. Unbrowse should treat verification as a first-class product layer.

A capability is not "settled" because:

- a model says it is
- a type check passed
- a route returned HTTP 200 once
- a benchmark summary was written
- a cache hit occurred

A capability is settled when the relevant witness can fail and currently passes.

Examples:

- a route health check replays against the live target and validates schema
- a sealed cache entry re-hashes to the expected content address
- a local pipe run denies unapproved release and records the denial
- a payment settlement row cannot replay after batching
- a benchmark gate runs on a held-out set and records honest negatives
- a public doc claim passes a paper gate tying it to code or reference

This should be reflected in product UX. "Verified" should never be a vague badge. It should mean a named check, run at a named time, under a named trust tier.

---

## 13. Benchmark Honesty and Negative Results

The ARC and TinyLLM histories give the right evaluation posture: a toy green is not a benchmark win, a design is not an empirical result, and a negative result is reusable knowledge.

Unbrowse benchmark reports should distinguish:

- toy corpus
- smoke corpus
- held-out corpus
- competitor-reproduced corpus
- production telemetry
- public benchmark claim

Every reported number should name:

- corpus identity and size
- served universe or capability slice
- accepted label set or equivalence rule
- join key and frame convention
- objective metric and why it matches the external score
- route source: cache, marketplace, live capture, browser fallback, or local pipe
- success definition
- failure classes
- exact command or harness
- date run
- whether the result is comparable to an external benchmark

Single-gold labels are a convenience, not always ground truth. If the corpus contains sibling capabilities that satisfy the same intent, a rank-1 sibling may be a correct retrieval even when the fixture expected a different id. The harness should support accepted-label sets, equivalence classes, or explicit near-tie adjudication. It should not tune the resolver to force an arbitrary original label back to first place.

Benchmark path purity is equally important. A generalization benchmark cannot give the agent an opaque channel to hidden answer keys, recorded gold actions, or replay traces while reporting the result as solving. Replay is a valid product feature when the benchmark explicitly measures reuse, cache hit quality, or memorized production behavior. It is fraud when the benchmark claims fresh reasoning or discovery.

Benchmark universe framing matters as much as the metric. A corpus that covers all sites, all routes, or all historical records may not represent the subset the product can actually serve. Route retrieval, extraction, and paid-execution claims should report performance on the served universe: the domains, route kinds, auth states, transports, and pricing lanes the resolver can reach today. Exact slug overlap is a weak proxy when formatting drifts; use canonical ids, stable foreign keys, or declared profile filters before concluding a product cannot reuse historical evidence.

Scope filters are product decisions and must leave drop ledgers. A format normalizer, route-kind filter, auth-state filter, domain denylist, robots policy, volume threshold, language filter, or pricing lane can remove most of the reachable universe before ranking ever runs. If the same filter is copied into live execution and evaluation, the excluded population becomes invisible and unmeasurable. Resolver and benchmark reports should name every pre-ranking filter, count admitted and dropped candidates, sample the dark population, and classify whether each drop is unsupported, unsafe, uneconomic, unavailable, or accidental.

Thresholds must be evaluated at the time they act. A filter that gates live scan-time discovery cannot be justified only by a historical close-time or post-hoc corpus where the field has already accumulated. For Unbrowse, a rate limit, auth freshness window, page-size cutoff, route-health threshold, or pricing floor should be measured at the point where the resolver or executor actually decides. Retrospective corpora can validate outcomes, but they cannot prove the coverage impact of a live admission threshold unless they preserve the same decision-time frame.

Every corpus should declare its frame conventions. If a dataset records values from one side of a transaction, one answer orientation, one timestamp boundary, one accumulated-volume convention, or one transport perspective, reusing it under the opposite policy requires an explicit transform. Silent frame mismatches create false losses or false wins. The harness should name sign conventions, time-boundary rules, aggregation time, and any normalization applied before scoring.

Progress metrics need base-rate sanity checks. A signal that fires on nearly every transition, like "something changed," is not evidence that the task advanced. Before a reward, verifier, or product metric can steer ranking, the report should name its positive base rate and show why it distinguishes progress from ambient motion. High-base-rate signals can still be telemetry, but they should not be promoted as success objectives without a rarer progress witness.

Negative results should be preserved as graph-quality intelligence. Examples:

- stale cached skill returned before freshness check
- SSR-only page has no callable API
- browser capture found no endpoints
- `--extract` path mismatch returns empty data while raw body has data
- HTTP error lacks actionable next step
- phantom endpoint admission from weak DOM artifact
- auth handoff failed

The right architecture does not hide these. It turns them into admission gates, ranking penalties, repair tasks, or explicit user-facing next steps.

The metric has to match the thing being optimized. A benchmark that rewards action efficiency, latency, cost, successful mutations, or attribution quality is not measured by raw completion count alone. If the harness tracks the real metric but drops it before scoring, it will promote mechanisms that look green while losing on the leaderboard or product objective. Unbrowse evaluations should report both task completion and the scarce resource spent to complete it: browser actions, network calls, paid calls, model tokens, wall-clock time, human approvals, and replay misses.

Aggregate health and worst-slice health need separate mechanisms. A route family can look good globally while failing a specific domain, auth tier, browser state, geography, time window, or payload shape. Lowering cost, retry size, or concurrency may improve the aggregate path without fixing the slice whose picks or extraction rules are wrong. Route reliability, ranking, and paid-execution claims should therefore report global score, worst admitted slice, and the mechanism meant to repair that slice.

Policy and ranker claims must pay for their search process. If Unbrowse tries twenty fusion weights, three rerankers, five corpora, and four prompt policies, the promoted winner is not evidenced by the final score alone. The report should record the number of variants tried, the tuning/held-out split, the minimum sample floor, and any multiple-testing or overfit penalty used before the result can steer production ranking. A selected policy with no trial ledger is a selection-bias artifact until proven otherwise.

---

## 14. Promotion Gates from the ARC Campaign

The `sota-arc3` campaign adds a sharper lesson than generic benchmark hygiene: every promotion path needs a gate that tests the specific property being promoted. A release witness, a behavioral witness, a submit witness, and a live witness are different instruments. Passing one must not imply the others.

Unbrowse should adopt these promotion laws:

1. **Identity gate.** A flag-gated change must reproduce the old behavior exactly when disabled. For Unbrowse, a new ranker, executor, cache, or verifier path should have a flag-off identity test before it can enter a live comparison.
2. **Replay-surface quarantine.** Data that is legal in a live/memorized path must not leak into a generalization benchmark. For Unbrowse, captured routes, cached responses, golden pages, and marketplace examples must be quarantined from held-out extraction and competitor benchmarks unless the benchmark explicitly measures reuse.
3. **Behavioral-delta gate.** "The mechanism is wired" is not enough. It must measurably alter the relevant behavior on a real held-out task before it earns an expensive A/B or benchmark slot. For Unbrowse, a new ranking signal must change selected endpoints; a new freshness check must change cache admission; a new verifier must reject something the old system accepted; a new executor policy must change an execution path or requirement block. Correctness gates prove the mechanism is safe to test. Behavioral delta proves it is present.
4. **Falsify-first audit.** An audit is not trusted until it fails on a planted violation. Paper gates, leak guards, replay-quarantine checks, unsafe-mutation checks, and benchmark judges should all have `--falsify` or fixture modes that prove the alarm fires.
5. **Partial run is not a verdict.** A truncated benchmark, failed watcher, or missing output is invalid, not negative. Judges should have explicit `WIN`, `LOSE`, `TIE`, and `INVALID` states.
6. **Harness over hope.** Branch execution should follow mechanical exit codes. A public claim, release, marketplace promotion, or benchmark badge should not be decided by reading logs by eye.
7. **Proxy positive is not live positive.** Offline extraction quality, toy route reuse, synthetic endpoint recovery, and local smoke tests can justify the next gate. They do not justify a public benchmark win or production-trust claim.
8. **Apparatus diagnosis is part of architecture.** If two trusted witnesses disagree, the missing variable may be in the instrument: budget, corpus mix, auth state, action cost, timeout, or replay contamination. The architecture should preserve apparatus facts next to result facts.
9. **Mutating gates isolate state before execution.** A regression-attribution or two-pass gate that runs tests against different code states must snapshot affected files before either run and restore by content, not by best-effort stash semantics. If the test command can mutate files, backup-after-first-run has already lost the pre-gate truth.

These laws map directly onto route promotion:

```text
captured route
  -> identity/parity check against observed behavior
  -> replay-quarantine and secret-scrub audit
  -> behavioral-delta proof that the route improves resolution or execution
  -> held-out or live health check
  -> promotion to higher trust tier
```

They also apply to paper claims:

```text
proposed claim
  -> anchor exists
  -> gate can fail
  -> falsifier catches planted violation
  -> benchmark corpus named
  -> claim marked shipped, partial, proposed, or negative
```

The ARC campaign's strongest reusable result is this discipline: do not confuse a functioning mechanism with a useful mechanism, a useful proxy with a live win, or an incomplete run with evidence.

---

## 15. Gate Semantics from ManicMind

ManicMind contributes a more precise definition of what a gate must be. A gate is not "a script returned zero." It is a reachable, deterministic, localized, falsifiable check against the property being claimed.

Unbrowse should add these gate semantics:

1. **Reachability is the ship gate.** A feature is not shipped because its isolated tests pass. It is shipped when the intended user can reach it through the intended CLI, MCP, SDK, or app path. For Unbrowse, a route tool, paid endpoint, auth flow, or verification badge is not shipped until it is reachable from the user-facing surface.
2. **A flaky witness blocks the loop.** If a check depends on cold startup races, hidden stderr, network timing, or nondeterministic daemon state, fix the witness before trusting the result. A flaky route health check is worse than no check because it destroys the ranking layer's source of truth.
3. **Compound gates must name the failing clause.** A single `&&` chain that exits 1 is not enough for an autonomous repair loop. Gates should print a stable failure code such as `GATE: stale cache`, `GATE: auth expired`, `GATE: schema drift`, or `GATE: replay quarantine violated`.
4. **Placebo greens are forbidden.** A check can pass vacuously if it weakens the target: empty corpus, fixture-only route, all-skipped benchmark, no forbidden tokens present because the path was not scanned, or a verifier that accepts "missing" as witnessed. Gates need forbidden-token, non-empty-corpus, non-skip, and planted-failure checks where relevant.
5. **Probe validity is gated too.** A verifier can lie by inspecting prose instead of implementation, swallowing errors, searching the wrong path, or treating a null as evidence. Before trusting a probe's red or green, prove it looks at the actual artifact and catches both planted positive and planted negative cases.
6. **Soft gates and hard gates have different jobs.** Binary gates should guard safety, release, and public claims. Ranking and routing signals should often be soft scores, bounded and inspectable, so weak but real signals are not suppressed by a brittle all-or-nothing filter.
7. **Creativity and apophenia separate only at verification.** New route inferences, ranking signals, and architecture claims are just candidates until a falsifier plus independent witness survives cold re-execution.
8. **Context-dependent gates should abstain honestly.** A browser-display, camera, live-auth, wallet, or network-dependent capability should return `skipped` or `unavailable(reason)` when the required context is absent. It must not turn a missing context into success, failure, or a fake all-green composite.
9. **Wiring complete is not data flowing.** A capture, telemetry, event, or payment pipeline is not live until the production path emits a non-zero empirical count through the real producer. Unit tests that construct envelopes directly do not prove the producer is alive.
10. **Green tests do not prove placement.** A capability can satisfy its own spec and still be wired into the wrong consumer, duplicate an upstream guard, or sit outside the path that needs it. After green tests, a cold placement review should check whether the primitive belongs at that boundary before promotion.
11. **Prose promises must become artifacts.** A rule, gate, probe, spec, or future-work claim stated in chat is not durable until it lands in a file, script, ledger row, issue, or queue that later sessions can inspect.
12. **Exit status binds to the predicate.** A verifier command that exits 0 whether or not it found the artifact is not a verifier. If the claim is "bundle exists," "route built," or "anchor rendered," the command must fail when that condition is false.
13. **Evaluators exclude their own emissions.** A grep, scorer, or log parser that reads the file it just wrote can grade its own labels, summaries, or threshold text instead of the target corpus. Gate inputs should separate source evidence from evaluator output.
14. **Exclusions are evidence-backed.** A scan, leak guard, or audit should default to including live product paths and exclude only directories whose inertness is mechanically proven, such as actual test fixtures or generated build output. Folder names like `reference`, `examples`, or `design` are not evidence that a path is unreachable.
15. **Process witnesses avoid self-match.** A `ps`, grep, or process-list witness must not be able to match its own shell wrapper, heredoc, command string, or test harness. It should anchor on a distinctive runtime signature and prove the target process would be absent if the real program were not running.
16. **Human-run commands are artifacts.** Any shell snippet, migration command, or repair recipe handed to a user must be tested on the target platform and shell. GNU-only stream edits, inclusive range deletes, hidden PATH/version drift, and invalid date syntax can corrupt state while looking like documentation.

This gives each gate a required output shape:

```text
GateResult {
  status: pass | fail | invalid | skipped
  code: stable machine-readable reason
  property: what claim this gate tests
  corpus: what inputs were tested
  witness: path to logs, receipt, or trace
  falsifier: planted or natural red-path coverage
  probe_self_check: omitted | passed | failed
  reachable_surface: cli | mcp | sdk | app | internal
  placement_review: omitted | passed | failed
  artifact_pointer: file, script, row, issue, or queue item when the gate creates durable work
  predicate_exit_check: omitted | passed | failed
  evaluator_corpus: source-only | mixed-with-output | unknown
  target_platform: platform and shell when the gate emits user-run commands
}
```

The most useful addition for Unbrowse is `invalid`. A route benchmark with no held-out rows, a verifier whose target site was down, or a payment test with missing wallet config is not a failure of the route. It is an invalid witness.

### Structured Requirement and Status Blocks

ManicMind's requirement-block pattern is directly useful for Unbrowse. A runtime should not bury important state in English error text when the caller needs to decide what to do next. Requirement, routing, and progress states should be emitted as labeled machine-readable blocks that each transport can render natively.

For Unbrowse, the common block kinds are:

```text
RequirementBlock {
  kind: auth_required | payment_required | approval_required | browser_required |
        captcha_required | unavailable | inhibition_refusal | routed | presence
  reason: stable machine-readable reason
  actor: agent | user | site_owner | wallet | browser
  action: sign_in | pay | approve | open_browser | wait | retry | abort
  target: url, skill id, endpoint id, or wallet domain
  retry_contract: when the original call may be retried
  transport_hints: cli | mcp | sdk | app rendering hints
}
```

This turns `next_step` from a prose convention into a product contract. The CLI can print a payment block, MCP can surface a tool-call-shaped requirement, the SDK can throw a typed exception, and the app can render a native approval sheet. They all consume the same runtime fact.

Presence and progress should follow the same rule. "Thinking", "capturing", "waiting for auth", "indexing", and "publishing" are not UI strings; they are status envelopes with phase, run id, capability id, and last durable journal row. A thin terminal progress line and a rich app timeline should be different renderings of the same substrate.

Activity status must mean active work, not process liveness. A local server, browser profile, worker, or subprocess can be alive while doing nothing useful. Statuses such as `working`, `capturing`, `executing`, or `reasoning` should be driven by step start/delta/end events and expire by sweeper if no fresh activity arrives. Process start records liveness and readiness; it does not by itself prove that the agent loop or route execution is active.

Trigger architecture needs the same honesty. "Anything can be a trigger" is only true for trigger types whose dispatch path is live and witnessed. Unbrowse should separate:

```text
trigger_observed -> dispatch_requested -> dispatch_started -> dispatch_completed
```

A row that records intent to fire is not evidence that the target capability ran. Webhook, cron, file-watch, MCP event, browser event, and cell-emission triggers should each be gated independently. Until a trigger type reaches `dispatch_completed` through the production runner, it is partial.

A related pattern is the standing watch. When a target cannot be reached now, the runtime should be able to register a durable watch instead of losing the user's intent or retrying blindly. Route drift, auth refresh, site availability, marketplace publication, inbound webhook motion, and benchmark rerun conditions can all be represented as watches. The watch declaration itself is an auditable act with owner, predicate, expiry, and callback capability.

Finally, agents need orientation before expensive work. Before capture or live browser descent, the resolver should be able to emit a `context_orientation` block: known local cache hits, missing auth, likely documentation sources, relevant code indexes, route graph status, and whether the task is better served by web, repo, docs, arxiv, or existing skill execution. This is how the runtime avoids spending browser work to discover context it already had.

---

## 16. Runtime Contracts Beat Prose

Several ManicMind notes converge on the same operational lesson: prose guidance is not a contract. If the agent can ignore a rule and still reach for a familiar general-purpose tool, it eventually will.

For Unbrowse, this means:

- A skill instruction saying "publish through the registry" is weaker than a runtime path restriction that prevents direct writes to registry-owned directories.
- A docs claim saying "x402 calls use approval" is weaker than an executor that refuses paid calls without a typed payment cell.
- A security note saying "do not mutate without dry-run" is weaker than a mutation executor whose API requires `dry_run` before `confirm`.
- A capture workflow saying "do not publish secrets" is weaker than an admission gate that cannot serialize credential fields into public route metadata.

The product should expose first-class verbs for important operations so agents do not improvise with raw filesystem, shell, or HTTP tools:

| Operation | First-Class Verb | Disallowed Fallback |
|---|---|---|
| install a capability | `install_skill` / `install_capability` | write files into a guessed directory |
| publish a route | `publish_route` | hand-edit registry rows |
| execute a paid endpoint | typed endpoint cell with x402 policy | generic paid fetch with arbitrary URL |
| mutate a third-party site | dry-run then confirmed mutation call | direct replay without mutation class |
| record a trust claim | append ledger row | overwrite mutable status flag |

This prevents the "wrong root" class: when the agent lacks a path-correct verb, it writes to whatever path its current working directory makes convenient. First-class verbs are an architecture feature, not just developer ergonomics.

Implementation is not activation. A code path, refactored core, or passing unit test is not live until the user-facing runner imports it, calls it, and emits its effects through the production journal. During migrations, docs must say which path is live today, which path is shadow, and which gate promotes shadow to primary. Present-tense claims about a new core are unsafe while the old runner still owns the real execution path.

The declared tool surface must be a subset of the implemented tool surface. A skill, MCP server, CLI, SDK, or prompt that advertises a tool with no registered handler creates a latent infinite hang: the model can call it, but no result can arrive. Surface generation should be built from the runtime registry where possible; otherwise a startup gate should diff declared tools against implemented handlers and enforce a timeout/error path for unknown calls.

Witness independence is part of the same contract. A test authored on both sides of a boundary can prove internal consistency, but it cannot prove the boundary is real. If the code under test serializes a shape and the test fixture was handwritten to match that same shape, the green result is weak. The stronger witness reads an externally produced artifact: a real browser trace, real upstream API response, real driver row, real payment receipt, real screenshot, real route-store row, or real production journal line.

For Unbrowse, this creates three release checks:

1. **Live-caller check.** A primitive is not shipped until a production capture, resolve, execute, publish, verify, or settlement path calls it. A correct primitive with zero production callers is dormant.
2. **Producer-to-consumer check.** When a consumer reads by key, the witness starts at that lookup key and walks backward to the producer that must persist it. Minting a value without storing it under the consumer's key is a dormant pipeline.
3. **Launching or surface check.** A CLI smoke test does not prove the app, MCP server, SDK, or browser surface works. Claims about those surfaces require a launch through that surface and a witness from the outside: process, protocol, screenshot, pixel readback, or received event.

---

## 17. Learning: Narrow the Claim

The architecture should avoid broad "self-learning" claims unless the product actually persists and improves from a run.

Safe claim:

> The graph improves when route usage creates better records, reliability scores, verification state, and maintenance signals.

Safe claim:

> A ranker or selector can improve from logs if its training loop is witnessed on held-out cells.

Unsafe claim:

> The same deployed agent gets more accurate across repeated runs of the same evaluation.

That was tested and should not be claimed unless a per-question recall mesh or equivalent persisted learning mechanism exists and passes a cold held-out gate. The current architecture should describe learning as graph compounding, cache warming, verification feedback, and optional model/ranker training from logs, not as magical repeated-run self-improvement.

---

## 18. Selector, Generator, and Resolver Boundaries

ManicMind's answer key separates two organs that agent architectures often conflate:

- selectors/rankers/retrievers are good at choosing among known candidates
- generators are responsible for creating an unseen candidate

Unbrowse should treat route resolution as a selector problem unless and until generation is separately witnessed.

Safe selector claims:

- rank the true route among captured candidates
- classify intent type
- choose which endpoint to try first
- pick the cheapest faithful execution path
- escalate from cheap model or cache to stronger route/capture when confidence is low

Unsafe generator claims:

- infer a never-observed private API from scratch
- synthesize a correct workflow with no captured evidence
- produce a new route contract without replay or browser corroboration
- convert arbitrary site behavior into a reusable capability without a red path

Energy, embedding, BM25, kNN, and LLM judges can be strong route selectors. They should not be described as route generators unless a benchmark proves generation. This matters because the unbrowse moat is route reuse and maintained selection quality, not a promise that the system can hallucinate hidden APIs correctly.

The resolver should therefore prefer cascades:

```text
cheap selector confident
  -> execute
cheap selector uncertain
  -> stronger selector or browser capture
no captured evidence
  -> browse/capture, then compile
```

The architecture should make escalation cheap and visible instead of pretending the first selector is universally smart.

Confidence should be witnessed, not guessed. Cheap selectors can stay on the cheap path when independent executions, ranker agreement, or other calibrated confidence signals converge. Scatter, disagreement, low margin, or missing evidence should escalate to a stronger model, richer resolver, live capture, or human-visible requirement. The confidence row should name the sample count, agreement rule, candidate set, and escalation threshold.

Routing should use discovered signals, not object ids. A resolver may choose different policies for different route regimes, but the dispatch predicate should be a measurable feature of the task or environment: schema shape, auth class, DOM/API affordance, sparse goal signal, transport availability, or verified corpus profile. Hard-coded site ids, game ids, or benchmark names are brittle shortcuts unless the capability kind itself is the contract.

Recall is ranking over survivors. The strongest candidates are not arbitrary tools that lexically match the query, but capability records whose past executions, repairs, and verifications survived similar intents. The resolver can score intent against survivor records, negative records, and retired records separately: survivors attract, contradicted or stale records repel, and retired records explain why a tempting path should stay closed.

---

## 19. State Machine

Every capability should move through a common lifecycle.

```text
declared
  -> observed
  -> normalized
  -> indexed
  -> validated
  -> published
  -> active
  -> challenged
  -> repaired
  -> decayed
  -> deprecated
  -> disabled
```

For open routes, the lifecycle can be lightweight. For trusted and premium routes, each transition should produce a ledger row.

Minimum transition records:

- who or what moved the state
- previous state
- new state
- value hash or route pointer
- witness used
- timestamp
- signature or operator identity
- dispute/challenge link if applicable

This turns lifecycle management into an auditable graph instead of a set of mutable flags.

The same discipline applies when a capability dies. Deprecation should be a typed event with a cause, not deletion or silent rank decay. Minimum causes:

- `superseded`: replaced by a named newer capability
- `contradicts`: refuted by a named witness
- `stale`: no longer replays or verifies
- `unsafe`: blocked by security, auth, or mutation policy
- `apoptosed`: intentionally retired because the product no longer needs it

`superseded` and `contradicts` must name the capability or witness that caused the death. Pruning must be as accountable as creation; otherwise the graph loses why a path was abandoned and future agents re-open dead branches.

### Run-Loop Control

A capability loop should fire until its declared objective settles, not once and not forever. The exit condition is a witnessed terminal state: `satisfied`, `rejected`, `unavailable`, `refused`, `expired`, or `retired`. Fixed iteration counts and agent prose such as "disarm" are weak controls unless they become ledger-visible state transitions.

The runtime should distinguish five control events:

```text
continue: objective not settled; next attempt is justified
hold: blocked by named dependency or requirement
rewake: dependency changed; held work is eligible for re-judgment
steer: same dispatch receives new guidance at a safe boundary
interrupt: dispatch exits cleanly at a boundary with partial state recorded
```

This prevents two common failures. First, a blocked route should not poll forever. If auth, payment, dependency publication, or verifier availability is missing, the work records `hold(blocked_by=...)`; when the blocker satisfies, the watch/ledger edge emits a `rewake`. Second, a stuck loop should not grind the same failed tactic indefinitely. If the same gate remains red with no changed evidence, the next attempt should rotate strategy, selector, corpus, fallback plane, or witness, and the journal should say what changed.

New runtime control surfaces should prefer additive opt-in extensions that mirror a proven pattern. A steering inbox, cancellation hook, policy override, or progress subscriber should default to absent, preserve byte-identical output on the empty path, and drain only at declared safe boundaries. If an extension changes existing tick frames, replay output, or route selection when no input is present, it is not an opt-in extension; it is a behavioral migration and needs the promotion gates.

Schedulers and tailers need their own safety rules. A timer that can outrun its interval must have an in-flight guard; a growing journal must be tailed by offset or cursor, not fully re-parsed on every tick. Otherwise a harmless progress watcher becomes an O(n^2) runaway.

Ceremony is also a runtime cost. Machine-passable, reversible, low-risk shapes should not require repeated human-style verdict ritual. Human or multi-witness judgment is reserved for ambiguous, irreversible, public, paid, or authority-bearing transitions. The product should measure ceremony-vs-output ratio the same way it measures latency and cost.

---

## 20. Clean Service Architecture

CodeGraff's clean-architecture split is the right shape for keeping Unbrowse from turning into a CLI wrapper around a pile of special cases.

Unbrowse should name its layers this way:

| Layer | Owns | Must Not Own |
|---|---|---|
| Domain | capability records, endpoint descriptors, bindings, operation DAGs, trust states, trace records | browser, filesystem, HTTP client, wallet, database |
| Application | resolve, capture, execute, publish, verify workflows | raw I/O implementations |
| Services | ranking, schema inference, freshness, drift, payment policy, credential policy, feedback | direct process/browser control |
| Repository | skills, route graph, traces, cache metadata, lifecycle rows | business decisions |
| Infrastructure | browser runtime, HTTP, local FS, auth vault, wallet, MCP transport | route semantics |
| Facade | CLI, MCP server, SDK, app surfaces | hidden state transitions |

The boundary is valuable because every layer can then be tested at the right level:

- domain: pure graph and state-machine tests
- application: workflow tests with fake services
- services: ranker, verifier, and policy tests
- repository: migration and persistence tests
- infrastructure: browser, HTTP, wallet, and OS integration tests
- facade: CLI/MCP/SDK contract tests

This also keeps capture internals below the public API and lets the MCP/SDK surfaces evolve without leaking storage or browser details.

---

## 21. Product Architecture

The system can be expressed in seven services.

### 1. Capture Runtime

Observes real browser traffic and learns candidate routes. This is local-first and private by default. Closed internals stay below the public boundary.

Capture claims must declare their privilege scope. Browser-context capture, agent transcript capture, file-watch capture, process-spawn capture, and whole-machine telemetry are different authorities. If the OS requires root, entitlements, or a signed extension for a signal, the unprivileged runtime should not claim it can observe that signal. The richest safe corpus may be the agent's own traces and browser sessions, with portable event names mapped onto whatever source is actually available.

Authenticated routes need an auth-capture prerequisite, not optimistic replay. If read-only browsing works but mutation, messaging, purchase, or account data requires a live logged-in session, the runtime should emit a typed `sign_in` or `auth_capture_required` requirement and stop until the human completes the managed-browser login. The captured session artifact then becomes a local prerequisite for replay. Retrying through timeouts, fabricating completion, or silently downgrading to unauthenticated behavior corrupts the route contract.

### 2. Resolver

Turns task intent into a ranked capability shortlist using local cache, marketplace search, reliability, freshness, and verification state.

Before the resolver spends browser or capture work, it should orient the task against available context. The output can include a `context_orientation` envelope naming local skills, graph hits, missing auth, relevant docs/code indexes, and unavailable dependencies. Orientation is advisory, but it is still structured: it lets agents choose the cheapest faithful channel before descending into live browsing.

Resolution should target capability kinds before implementations. If a client asks for a standard skill shape, the resolver can pick the cheapest compatible implementation: local binary, installed skill, MCP tool, marketplace route, paid endpoint, or browser fallback. Ranking should therefore score both relevance and compatibility: does this candidate satisfy the requested kind, schema version, required outputs, trust tier, and transport constraints?

Resolver orientation should include collective knowledge sources before fresh discovery: merged recipes, local discovery cache, open agent-discovery issues, known failure patterns, and pending verification rows. These signals do not automatically outrank verified routes, but they can avoid obvious waste and choose a better first descent path.

The resolver should fuse lexical and semantic evidence instead of replacing one with the other. BM25 and URL/token overlap preserve exact route names, API paths, and field words. Embeddings recover paraphrases and intent matches. Reciprocal-rank fusion or another inspectable fusion layer should keep lexical wins while adding dense-only concept wins, and the dense path should degrade cleanly when the embedder is unavailable.

Retrieval benchmarks need adversarial controls. A "paraphrase" test with shared rare words measures lexical leakage, not semantic recall. Route-retrieval evaluations should include zero-overlap intent rewrites and should report results by query regime: short keyword, URL-like, long natural language, auth/action intent, and schema-field intent. Fusion strategies that win in one regime should not be claimed universal until public or held-out data covers the others.

Failed ranking signals must degrade rather than promote. If an embedder times out, truncates input, exceeds a token window, or returns no vector, that candidate must receive the worst semantic rank or an explicit `unavailable(embedder)` signal. It must never inherit a neutral `0` distance that silently becomes the best score. The same rule applies to freshness, reliability, and verification: absence of evidence is not a positive signal.

Derived routing caches must be test-hygienic. Synthetic route examples, planted fixtures, and benchmark-only capabilities should run against throwaway stores or carry a test namespace that production resolvers never read. A test that mutates a learned cache leaves real steering residue; cache cleanup is part of the witness, not an afterthought.

The resolver should also respect corpus shape. On a well-atomized capability corpus, flat single-hop retrieval may beat hierarchy and multi-hop routing because each record already co-locates the answer with its vocabulary. Hierarchy, re-retrieval, and multi-hop expansion should be added per corpus regime, measured at corpus growth points, and removed when they lower recall or add latency without new reach.

The cheapest intelligent policy is often recognize-then-recall. If the task's first durable signals match a known route family, workflow archetype, or replay-backed capability, the resolver should dispatch that surviving capability before asking a model to synthesize a new plan. The cache is not only an optimization layer; when its entries are verified, typed, and content-addressed, it is an executable policy corpus. New synthesis is the fallback when recognition fails, not the default proof of intelligence.

Pattern rankers should be labeled as structural-fit engines, not truth engines. A low-energy candidate, high-similarity replay, or nearest survivor means "this resembles something that worked under this corpus and gate," not "this is factually correct in the world." Resolver output should carry the corpus id, scorer kind, training or promotion source, and verification gate that made the candidate admissible. Different corpora can produce different "best" answers; the runtime should expose that as provenance, not hide it as universal truth.

Rerankers and fusion policies are regime-specific transforms, not automatic upgrades. A cross-encoder, dense reranker, confidence-weighted fusion, or schema scorer should be admitted only for the domains and query regimes where held-out tuning shows lift, and disabled or bypassed where it degrades a strong first stage. Deeper candidate pools are not free: every extra candidate is another chance for an off-domain scorer to promote the wrong capability.

Attention and context-ranking effects should be ledgered operations. If the resolver attends over cached examples, source rows, route bodies, or traces, the operation should record query hash, candidate set hash, scoring method, unavailable dependencies, and selected ids. This keeps context selection reproducible enough to audit without inlining private payloads into the row.

### 3. Executor

Runs the selected capability through the cheapest faithful path: cached replay, direct endpoint call, browser-context execution, DOM extraction, live capture, or local pipe composition.

The executor should return typed requirement blocks rather than plain failures when execution needs sign-in, payment, user approval, browser display, captcha handling, a wallet, or a missing dependency. The block is part of the execution contract: it names the actor, action, target, and retry condition so CLI, MCP, SDK, and app surfaces can render their own controls without inventing state.

Executor outputs must normalize into the capability result envelope even when the backend is heterogeneous. A browser route, MCP tool, local process, paid endpoint, and borrowed primitive may have different internal outputs, but the client sees the same status, value/artifact pointers, witness, and next-step shape. Backend adapters are allowed to be messy internally; the compatibility boundary is not.

Every model or agent dispatch should run inside a capability fence. The fence declares read, write, exec, network, environment, approval, and budget grants before the run starts; the executor enforces those grants instead of trusting prompt instructions to prevent scope drift. Successful traces can later crystallize into named capabilities, but promotion does not widen the original grant without a new policy row.

If the caller is a UI-bearing surface, the executor should attach a capability view or a pointer to one. Requirement blocks, progress states, receipts, and follow-up actions become renderable node trees backed by shared runtime state. The same result can then be displayed in the CLI, MCP client, SDK-driven app, or desktop surface without each client inventing its own interpretation.

For evented execution, the executor must distinguish observed triggers from completed dispatch. A webhook received, cron tick observed, or file changed event only proves the trigger source fired. It does not prove the destination capability ran until the production executor emits `dispatch_started` and `dispatch_completed` rows into the journal.

Executor retries should be objective-driven and journal-visible. A retry records why the previous attempt did not settle, what new evidence or strategy changed, and which terminal condition would stop the loop. A held execution records its blocker and lets the watch/ledger layer rewake it; it does not spin. A steer mutates the current dispatch at a boundary; an interrupt exits cleanly with partial state. These are runtime events, not chat conventions.

Exploration should commit long enough to learn whether an action works. In browser, app, or game-like environments, every click or scroll can produce novelty, so a pure novelty selector may thrash across controls without settling any path. The executor should support commit-then-explore policies: lock on a chosen action or route until it advances, fails, exhausts novelty, hits a stale threshold, or becomes unsafe; then ban or demote that branch and explore the next candidate. Exploration state belongs in the journal, not in model memory.

Action surfaces should build a control map before asking a model to reason about controls. A browser, desktop app, game, or native UI executor can probe safe candidate actions, measure which controls change state, and record direction or effect summaries. The model then maps intent onto observed controls instead of guessing from pixels or labels alone. Control maps are capability evidence, and stale maps should decay when the UI changes.

LLMs should stay out of wall-clock-bound inner action loops unless they prove they earn their latency. Use models for planning, route selection, schema interpretation, summarization, and verification where their cost amortizes over the run. Do not put a slow model in every DOM poll, click decision, replay frame, or benchmark step if a deterministic executor can act in milliseconds and the model reduces action throughput by orders of magnitude.

Model-backed capabilities should declare the model behavior class they require. A local model used for JSON trees, route contracts, or tool-call envelopes needs instruction-following and structured-output evidence; a pretrained base checkpoint that cannot follow instructions is the wrong dependency even if it loads. The capability manifest should name model variant, runner, prompt/IO contract, structured-output smoke, and fallback behavior. Runtimes such as short-lived processes, daemons, or hosted servers are deployment choices; the contract is the model behavior the capability consumes.

Subprocess capabilities need hard bounds at the executor. Search, filesystem walks, package-manager calls, build tools, and local binaries must have timeout, output, cwd, environment, and traversal limits declared in the capability envelope. A command that walks an entire home directory, blocks on a pipe, or never emits a result frame should terminate as `unavailable(timeout)` or `error(bound_exceeded)`, not hang the caller stream indefinitely.

For local composition, prefer one auditable duplex channel over extra brokers when the same channel can carry both work and result frames. A child process can emit `dispatch` frames and receive `dispatch_result` frames over the same NDJSON or socket boundary used for ticks and output. Extra helper daemons are justified only when isolation, concurrency, or operating-system constraints require them.

One dispatch loop should cover one-shot tools and long-running agentic loops. The executor sends a command, args, input envelope, and lifecycle policy; the callee emits structured frames until a terminal state such as satisfied, unavailable, refused, error, expired, or retired. A nested capability call should use the same dispatch grammar as a top-level host call. If recursion requires a second protocol, the substrate is leaking implementation tiers.

The host owns lifecycle bounds. A client library should not smuggle in a hardcoded timeout, retry policy, or cancellation rule that overrides the runtime supervising the work. Long-running capture, indexing, verification, and model-assisted analysis need host-declared bounds because only the host sees the user intent, cost budget, queue pressure, and safety class. Client defaults can be safeguards, but they must be visible in the requirement/status envelope and overrideable by the supervising runtime.

Execution planning should act at the highest authorized root of the environment tree. If a session cookie, API token, manifest root, entrypoint, config file, package registry, or DOM document object can settle the subtree, the executor should prefer that root over repeated leaf operations. Leaf walking remains necessary when the root is unavailable or unsafe, but it should be a fallback with an explicit reason, not the default shape of automation.

### 4. Capability Registry

Stores skills, endpoints, schemas, auth assumptions, lifecycle state, contributor lineage, and trust-tier metadata.

The registry should enforce one writer per source of truth. External sources such as route health workers, marketplace publish events, payment receipts, and credential refreshes may feed the registry, but each source should have a single canonical writer that normalizes into one cache shape. Readers consume the normalized row, not the external API directly. This prevents split-brain state where two services disagree about the same capability's auth, trust, or payment status.

Capability evolution should be a version-node DAG, not a mutable current row with lost history. Each material change to a skill, route contract, verifier, recipe, or manifest creates a content-addressed version node with parent, merge parent, author/source, timestamp, diff summary, and content hash. Runtime waves and benchmark reports should record the exact version they iterated on. The registry can still expose a `current` pointer, but the audit trail is the parent DAG.

Indexes, backlinks, search corpora, and public projections should be generated from canonical rows, not hand-maintained as second sources of truth. The route graph can have many read models: local skill index, marketplace search index, benchmark corpus, docs projection, app-visible catalog. They should all be rebuildable from capability records, journals, and signed lifecycle rows. If a generated projection becomes the only place a fact exists, the architecture has inverted its source of truth.

Publishing gates should verify the served projection, not only the source file or local registry row. After publish, the verifier should read the projection through the same API, index, package, or surface the client will use; structural-diff the served body against the canonical source within declared normalization tolerance; and assert anchor strings or ids that prove the intended version is live. A local green does not prove that the marketplace, docs page, app catalog, or resolver cache is serving the same fact.

Benefit and entitlement values must be traced to the consuming endpoint, not only to the place they are granted or displayed. A marketplace credit, free month, route allowance, domain-owner lane, or premium entitlement is not shipped until the checkout, resolver, execution, or settlement path actually reads and consumes it under concurrency-safe rules. Layer-local success is a broken funnel if the last hop hardcodes a default.

Collective-learning rows should enter the registry as candidate knowledge, not immediately as active routes. The registry should track contribution source, verification status, target skill/capability, reproduction steps, and confidence lane. Promotion to an active capability requires the same gates as any route: reproducible execution, schema, auth assumptions, failure mode, and provenance.

Declared capability fields must be runtime-consumed or explicitly marked documentary. A manifest can name input schema, output schema, permissions, bindings, reward checks, downstream chains, view defaults, and approval scopes, but a field is not a contract until the runtime reads and enforces or evaluates it. Registry admission should track `declared`, `consumed`, and `verified` coverage for each load-bearing field so a rich manifest does not imply richer behavior than the executor actually implements.

Registration and visibility are separate contracts. A capability that exists on disk, in a package, or in a generated registry file is not active until the surfaces that resolve, list, watch, and render capabilities can observe it through the canonical bus or projection. The registry should therefore emit explicit visibility events such as `capability_registered`, `capability_updated`, `capability_retired`, and `capability_projection_rebuilt`. If the route graph knows a capability but the CLI, MCP, SDK, or app catalog cannot discover it, the capability is shadow state, not a shipped primitive.

App-visible catalogs should be passive read models. They tail canonical rows and lifecycle events, then project them into search indexes, drawers, local catalogs, benchmark corpora, or docs. Writes go back through named command paths; the UI does not mutate the projected truth directly. This lets an external publisher, local CLI, verification worker, or marketplace event converge to the same observed state on the next projection tick.

### 5. Verification and Drift Layer

Runs health checks, schema checks, replay checks, challenge resolution, and verifier receipts.

The drift layer should own durable standing watches. If a route cannot be verified because the site is down, auth is missing, or a marketplace dependency has not published yet, the system can register a watch with a predicate and expiry. A watch is not a pass; it is a persisted retry contract that can later fire a real verification or dispatch path.

Surface claims require surface witnesses. If Unbrowse claims a web app, desktop app, MCP server, browser session, or generated UI renders correctly, the verifier should inspect the actual rendered or protocol surface. For visual surfaces, that means screenshot, pixel variance, accessibility tree, or VLM verdict where appropriate; for protocol surfaces, it means a real client handshake and response. A status string from the process that authored the surface is not enough.

Launch claims require launch witnesses. A CLI smoke, component test, local model reply, or process-alive check is not evidence that the desktop app, browser extension, hosted UI, or MCP client actually starts and renders through its real boot path. Product-surface witnesses should launch the packaged surface, check crash reports or exit state, confirm the visible/protocol surface exists, and then exercise at least one end-to-end capability through that surface.

Tests should include externally produced wire artifacts for every boundary that matters. A serializer/deserializer pair tested only against fixtures written by the same author can agree on the wrong shape forever. Capability envelopes, local pipe frames, MCP replies, payment receipts, browser capture traces, and DB driver outputs should have fixtures captured from the real producer or real consumer in addition to synthetic unit tests.

Fixtures must be real-shaped enough to break the guarded path. Placeholder scalars, hand-minimized objects, or synthetic happy-path JSON can stay green precisely because they bypass the parser, recorder, transport, or branch the test claims to guard. When a silent failure is made loud, tests that formerly passed may need to fail first; that is evidence the old fixtures were vacuous. The repaired fixture should resemble the real producer payload and should be re-proven against a deliberately broken target.

Transport witnesses must decode what the producer actually sends. A successful HTTP status with a compressed, chunked, binary, charset-shifted, or otherwise undecoded body is not a valid response witness. Harnesses should either request a declared encoding such as identity or defensively decode according to response headers before schema checks run. Otherwise downstream schema failures masquerade as product defects while the transport layer silently corrupted the evidence.

Cold re-execution must include learned or generated state when that state is part of the capability. A route model, schema cache, verifier index, challenge corpus, or replay binding that exists on the builder's machine but is absent from the packaged artifact produces a cold-brain run: the system executes, but not with the capability being claimed. Verifiers should check that required state is bundled, loaded from the declared mount, or regenerated before use, and that live-environment nulls are tolerated instead of killing the loop silently.

Runtime dependencies must be packaged where the runtime actually searches. A model, native library, browser driver, shader bundle, certificate, schema file, or generated index can be present in the repo and still invisible to the signed app, local binary, browser extension, or worker. Release witnesses should check the runtime lookup path, packaged location, version compatibility, and seal/codesign compatibility. A durable fix should self-heal or install the dependency into the declared package location, not rely on a one-off copy made during development.

Source-green is not live-green. If a daemon, app, MCP server, local binary, browser extension, or hosted worker serves traffic, verification must prove the running process is built from the claimed source and has been restarted or hot-swapped after the fixing change. A source test can pass while the live journal still emits the old bug. Release witnesses should include build id, process start time, loaded artifact hash where available, and a production-path call through the live runner.

Restart semantics are part of the witness. A long-running local daemon should expose one operational verb that can bootstrap when absent and bounce in place when present. Split deregister-then-start recipes create a window where the service does not exist, and spawning a second copy can double-fire shared wallets, auth stores, browser profiles, or publish queues. A release witness should prove the running process was advanced in place, then drive the live emit-to-listen or request-to-journal bus rather than only testing the rebuilt source.

Operational learning should feed the graph without manual copy steps, but only through gates. Execution journals, failed routes, repaired schemas, endpoint discoveries, and benchmark misses can become candidate capability atoms. The promotion path is: raw event -> gated atom -> canonical record -> generated index -> served resolver answer. This is graph compounding, not an assertion that the model itself learned.

Hard residuals should be reduced by banked, independently verified bricks. When a route family, verifier, or benchmark remains blocked by one structural gap, parallel generation volume is not enough. The system should decompose the residual into smaller capability atoms, land each with its own witness, and keep a residual ledger that names what remains. A final keystone step is trustworthy only when the intermediate reductions are real records, not prose progress.

Verifier choice must match the failure mode. For extractive or grounded stacks, answer-context containment can be vacuous because wrong answers may still be verbatim spans from retrieved context. Those systems need selected-candidate or answer-question relevance checks, not only faithfulness checks. For route retrieval, the verifier must distinguish wrong endpoint, right endpoint with wrong parameters, stale route, auth failure, and output-shape mismatch; a generic "supported by evidence" badge is too coarse to repair the graph.

Security-critical verifiers should consolidate after the first proven drift between copies. Duplicate crypto checks, signature parsers, payment verifiers, auth token validators, and seal validators are not harmless redundancy when one copy needs a compatibility or safety fix the other did not receive. The safe pattern is one shared primitive plus separately authored falsifiers and fixtures that prove the primitive against real bindings.

### 6. Ledger and Cache

Stores content-addressed values and append-only signed commitments. Cache is for values; ledger is for ordered claims.

A capability call is proven by its journal, not by its process exit. The durable witness for execution should be a trace that can be read back from disk or graph storage:

```text
start -> input envelope -> frames/events -> output/error -> receipt
```

The journal should include a monotonic run id, capability id, resolved payload hashes, selected execution path, auth/payment/mutation classes, and terminal result. A subprocess returning 0 without the journal row is an invalid witness.

Observability is a first-party ledger concern, not a bolt-on analytics vendor concern. Trust-critical telemetry should be captured into owned event tables or journals with typed rows:

```text
ObservationEvent {
  run_id,
  capability_id,
  surface,
  actor,
  event_kind,
  input_hash,
  output_hash,
  error_code,
  trace_pointer,
  privacy_class,
  timestamp
}
```

The event kinds include resolver impressions, selected fallback path, requirement block shown, user approval/denial, dispatch start/completion, retry reason, payment prompt, publish/review action, UI error, and user-facing interaction when it affects capability quality. Raw payloads stay behind pointers and redaction policy; the row carries shape, hashes, and provenance.

Measurement rows should distinguish zero from unavailable. A real zero must name the query, source, as-of time, and authority that produced it. A missing table, disabled telemetry source, permission error, unprovisioned time series, or absent provider returns `unavailable(reason)`, never `0` or an empty list. Default values are presentation choices, not ledger facts.

Status surfaces should tail the ledger instead of inventing their own state. A live UI, CLI watch, MCP progress stream, or hosted dashboard is a projection of durable rows; an out-of-band writer should appear when the projection advances. If the surface can show progress that cannot be reconstructed from journal rows, it is a second source of truth.

### 7. Settlement Layer

Handles x402-compatible payment requirements, contributor payout routing, domain-owner lanes where enabled, subscription sponsorship where configured, and future bond/challenge mechanics if trust tiers require them.

Paid endpoints should be named capabilities, not generic paid fetches. A named x402 cell carries parameter schema, permission policy, expected settlement behavior, and lifecycle fences. A generic wrapper around `fetch` can pay a URL, but it cannot tell the agent what authority it is exercising or which endpoint policy applies.

Payment signing should remain handler-owned and keyless from the substrate's point of view. The runtime may wrap a request, surface a payment requirement, retry with a payment header, and verify the receipt, but private-key custody belongs to the configured wallet handler. Endpoint cells declare payment scheme, asset, amount policy, payee, receipt verifier, and permission fence; they do not become generic key stores.

For simple usage, paid execution should prefer per-call settlement over an internal credit ledger. If a call can be quoted, signed, settled, and receipted atomically, the product does not need pre-funded balances, admin credit mutations, or account-state drift for that path. Any margin or fee belongs in the quoted payment requirement and returned receipt, not in an invisible side ledger.

Inbound and outbound money should also be asymmetric. Inbound usage settlement can be automated when the payment requirement is explicit and the user signs the call. Outbound sweeping, token swaps, or redistribution should stay behind dry-run and explicit arming until a separate settlement gate proves the path.

Balance state must distinguish notional holdings from spendable custody. A wallet can show an asset while the target venue, payment rail, or endpoint cannot spend it without conversion, bridging, allowance, or program-specific wrapping. Settlement rows should name the asset, chain, venue/program, spendable amount, notional amount, conversion state, and action required. Sizing against the wrong balance creates silent non-execution.

Scarce grants and paid entitlements should be command-shaped, not raw table-shaped. A credit grant, waitlist slot, premium-route allowance, or sponsored access row should be created by a single server-owned idempotent command that enforces the cap and returns the resulting state. Direct client writes to the scarce table make the cap advisory; an authoritative command makes it a real transition.

Human approval should be based on irreversibility and authority, not keyword coincidence. Keyword gates are prompt-injection surfaces: user-controlled text can quote scary terms or omit them. The safer policy is to classify the operation being performed: destructive filesystem action, irreversible third-party mutation, credential release, money movement, public publish, or force push. Gate strength follows the operation's reversibility.

Free-text stakes can inform the operator, but it should not be the sole authority for approval tier. If user-controlled prose can raise or lower the gate by quoting policy words, the gate is an injection surface. The runtime should anchor approval to typed operation semantics first, then use semantic review for ambiguous context where the operation record alone is insufficient.

Authorization must derive from declared relations, not caller-controlled identity strings. A runtime variable, request header, local profile name, or agent-provided id can select a subject, but it cannot prove membership, ownership, entitlement, or trust tier by itself. Team access, contributor rights, paid route access, domain-owner lanes, and publish authority should come from signed rows, invite edges, receipts, or provider truth. Self-inclusion defaults are privilege-escalation holes unless a separate admitted row grants that authority.

Entitlements should fail closed on explicit active states. Paid access, subscription sponsorship, domain-owner lanes, premium route visibility, and contributor privileges should enumerate allowed states such as `active`, `trialing`, or `settled`; every unknown, expired, canceled, pending, failed, or provider-specific status maps to no access until a policy row says otherwise. Blacklisting one bad state is unsafe because provider state spaces grow.

Shared custody or mutation state needs a singleton writer. If two local runtimes, runners, hosts, or daemons can see the same wallet, auth store, browser profile, or route publish queue, they must not both be allowed to fire irreversible operations. The safe operation is hot-swap or lease transfer: advance the implementation, then restart or transfer the existing authority holder in place. Parallel runners are acceptable for read-only verification; they are unsafe for money, auth mutation, public publish, and third-party writes unless the lease protocol proves only one writer.

---

## 22. What Ships, What Is Partial, What Is Proposed

### Ships Today

- CLI and compatibility server facades
- browser-backed capture
- route discovery and endpoint extraction
- marketplace publish, fetch, search, and reuse
- skill and endpoint lifecycle states
- local route/domain caches
- ranking using relevance, reliability, freshness, and verification
- local credential vault with encrypted fallback
- MCP server mode
- x402-compatible payment-required responses and current settlement lane
- contributor payout identity and current routing
- practical verification, drift handling, and feedback loops

### Partial

- stateless binary as the sole local runtime authority
- embedded browser/Kuri primitives behind binary-owned leases
- graph-backed planning as a dominant product surface
- full route dependency graph semantics in every product path
- broad multi-party attribution beyond current contributor routing
- signed multi-signal trust score
- pre-publish formal quality gate
- higher-trust route tiers with explicit challengeability
- route-economy lifecycle beyond current paid access

### Proposed or Reference-Stage

- removal of long-lived local Unbrowse server as a required product substrate
- independent validator markets
- bonded and slashable route-maintenance claims
- TEE or sandbox-backed formal attestation
- deployed ERC-8004 registry binding
- full cryptographic proof-of-indexing economy
- wallet-gated local pipe plugin across arbitrary subprocess/native bridge calls
- restaking-secured app-chain or AVS for high-volume attestations

---

## 23. Architectural Tests

The architecture should be considered healthy only if these tests stay true:

1. **Reuse beats rediscovery.** For routes with a valid skill, resolve + execute is cheaper and faster than browser rediscovery.
2. **Fallback remains faithful.** When replay cannot act correctly, browser/context fallback can still settle the task.
3. **Operation DAGs are typed.** Edges are created by `requires` and `provides`, not per-domain hard-coding.
4. **DAGs are ledger-derived.** Rebuilding projections from append-only rows reproduces the same executable graph.
5. **Authority crosses one membrane.** Network, timeout, mutation, payment, and credential scope are declared at the boundary, not scattered through callers.
6. **Execution modes are abstract.** Callers request local, remote, browser, or paid execution; resolver policy selects concrete backends.
7. **Standard facades run beside authority.** OpenAI-compatible, MCP, HTTP, and SDK wrappers execute where they can reach the local/private runtime they wrap.
8. **The binary is the local runtime.** Long-lived local servers are compatibility facades; they do not own hidden session authority.
9. **Browser leases are explicit.** Kuri/browser helpers are embedded primitives with acquire/release witnesses, not independent stateful runtimes.
10. **Harnesses precede consumers.** Repeated source access, parsing, login, or route-selection work becomes a reusable capability before downstream apps duplicate it.
11. **Instances are manifests, not forks.** Repeated capability variants are generic runtimes parameterized by admitted manifests.
12. **Primitives replace repeated re-derivation.** Recurring mechanics graduate into named gated capabilities instead of being rediscovered in prompts.
13. **Declared substrate is inventoried first.** Existing dependencies, dormant adapters, local skills, and scaffolded tools are checked before parallel machinery is built.
14. **Wrong-root work becomes typed handoff.** If the active repo/runtime cannot execute the implementation, the artifact is stubs, schemas, probes, and pointers, not a shipped claim.
15. **Clients target a stable capability envelope.** CLI, MCP, SDK, and app callers receive the same status/value/artifact/witness/next-step shape even when the backend differs.
16. **Resolution is by kind and version before implementation.** A borrowed primitive, skill, MCP tool, route, or browser fallback is compatible only when it satisfies the requested schema and required outputs.
17. **Adapters normalize backend messiness.** Heterogeneous primitive outputs are converted at the compatibility boundary, not leaked to clients.
18. **Indexer contributions are machine-readable.** API recipes, failure patterns, workarounds, and best practices enter as typed candidate knowledge rows.
19. **Lookup precedes browser descent.** Resolvers check merged recipes, local cache, open discoveries, and known failures before fresh capture.
20. **Contribution confidence controls promotion.** Unverified issue rows cannot behave like merged verified capability records.
20a. **Best practices compile into primitives.** Verified indexing practices can promote into skill instructions, discovery backends, fallback policy, verifier fixtures, or docs projections.
20b. **Contribution fallbacks normalize.** Recipes, failure rows, and indexed best practices return the same capability envelope as routes, skills, tools, and browser fallbacks.
21. **Facts retain exact provenance.** Candidate rows point back to admitted source rows and raw trace pointers where allowed.
22. **Generated knowledge has anti-cheat prechecks.** Empty, skipped, generic, unsupported, or reproduction-free contributions are rejected before expensive verification.
23. **Capability views are part of the contract.** UI-bearing results carry render specs, actions, state bindings, and redaction policy.
24. **UI-bearing capabilities emit view frames.** App, dashboard, approval, receipt, and inspector claims are malformed without a declared view stream or pointer.
25. **Views compose by capability graph.** Parent views can embed requirement, receipt, screenshot, and child capability views without hand-authored client glue.
26. **Primary surfaces hide developer chrome.** Raw ids, hashes, traces, and slugs stay in evidence panes or developer tools unless explicitly requested.
27. **UI state is shared runtime state.** Dismissed requirements, active runs, consumed panels, and progress survive remounts and transport changes.
28. **Streaming render preserves partial text.** Incremental updates do not trim or reparse away load-bearing chunk boundaries.
29. **Translation preserves scope.** User-facing language can simplify mechanism names but cannot upgrade unverified, partial, proposed, or failed states.
30. **Implementation terms are hidden by default.** Model ids, endpoint slugs, trace hashes, internal codenames, and protocol trivia stay out of primary surfaces.
31. **Visible statuses map to mechanisms.** Every user-facing status maps back to evidence, selection, policy, failure/repair, or structure rows.
32. **Cache identity is content-derived.** Same value resolves to the same key; changed value changes key.
33. **Ledger is append-only.** Claims are not silently overwritten.
34. **Signatures bind resolved values.** Pointers alone are not trusted.
35. **Local/cloud rows remain isomorphic.** Schema drift between local pointers and cloud graph rows is a named defect.
36. **Verification can fail.** Every green has a red path.
37. **Declared tools are implemented.** Skill, MCP, CLI, SDK, and prompt tool surfaces are generated from or checked against live handlers.
38. **Probes are self-validated.** Audit tools prove they inspect the real artifact and catch planted positives and negatives before their verdicts count.
39. **Runtime contracts enforce important paths.** Skills and prose are not treated as security or lifecycle controls.
40. **Executions leave journals.** A process exit or HTTP 200 without a durable execution trace is not enough.
41. **Unavailable is typed.** Missing telemetry, auth, embedder, or verifier state is represented as `unavailable(reason)`, not as zero, empty, or fallback success.
42. **Requirement blocks are transport-neutral.** Auth, payment, approval, browser, captcha, refusal, and routing states use one runtime envelope rendered differently by CLI, MCP, SDK, and app surfaces.
43. **Triggers prove dispatch, not intent.** A trigger claim is not shipped until the production runner records `dispatch_started` and `dispatch_completed`.
44. **Context orientation precedes expensive descent.** Resolver paths expose known context and missing dependencies before browser capture or live browsing.
45. **Standing watches are durable and auditable.** Deferred verification or dispatch has owner, predicate, expiry, and callback capability.
46. **Loops settle on objective state.** Repeated execution stops on witnessed terminal states, not arbitrary turn counts or invisible control verbs.
47. **Held work rewakes by dependency edge.** A blocker becoming satisfied emits a journal-visible re-judgment event instead of relying on polling.
48. **Stalls rotate strategy.** Repeated red gates with no new evidence change selector, fallback plane, corpus, witness, or tactic before retrying.
49. **Opt-in extensions are identity-on-empty.** New steer, cancel, policy, or subscriber surfaces preserve byte-identical behavior when no extension input is present.
50. **Schedulers cannot overlap themselves.** Timers and journal tailers have in-flight guards and cursor-based reads.
51. **Ceremony is measured.** Human/multi-witness judgment is reserved for ambiguous, irreversible, public, paid, or authority-bearing transitions.
52. **Witnesses cross independence boundaries.** Self-authored mocks and fixtures do not prove external wire, driver, browser, payment, or protocol behavior.
53. **Production callers are required.** Correct primitives with no live caller are marked dormant, not shipped.
54. **Producer keys match consumer lookups.** A pipeline is not live until the value is persisted under the key its consumer actually reads.
55. **Surface claims launch the surface.** App, MCP, SDK, browser, and UI claims are witnessed through that surface, not by adjacent component tests.
56. **Failed ranking signals rank last.** Missing embeddings, freshness, reliability, or verifier scores cannot silently become best scores.
57. **Test data cannot steer production.** Synthetic fixtures and planted routes do not remain in production routing caches.
58. **Routing complexity earns its place.** Hierarchy, multi-hop, and re-retrieval are kept only for corpus regimes where they beat flat single-hop retrieval.
59. **LLMs stay out of tight loops unless measured.** Per-step model calls must beat their latency cost against deterministic execution.
60. **Idempotency is behavioral.** Replay caches prove no redispatch, order-independent keys, value-sensitive misses, cached falsy values, single-flight concurrency, evict-on-reject, and loud failure.
61. **Receipts dedup by stable body.** Time-varying wrappers do not define semantic identity.
62. **Live adapter rows declare rematerialization.** Journal rows that point to adapters name the adapter and input hash, and distinguish live truth from fixed artifacts.
63. **Generated projections are rebuildable.** Indexes, backlinks, catalogs, and corpora derive from canonical records rather than becoming hidden sources of truth.
64. **Manifest fields have coverage.** Load-bearing fields are tracked as declared, consumed, and verified; unconsumed fields do not imply runtime behavior.
65. **Registration implies visibility.** A capability is not active until resolver, catalog, watch, and rendering projections can observe it through canonical events.
66. **Catalogs are passive projections.** App-visible lists, drawers, search indexes, and docs derive from registry and lifecycle rows; writes use named command paths.
67. **Activity status follows activity events.** Working/capturing/executing statuses are driven by fresh step events, not process liveness alone.
68. **Telemetry is first-party and typed.** Resolver, executor, UI, payment, publish, and failure signals enter owned journals or event tables with provenance and privacy class.
69. **Status surfaces tail durable rows.** CLI watches, MCP streams, dashboards, and app progress can be reconstructed from the ledger.
70. **Journal readback proves dispatch.** End-to-end execution witnesses read durable records back, not only process exit or HTTP status.
71. **Cold artifacts include required state.** Learned models, schemas, indexes, corpora, and bindings ship, mount, or regenerate before claimed execution.
72. **Dependencies live on the runtime lookup path.** Packaged drivers, models, native libraries, schemas, and indexes are verified where the runtime actually loads them.
73. **Live runners prove freshness.** Running daemons, apps, servers, extensions, and workers expose build identity or a live-path witness after source changes.
74. **Operational learning passes gates.** Journals and failures become graph atoms only through raw-event -> gated-atom -> canonical-record promotion.
75. **Deploys prove environment coverage.** Required env, secret, runner, wallet, and callback bindings are checked before release.
76. **Capture scope names privilege.** Runtime claims distinguish browser, transcript, file-watch, process, and whole-machine capture authority.
77. **Seals bind allowed environments.** Repointing a sealed artifact to an unapproved gateway, domain, workspace, or trust tier fails closed.
78. **Authority-bearing operations are server-side atomic.** Scarce grants, paid access, route publication, and wallet allowances are not enforced by client-only sequences.
79. **The host owns lifecycle bounds.** Client timeouts, retries, and cancellation policies cannot silently override the supervising runtime.
80. **Shared authority has one active writer.** Money, auth, publish queues, and mutation state use a lease, hot-swap, or singleton guard before irreversible work.
81. **Custody reconciles externally.** Local settlement rows, docs, and config are checked against chain/provider/canonical settlement truth.
82. **Mirrors carry real receipts.** Payout and payment projections include source receipt id, amount, asset, payee, and timestamp rather than speculative placeholders.
83. **Live-money paths have three brakes.** Per-operation cap, dry-run, and explicit arm are independent gates.
84. **Payment fanout is disclosed before signature.** Splitters, deferred cranks, or contributor shares are visible in the signed intent.
85. **Ranking is quality-based.** Stake, payment, or markup cannot buy organic trust ranking.
86. **Resolvers fuse signals.** Dense retrieval, lexical retrieval, schema evidence, and reliability are combined transparently; none silently replaces the rest.
87. **Retrieval tests include hard rewrites.** Paraphrase and intent-routing claims include zero-overlap or otherwise leakage-resistant controls.
88. **Local runtime does not require localhost HTTP.** HTTP serving is an optional front door; the local app can invoke the runtime through a direct process or socket boundary.
89. **Selectors are not generators.** Route ranking and route generation claims are benchmarked separately.
90. **Auth and money stay isolated.** Credentials, payments, route metadata, and mutation authority do not collapse into one record.
91. **Paid endpoints are named capabilities.** x402 calls carry endpoint-specific schema, permission, and receipt policy.
92. **One writer per source of truth.** Each external truth source normalizes through one canonical writer before readers consume it.
93. **Implementation is not activation.** Code that exists but is not on the production path is marked shadow or partial, not shipped.
94. **Approval follows irreversibility.** Human gates are based on operation authority and reversibility, not keyword matching.
95. **Authorization is relation-derived.** Caller-controlled identity strings do not prove membership, ownership, entitlement, or publish authority.
96. **Entitlements are allowlisted.** Unknown, failed, canceled, expired, or pending statuses fail closed unless explicitly admitted.
97. **Context-dependent capabilities abstain honestly.** Missing display, wallet, browser auth, or network context is `skipped` or `unavailable`, not fake success.
98. **Retirement is typed.** Deprecated capabilities carry a cause and, where applicable, the replacing/refuting witness.
99. **Private mechanisms do not cross the public boundary.** Public artifacts expose the what, not the closed how.
100. **Learning claims are witnessed.** Graph compounding and model/ranker improvement are described separately.
101. **Benchmarks name their corpus.** Toy, smoke, held-out, and public benchmark claims are not conflated.
102. **Benchmark metrics match objectives.** Completion, action efficiency, latency, cost, attribution, and mutation success are not substituted for one another.
103. **Mutating gates snapshot before they run.** Regression-attribution gates back up affected content before any test command can mutate it.
104. **Behavioral delta precedes expensive comparison.** A mechanism earns A/B or benchmark compute only after it changes the relevant output distribution.
105. **Promotion gates test the promoted property.** Identity, behavior delta, release readiness, and live value are separate checks.
106. **Audits are falsified before trusted.** Leak, replay, paper, and benchmark guards catch planted violations.
107. **Reachability is required for shipped status.** A feature that exists only behind an internal file path is not shipped.
108. **Failure reasons are localized.** Compound gates emit stable reason codes instead of opaque exit 1 verdicts.
109. **Witnesses are deterministic enough to trust.** Flaky gates are fixed before their verdicts are used.
110. **Placebo greens are blocked.** Empty, skipped, vacuous, or all-fixture passes cannot mark a claim settled.
111. **Prose commitments become artifacts.** Claimed rules, probes, specs, and queues are written to durable files, scripts, rows, or issues.
112. **Green tests get placement review.** A primitive is not promoted until a cold read confirms it belongs at the consumer boundary where it was wired.
113. **Audience docs are separate strata.** SDK/public docs, examples, and notices live in their own validated tree away from internal architecture.
114. **Every public shipped claim maps to code.** Papers and docs pass their gates before release.
115. **Benchmark labels admit equivalents.** Retrieval corpora support accepted-label sets, equivalence classes, or explicit near-tie adjudication.
116. **Benchmark paths are pure.** Hidden answer keys, recorded gold actions, and replay traces cannot enter generalization benchmarks through opaque agent APIs.
117. **Rerankers are regime-gated.** Fusion and reranking transforms are admitted only where held-out domain/query-regime evidence shows lift.
118. **Served projections read back.** Published docs, catalogs, marketplace rows, and resolver indexes are verified through the client-visible surface.
119. **Verifiers target failure mode.** Faithfulness, relevance, route correctness, auth, freshness, and shape checks are distinct instruments.
120. **Policy wins account for trials.** Ranker, resolver, and prompt-policy claims record variants tried, sample floor, split, and overfit penalty.
121. **Handoffs survive cold readers.** Contributions include enough declared context for a fresh reader to execute or reject them.
122. **Execution acts at roots.** Executors prefer the highest authorized environment root before leaf walking.
123. **Capability history is a DAG.** Skill, route, verifier, recipe, and manifest versions are content-addressed parent graphs, not overwritten rows.
124. **Public facts are derived.** Release, corpus, route, capability, hash, and endpoint facts come from canonical snapshots or live derivers.
125. **Benefits reach consumers.** Credits, allowances, free months, and entitlements are verified where checkout, resolver, executor, or settlement consumes them.
126. **Boundary tests use real wires.** Important serializers, envelopes, receipts, traces, and driver outputs are tested against externally produced artifacts.
127. **Security verifiers consolidate.** Duplicate signature, payment, auth, and seal checks become shared primitives once drift is observed.
128. **Approval gates are semantic.** User-controlled keyword coincidence cannot be the sole authority for irreversible-operation approval.
129. **Server claims persist.** Cloud/server ownership claims prove durable state, live callers, and consumed envelope fields.
130. **Cold-start imports stay local until gated.** Histories and transcripts enter as scoped, redacted, content-hashed candidate rows.
131. **Grounding is falsified pre-emit.** Source pointers resolve, citation load is bounded, and duplicate filler fails before review.
132. **Dispatches run inside fences.** Read/write/exec/net/env/approval/budget grants are declared and enforced per run.
133. **Benchmarks use the served universe.** Scores name the domain, route, auth, transport, and pricing slices the product can actually reach.
134. **Joins use canonical keys.** Stable ids or declared profile filters beat fuzzy slugs when aligning product surfaces to historical evidence.
135. **Corpora declare frame conventions.** Sign, orientation, timestamp, aggregation, and normalization rules are named before reuse.
136. **Exploration commits before switching.** Executors lock, advance, stale, fail, or ban a branch before novelty sends them elsewhere.
137. **Verifier exits prove predicates.** Check commands fail when the claimed artifact, route, anchor, or build output is absent.
138. **Evaluators do not score themselves.** Gate corpora exclude logs, summaries, labels, and thresholds emitted by the evaluator itself.
139. **Human-run commands are tested.** User-facing shell snippets and repair recipes are verified on the declared target platform and shell.
140. **Confidence gates escalation.** Cheap-path execution records agreement, margin, sample count, and threshold before avoiding escalation.
141. **Routing signals are discovered.** Regime dispatch uses measurable task/environment features rather than hard-coded site or benchmark ids.
142. **Recall ranks survivors.** Verified survivors, negative records, and retired records all shape resolver ranking explicitly.
143. **Attention effects are ledgered.** Context-ranking operations record query hash, candidate set hash, scoring method, dependencies, and selected ids.
144. **Residuals shrink by witnessed bricks.** Hard gaps carry a residual ledger of independently verified reductions before keystone closure.
145. **Progress metrics pass base-rate checks.** High-frequency motion signals are not promoted as success without a rarer progress witness.
146. **Action surfaces expose control maps.** Safe probes record observed control effects before models reason over UI actions.
147. **Subprocesses are bounded.** Local commands declare timeout, output, cwd, environment, and traversal limits and fail loudly on bound breaches.
148. **Measurements separate zero from unavailable.** Real zeros carry source and as-of evidence; missing sources return `unavailable(reason)`.
149. **Payment handlers are keyless.** The substrate surfaces requirements and verifies receipts without holding wallet private keys.
150. **Paid calls can be stateless.** Per-call settlement paths do not require an internal credit ledger when the quote, signature, settlement, and receipt are atomic.
151. **Spendable balance is typed.** Settlement rows distinguish venue-spendable balance from notional wallet holdings and name required conversion state.
152. **Scarce grants use command RPCs.** Credits, slots, premium access, and sponsored entitlements are assigned through idempotent server-owned commands, not direct table writes.
153. **Wire contracts are transport-invariant.** Native IPC, stdio, socket, HTTP, MCP, and browser channels carry the same envelopes, frames, terminal states, and receipts.
154. **Native registries beat wrapper stacks.** Extra HTTP or MCP child layers are admitted only when they buy isolation, ecosystem reach, concurrency, or another real boundary.
155. **Dispatch grammar is recursive.** One-shot tools, long-running loops, and nested capability calls use the same command/envelope/frame/terminal protocol.
156. **Auth capture is prerequisite state.** Authenticated mutations stop with a typed sign-in requirement until a managed-browser login artifact exists.
157. **Local brokers avoid listening ports.** OS-local dispatch uses filesystem/process authority when possible instead of adding a network auth surface.
158. **Learned artifacts prove redaction and reachability.** Private-session-derived models, indexes, and memories pass scrub checks before training and route smoke after serving.
159. **Recognition precedes synthesis.** Resolver policy tries verified route-family, replay, and archetype matches before asking a model to invent a new plan.
160. **Verified caches are policy corpora.** Content-addressed replay and route memories can be executable policy only when typed, witnessed, and scoped to their corpus.
161. **Pattern rankers are not truth engines.** Similarity, energy, and survivor scores carry corpus and gate provenance instead of pretending to be universal correctness.
162. **Scope filters leave drop ledgers.** Pre-ranking filters name admitted and excluded populations, sample the dark universe, and classify each drop reason.
163. **Thresholds use decision-time frames.** Scan-time, auth-time, health-time, or pricing-time filters are evaluated at the moment they make the live decision.
164. **Worst slices gate aggregate health.** Global route scores report the worst admitted domain, auth tier, time window, geography, or payload slice with its repair mechanism.
165. **Audit exclusions are proven inert.** Scans exclude only mechanically inert paths, not folders trusted because of names like examples, reference, or design.
166. **Runtime pins are witnessed.** Release gates record the effective executable path and version for load-bearing runtimes and fail on pin drift.
167. **Model behavior classes are declared.** Structured-output capabilities name model variant, runner, IO contract, smoke check, and fallback behavior.
168. **Daemon restarts are atomic.** Long-running services expose a bootstrap-or-bounce verb that advances the live process without duplicate writers or absent-service windows.
169. **Live buses are exercised.** After restart or hot-swap, verification drives the real emit-to-listen or request-to-journal path, not only source tests.
170. **Launch claims launch.** App, extension, MCP, and hosted UI claims boot the packaged surface and exercise one capability through that surface.
171. **Fixtures are real-shaped.** Test payloads resemble producer outputs closely enough to exercise parsers, recorders, transports, and guarded branches.
172. **Transport witnesses decode bodies.** HTTP and wire witnesses validate decoded payloads according to response headers, not merely status codes.
173. **Process witnesses cannot self-match.** Process checks avoid matching their own wrapper text and prove absence when the real process is not running.
174. **Architecture claims bind to manifests.** Paper claims about the bridge surface name exact manifest fields and fail when `src/superpattern/bridge-manifest.ts` drifts.
175. **Canonical CLI verbs are exercised.** `create`, `act`, and `read` are real CLI entry points, while legacy commands are declared aliases rather than a second contract.
176. **Agentic manifests are parse-clean.** Machine-readable CLI surfaces emit JSON on stdout without trace, drain, or server-bootstrap log prelude.
177. **Staging proves served compatibility.** A deployed staging endpoint serves the same `CapabilityResult` contract and fallback hierarchy as local code.
178. **Paper, CLI, backend, and staging agree.** Acceptance tests compare the internal paper, local CLI manifest, backend handler, and live staging response for the same contract.

---

## 24. Reusable Project Lineage

The architecture should explicitly preserve the lessons from the neighboring projects:

| Source | What Unbrowse Should Use |
|---|---|
| ManicMind | capability commons, local/cloud pointer split, runtime contracts, selector-vs-generator boundary, compatibility ladder, kind-name contracts, declared-tool coverage, harness-first decomposition, manifest-parameterized instances, manifest-field coverage, primitive graduation, typed handoffs, capability views, mandatory UI view frames, standard-compatible local facades, translation boundary, composable UI nodes, shared UI state, activity-vs-liveness status, developer-chrome gates, public/internal doc strata, structured requirement blocks, objective-metric alignment, behavioral-delta gates, mutating-gate state isolation, objective-driven loops, dependency rewake, identity-on-empty opt-in extensions, steer/interrupt events, stall-triggered strategy rotation, scheduler re-entrancy guards, context orientation, dispatch-truth triggers, standing watches, independent witnesses, live-caller checks, probe self-validation, ranking-failure semantics, capture privilege scope, cache hygiene, idempotent replay, generated projections, served-projection readback, derived public facts, ledger-derived DAGs, authority membranes, abstract execution modes, registry visibility events, live adapter pointers, passive ledger-tailed UI, first-party typed telemetry, journal-readback dispatch proof, runtime dependency colocation, live-runtime freshness, relation-derived authorization, fail-closed entitlement states, prose-to-artifact discipline, cold placement review, cold-reader handoffs, cold-state bundling, deploy/env coverage, environment-bound seals, host-owned lifecycles, singleton authority guards, reachability gates, deterministic witnesses, shape-vs-payload ledger split, durable negative knowledge, label-equivalence evaluation, benchmark path purity, served-universe evaluation, canonical join keys, corpus frame conventions, progress-base-rate checks, trial-accounted policy claims, regime-gated reranking, confidence-gated escalation, discovered-signal routing, survivor-ranked recall, ledgered attention effects, residual brick ledgers, failure-mode-specific verification, root-first execution planning, control-map probes, commit-then-explore execution, bounded subprocesses, unavailable-vs-zero measurements, version-node capability history, consumer-path benefit tracing, external-wire fixtures, shared security verifiers, semantic approval gates, durable server-state claims, scoped cold-start imports, pre-emit grounding falsifiers, per-dispatch capability fences, predicate-bound verifier exits, evaluator-output exclusion, target-platform command witnesses |
| ManicMind settlement notes | keyless x402 handlers, per-endpoint payment cells, per-call settlement, spendable-vs-notional custody, command-shaped scarce grants |
| ManicMind substrate notes | declared-substrate inventory, transport-invariant wire contracts, native registry integration, recursive dispatch grammar |
| ManicMind auth/privacy notes | interactive auth capture as prerequisite state, no-listening-port local brokers, redaction-before-learning, served route smoke for derived artifacts |
| ManicMind recall/routing notes | recognize-then-recall dispatch, verified replay as executable policy corpus, structural-fit rankers with corpus provenance |
| ManicMind scope/eval notes | filter drop ledgers, decision-time threshold frames, worst-slice gates, evidence-backed audit exclusions |
| ManicMind runtime-ops notes | effective runtime pin witnesses, model behavior-class manifests, atomic daemon bounce verbs, live bus exercise after hot-swap |
| ManicMind verifier/fixture notes | launch witnesses for product claims, real-shaped fixtures, transport decoding checks, self-match-resistant process probes |
| collective-learning | machine-readable agent discoveries, lookup-before-browser, API-first recipe hierarchy, PR/issue contribution lanes, verification labels, best-practice-to-primitive promotion, contribution fallback normalization |
| unbrowse-skill | observed behavior -> endpoint descriptors -> operation DAG -> replay contract |
| ArkLib | source-of-truth files, generated-output discipline, validation before publishing |
| Superpattern | plan/build/test/judge loop; no fabricated green; design vs benchmark separation |
| ARC repos | honest frontier ledger; replay quarantine; behavioral-delta gates; live-vs-proxy separation; negative results as constraints |
| sota-arc3 `.claude` sessions | falsify-first audits, mechanical branch execution, invalid partial-run handling, apparatus diagnosis |
| CodeGraff | clean architecture layers and facade separation |
| TinyLLM | held-out gates, leakage checks, dev-before-test honesty guard |
| imabettingman | append-only risk planes for money, auth, state, and live execution; external custody reconciliation; real receipt mirrors; cap/dry-run/arm brakes |

This lineage is not branding. It is a checklist against architectural drift.

---

## 25. The Internal Thesis

Unbrowse is not just "browser automation, but faster."

It is a capability substrate with four compounding loops:

1. **Route reuse loop:** capture once, execute many times.
2. **Quality loop:** execution feedback updates ranking and lifecycle state.
3. **Maintenance loop:** route freshness becomes a claim that can be checked and, for higher tiers, challenged.
4. **Capability loop:** web routes, MCP tools, skills, and local pipes converge into one typed capability commons.

The moat is not any single route. A route can be copied. The moat is the maintained, verified, paid, and increasingly trusted graph of capabilities, plus the local-first runtime that can keep discovering new capabilities when the graph misses.

The architecture should therefore bias toward:

- typed capability records over ad hoc route blobs
- stable capability envelopes over client-specific backend shapes
- indexer-contributed knowledge over private repeated rediscovery
- lookup-before-browser over blind fresh capture
- best-practice promotion over sidecar prose advice
- normalized contribution fallbacks over source-specific client logic
- exact provenance pointers over paraphrased durable memory
- anti-cheat prechecks over expensive placebo verification
- declared tool coverage over advertised-but-missing handlers
- capability views over hand-authored per-client presentation
- required view frames over fallback-only UI claims
- shared UI/runtime state over remount-local bookkeeping
- activity-event status over process-liveness status
- user-facing status over leaked developer chrome
- scope-preserving translation over public-facing claim drift
- mechanism taxonomy over mystical or implementation-heavy labels
- kind/version compatibility over implementation coupling
- abstract execution modes over provider-specific backend menus
- standard-compatible facades beside runtime authority
- borrowed primitives over duplicated backend features
- keyless payment handlers over substrate-held private keys
- per-call settlement over unnecessary credit ledgers
- spendable-balance typing over wallet-balance assumptions
- command-shaped grants over direct scarce-table writes
- harness-first decomposition over app-specific one-offs
- declared-substrate inventory over reinvention
- manifest-parameterized instances over hardcoded capability forks
- manifest-field coverage over declared-but-ignored behavior
- gated primitives over repeated prompt re-derivation
- typed handoffs over wrong-root shipped code
- operation DAGs over isolated endpoint lists
- ledger-derived graphs over independent graph stores
- shape-inline and payload-by-pointer ledger rows
- local/cloud schema isomorphism over accidental client/server drift
- content-addressed values over mutable identifiers
- append-only receipts over overwriteable state
- behavioral idempotency over hash-shaped assumptions
- live adapter pointers over stale output snapshots
- generated projections over hand-maintained secondary truth
- authority membranes over scattered permission conventions
- relation-derived authorization over caller-controlled identity
- registry visibility over file-presence activation
- passive ledger-tailed surfaces over local invented UI state
- first-party typed telemetry over opaque analytics dependencies
- journal readback over process-exit dispatch proof
- transport-invariant wire contracts over protocol-specific semantics
- native registry integration over wrapper stacks without boundary value
- recursive dispatch grammar over agent-vs-tool protocol splits
- auth-capture prerequisites over optimistic replay
- no-listening-port local brokers over avoidable network auth surfaces
- redaction-and-route witnesses over private-session learning claims
- cold artifacts that include their learned state
- gated graph compounding over manual knowledge copy
- deploy coverage gates over best-effort environment setup
- effective runtime pin witnesses over shell-activation assumptions
- model behavior-class manifests over interchangeable checkpoint assumptions
- runtime dependency colocation over repo-present but loader-invisible artifacts
- atomic daemon bounce verbs over stop-start service gaps
- live bus exercise over source-only restart claims
- environment-bound seals over movable private artifacts
- host-owned lifecycle bounds over hidden client timeouts
- singleton authority guards over parallel irreversible daemons
- objective-driven loops over one-shot calls or infinite retries
- dependency rewake over blind polling
- identity-on-empty opt-in extensions over broad behavioral migrations
- steer/interrupt events over invisible control verbs
- stall-triggered strategy rotation over repeated same-tactic retries
- cursor tailers and in-flight guards over quadratic journal watchers
- named firmaments over informal boundaries
- cold verifiers over self-graded success
- reachable user paths over orphaned green components
- first-class verbs over prose instructions
- independent external witnesses over self-authored mocks
- production callers over dormant correct primitives
- failed ranking signals that degrade over neutral defaults
- clean routing caches over test residue
- structured requirement blocks over prose failures
- dispatch-complete trigger claims over intent-only trigger rows
- capture privilege declarations over assumed whole-machine visibility
- context orientation before browser descent
- durable standing watches over blind retry loops
- selector cascades over pretending a small model is universally smart
- localized gate failures over opaque compound exits
- promotion gates that test the specific promoted property
- durable artifacts over promises left in prose
- cold placement review over assuming green tests prove fit
- held-out benchmark gates over toy greens
- objective-matched metrics over convenient proxy scores
- label-equivalence corpora over single-gold fixture bias
- path-pure benchmarks over hidden answer-key channels
- served-universe scoring over broad corpus averages
- filter drop ledgers over invisible dark universes
- decision-time threshold frames over retrospective-only coverage claims
- canonical join keys over fuzzy slug matching
- declared corpus frames over silent sign/orientation mismatches
- worst-slice health over aggregate-only reliability
- progress-base-rate checks over high-frequency motion objectives
- trial-accounted policy selection over final-score winner bias
- regime-gated reranking over assumed universal ranker upgrades
- confidence-gated escalation over always-upgrade or never-upgrade routing
- discovered-signal dispatch over hardcoded site or benchmark switches
- survivor-ranked recall over tool-name matching
- recognize-then-recall over default synthesis
- verified cache policy over parametric retraining by reflex
- structural-fit scoring over truth-engine claims
- ledgered attention effects over invisible context selection
- residual brick ledgers over undifferentiated swarm volume
- served-projection readback over local publish intent
- derived public facts over hand-typed product numbers
- consumer-path benefit tracing over layer-local grant success
- external-wire fixtures over both-sides-authored mocks
- launch witnesses over adjacent CLI/component smoke tests
- real-shaped fixtures over placeholder payloads
- decoded transport witnesses over status-only checks
- evidence-backed exclusions over folder-name trust
- self-match-resistant process probes over wrapper-grep greens
- shared security primitives over drifting duplicate verifiers
- semantic approval gates over keyword-triggered policy matches
- durable server state over endpoint-shaped stubs
- scoped local-history imports over unbounded learning claims
- pre-emit grounding falsifiers over review-time citation cleanup
- per-dispatch capability fences over prompt-only scope control
- predicate-bound verifier exits over condition-independent success codes
- source-only evaluator corpora over self-referential log scans
- target-platform command witnesses over untested copy-paste recipes
- failure-mode-specific verifiers over generic faithfulness badges
- cold-reader handoffs over builder-context assumptions
- root-first execution over leaf-walking automation
- probed control maps over pixel/label control guessing
- commit-then-explore loops over pure novelty thrash
- bounded subprocesses over stream-hanging local tools
- unavailable measurement envelopes over silent zero defaults
- version-node DAGs over mutable capability history
- pre-run content snapshots over stash-based mutation isolation
- behavioral-delta probes over inert correctness-only mechanisms
- live-runtime freshness over source-only green tests
- probe self-validation over trusting audit tools by default
- preserved negative results over buried failures
- quality-ranked trust over pay-for-placement
- isolated auth/money/mutation planes over convenient coupling
- fail-closed entitlement allowlists over blacklist-style access checks
- external custody reconciliation over local-state assumptions
- real receipt mirrors over speculative payout projections
- cap/dry-run/arm brakes over strategy-trusted live money
- disclosed payment fanout over hidden client-side rewrites
- stable usage settlement over tokenized UX
- optional accountable bonding only where higher trust justifies it
- public docs that reflect code and never leak the moat
- physically separate public docs over mixed audience strata

That is the line from the whitepaper to the internal product architecture: internal APIs are the wedge; the maintained capability graph is the asset; verification is the trust layer; local pipe composition is the missing floor; and the whole system stays credible only when every claim can be witnessed.
