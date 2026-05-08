# NORTHSTAR.md

## The Single Sentence

> **An agent gives Unbrowse a URL and an intent; Unbrowse chooses the cheapest correct path to the outcome: direct call, shared graph, index, browser, or auth.**

Agents do not want to browse. They do not want to index. They do not want to pick endpoints. They want the web task done correctly, cheaply, and quickly.

The public product is:

```bash
unbrowse run <url> "task"
```

Everything else is an implementation primitive.

## The Paper Claim

The arXiv paper, *Internal APIs Are All You Need*, argues that browser-first agent architectures pay the same discovery tax repeatedly. Websites already expose first-party internal APIs behind their UI. Unbrowse turns those hidden interfaces into a shared route graph, then routes agents through:

1. local cache
2. shared graph
3. browser fallback

The important product claim is not "we have many CLI commands." It is:

> Given an intent, Unbrowse automatically routes to the lowest-cost path that preserves correctness.

That is the bar.

## First Principles

### 1. Agents Want Outcomes, Not Modes

The agent's job is not to decide whether to call:

- `resolve`
- `execute`
- `capture`
- `index`
- `go`
- `snap`
- `click`
- `auth-capture`

Those are internal levers. If an agent has to pick them, the abstraction leaked.

The agent should express:

```text
intent + url + optional params
```

Unbrowse should return:

```text
result
```

or, when human/security action is required:

```text
next_action
```

with a clear `run_plan` explaining what happened.

### 2. Correctness Dominates Speed

A direct API call is better than browser automation only if it returns the right thing.

Every candidate path must be gated by:

- semantic match to the user's intent
- request parameter compatibility
- response schema/output confidence
- auth/session requirements
- side-effect classification
- policy/payment/robots constraints
- freshness and drift state
- historical execution success

Fast wrong output is worse than slow browser fallback.

### 3. Browser Is Ground Truth, Not The Product

Browser execution is the fallback and discovery instrument.

It proves:

- which route the site actually called
- which params matter
- which auth/session tokens are required
- what response shape maps to the UI outcome
- whether a route is stale

But browser should not be the normal agent UX.

The ideal state is not "agents browse better." The ideal state is "agents browse less because every browser session improves future direct execution."

### 4. Indexing Is A Planner Decision

Indexing should not be a user decision.

Unbrowse should index when the expected value is positive:

- no suitable route exists
- existing route failed
- schema drift is detected
- browser capture observed new API evidence
- the task shape is likely reusable
- capture cost is lower than expected repeated rediscovery cost

Unbrowse should not index to bypass:

- `payment_required`
- unsafe mutations
- third-party confirmation gates
- robots/policy denials
- auth walls requiring human action

### 5. The Graph Wins Only Against The Outside Option

The shared graph is disciplined by browser rediscovery.

An agent should use the graph only when:

```text
graph_fee + graph_latency + failure_risk
<
browser_rediscovery_cost
```

Browser rediscovery cost includes:

- page load latency
- browser runtime cost
- LLM tokens spent reading DOM/page state
- sequential interaction overhead
- failure probability
- retry cost
- opportunity cost of blocking the agent

This cost comparison should become executable product logic, not just paper language.

## Product Contract

### Public Surface

Primary commands:

```bash
unbrowse run <url> "task"
unbrowse auth <url>
unbrowse fetch <url>
```

Advanced/debug primitives:

```bash
unbrowse resolve ...
unbrowse execute ...
unbrowse capture ...
unbrowse go ...
unbrowse snap ...
unbrowse click ...
unbrowse fill ...
unbrowse sync
unbrowse close
```

The advanced commands stay available because engineers need escape hatches. They should not be the happy path in docs, skills, MCP prompts, or agent memory.

### `run` Input

```json
{
  "url": "https://www.carousell.sg/search/beige%20pants",
  "intent": "find beige cargo pants size L under S$50",
  "params": {
    "size": "L",
    "budget_max": 50
  },
  "policy": {
    "allow_browser": true,
    "allow_index": true,
    "allow_paid_graph": true,
    "allow_side_effects": false
  }
}
```

Most users should never pass `policy`. Defaults should be conservative:

- read-only direct calls allowed
- capture/index allowed on true misses
- browser fallback allowed for read tasks
- auth returns `next_action`
- side effects require explicit confirmation
- payment/policy gates are not bypassed

### `run` Output

Success:

```json
{
  "status": "ok",
  "result": {
    "items": []
  },
  "run_plan": [
    {"step": "resolve", "mode": "local_cache", "status": "miss"},
    {"step": "resolve", "mode": "shared_graph", "status": "hit"},
    {"step": "execute", "mode": "direct_api", "status": "complete"}
  ]
}
```

Needs auth:

```json
{
  "status": "auth_required",
  "next_action": {
    "command": "unbrowse auth https://www.carousell.sg",
    "why": "A site session is required before private routes can be executed."
  },
  "run_plan": [
    {"step": "resolve", "mode": "local_cache", "status": "miss"},
    {"step": "resolve", "mode": "shared_graph", "status": "hit"},
    {"step": "execute", "mode": "direct_api", "status": "auth_required"}
  ]
}
```

Needs browser:

```json
{
  "status": "browse_required",
  "next_action": {
    "command": "unbrowse snap --session sess_123 --filter interactive",
    "why": "The task requires page interaction before a reusable route can be learned."
  },
  "run_plan": [
    {"step": "resolve", "mode": "local_cache", "status": "miss"},
    {"step": "resolve", "mode": "shared_graph", "status": "miss"},
    {"step": "index", "mode": "capture", "status": "thin"},
    {"step": "browse", "mode": "kuri_session", "status": "opened"}
  ]
}
```

The `run_plan` is mandatory. It is how agents debug decisions without having to choose the tools themselves.

## Routing Algorithm

### Current Desired Order

```text
1. classify task
2. check local cache
3. check installed skills
4. query shared graph
5. execute best safe direct route
6. if true miss: capture and index
7. retry direct route
8. if auth blocked: return auth next_action
9. if still unresolved and browser allowed: open browse session
10. if side effect required: require explicit confirmation
```

### What Counts As A True Miss

Index/browse fallback is allowed for:

- `no_match`
- `no_cached_match`
- `not_found`
- stale route with failed verification
- route output failed schema/quality check
- capture evidence indicates newer route candidate

Fallback is not allowed for:

- `payment_required`
- `auth_required`
- `requires_third_party_terms_confirmation`
- `unsafe_mutation_unconfirmed`
- `robots_denied`
- policy denial
- explicit user opt-out

This distinction matters. Otherwise Unbrowse will accidentally use browser/capture to route around deliberate gates.

## Server-Side Architecture

The planner must live server-side.

Do not keep `run` as CLI glue. CLI, MCP, local HTTP API, Codex, Claude, and future hosts need one shared planner.

Target module:

```text
src/orchestrator/run-planner.ts
```

Target API:

```ts
type RunPlannerInput = {
  url: string;
  intent: string;
  params?: Record<string, unknown>;
  policy?: RunPolicy;
  projection?: Projection;
};

type RunPlannerResult = {
  status: "ok" | "auth_required" | "browse_required" | "payment_required" | "blocked" | "error";
  result?: unknown;
  next_action?: {
    title: string;
    command?: string;
    tool?: string;
    why: string;
  };
  run_plan: RunPlanStep[];
};
```

Public entrypoints:

```text
POST /v1/run
unbrowse run <url> "task"
MCP tool: unbrowse_run
```

All three must call the same planner.

## Cost Model

Start simple. Do not overbuild.

Each candidate path gets:

```text
expected_total_cost =
  expected_latency_ms
  + expected_token_cost
  + expected_browser_runtime_cost
  + expected_payment_fee
  + expected_failure_cost
  + policy_risk_penalty
```

Then filter by correctness and policy.

Pick the cheapest remaining path.

### Candidate Features

Local/direct route:

- last success timestamp
- consecutive failures
- schema drift score
- median execution latency
- auth requirement
- side-effect class
- semantic score
- parameter fit

Shared graph route:

- graph search fee
- install/payment fee
- contributor trust
- verification status
- freshness
- expected install latency

Capture/index:

- estimated capture latency
- likelihood of discovering route
- domain history
- JS-heavy/static-site signals
- expected reuse value

Browser:

- browser startup state
- auth state
- number of expected UI steps
- captcha/bot wall signals
- past success/failure for domain

## Quality Gates

A route is executable only if:

- method is safe for auto-execute (`GET`/`HEAD`) or mutation is explicitly confirmed
- required params are present or inferable
- auth requirements are satisfied
- third-party/payment/robots policy is satisfied
- endpoint is not disabled
- freshness is above threshold or revalidation succeeds
- response shape passes task-level quality checks

Task-level quality checks are not optional. For marketplace/listing tasks, returning JSON-LD aggregate metadata is not enough if the user asked for listings with prices and links.

## Auth Model

Auth is not just another fallback.

Rules:

- `run` may detect auth need.
- `run` may reuse existing local auth.
- `run` must not silently ask for credentials.
- `run` must not pretend cookie import equals completed site login.
- `run` returns `auth_required` with a clear `next_action`.
- `auth <url>` opens a visible browser and saves cookies.
- after auth, `run` resumes the same routing plan.

For OAuth/OTP automation, the agent layer can chain primitives later. The core planner should keep auth state explicit and auditable.

## Browser Model

Browser is used when:

- route does not exist
- route exists but is stale and cannot be repaired directly
- interaction is required to expose the route
- user-visible state must be inspected
- auth/session flow must be completed
- anti-bot/captcha blocks direct execution

Browser should feed the same capture/index pipeline automatically.

The long-term goal is universal capture:

- Kuri sessions
- attached Chrome sessions
- Playwright/Puppeteer sessions with CDP
- user Chrome with debug port
- agent-host browser sessions where attach is possible

Every real browser session should become route evidence.

## Indexing Model

Indexing is a byproduct of demand.

Do not crawl the web blindly. Learn from real tasks.

Index artifacts:

- request method/path/template
- query/body/header param schema
- auth/session token descriptors
- response schema
- sample values
- route health/freshness
- semantic descriptions
- workflow DAG edges
- side-effect class
- policy/payment metadata

Indexing should happen:

- immediately after useful capture
- in the background after browse checkpoints
- after safe verification
- after schema drift detection

Freshly captured local routes should be usable by the same `run` call before remote publish completes.

## CLI Cleanup Direction

Current command surface is powerful but too exposed.

Docs should present:

```bash
unbrowse run <url> "task"
unbrowse auth <url>
unbrowse fetch <url>
```

Advanced/debug docs can include:

```bash
unbrowse resolve ...
unbrowse execute ...
unbrowse capture ...
unbrowse go ...
unbrowse snap ...
unbrowse click ...
unbrowse fill ...
unbrowse sync
unbrowse close
```

Aliases:

- `login` -> `auth`
- `auth-capture` -> `auth`
- `resolve` remains advanced
- `capture` remains advanced
- browser primitives remain advanced

If an agent tutorial starts with `resolve`, `capture`, or `go`, it is teaching the implementation instead of the product.

## MCP Cleanup Direction

MCP should mirror the product surface:

Primary:

- `unbrowse_run`
- `unbrowse_auth`
- `unbrowse_fetch`

Advanced:

- `unbrowse_resolve`
- `unbrowse_execute`
- `unbrowse_capture`
- `unbrowse_go`
- `unbrowse_snap`
- `unbrowse_click`
- `unbrowse_fill`

Tool descriptions must say when a tool is advanced. Agents overfit to tool names; the descriptions are routing policy.

## Tests That Must Exist

Product path tests:

- `run` direct local hit executes safe endpoint.
- `run` shared graph hit installs/executes safe endpoint.
- `run` true miss captures/indexes, then retries.
- `run` thin capture opens browse.
- `run` auth wall returns `auth_required` and does not silently login.
- `run` payment required does not capture/index around payment.
- `run` third-party terms gate does not auto-execute.
- `run` unsafe mutation requires explicit confirmation.
- `run` protobuf endpoint beats JSON-LD fallback.
- `run` Carousell-style search returns listing titles, prices, sellers, and links.
- `run_plan` always explains the path taken.

Regression tests:

- stale route de-ranks after failures
- schema drift triggers revalidation
- captured route is usable before remote publish
- auth capture opens visible browser even when stale headless CDP exists
- no per-domain heuristics for common route extraction patterns

Evals:

- warm cache latency
- cold miss to first useful route
- browser fallback success rate
- direct route correctness
- task-level extraction quality
- graph hit rate by domain/task
- cost saved versus browser baseline

## Milestone Plan

### Milestone 1: Shared Planner

Goal: remove CLI-only decision logic.

Work:

- add `src/orchestrator/run-planner.ts`
- add `POST /v1/run`
- route `unbrowse run` through `/v1/run`
- preserve current `run_plan`
- keep existing CLI behavior as compatibility target

Done when:

- CLI and HTTP return identical decisions for same input
- tests cover direct, miss->capture, auth, payment, browse

### Milestone 2: MCP Product Surface

Goal: agents see the right default tool.

Work:

- add primary MCP `unbrowse_run`
- add primary MCP `unbrowse_auth`
- mark resolve/capture/browser tools as advanced
- update skill docs and generated tool descriptions

Done when:

- an MCP-hosted agent can complete a Carousell-style search through `unbrowse_run`
- no prompt guidance tells agents to manually choose capture first

### Milestone 3: Real Cost Model

Goal: route choice is score-driven, not hardcoded order only.

Work:

- define route candidate cost schema
- add latency/freshness/failure/payment features
- score local, graph, capture, browser candidates
- expose score reasons in `run_plan`

Done when:

- planner can explain why graph beat browser
- planner can explain why browser beat stale direct route

### Milestone 4: Fresh Capture Reuse

Goal: captured routes are usable in the same run.

Work:

- capture/index returns local route candidates
- planner can execute freshly indexed candidates before remote publish
- publish remains background/gated

Done when:

- first Carousell miss can capture protobuf/API route and return listings in one `run`

### Milestone 5: Universal Browser Evidence

Goal: all browser work feeds the graph.

Work:

- attach to existing Chrome/CDP sessions
- ingest HAR/interceptor evidence from attached sessions
- dedupe with Kuri-native sessions
- keep credentials local

Done when:

- agent-driven Chrome traffic outside Kuri still becomes route evidence

## Anti-Goals

- Do not add more public top-level commands unless they simplify the default path.
- Do not make agents choose between index/browse/resolve for normal tasks.
- Do not add per-domain route extraction hacks unless there is no general primitive and the issue is blocking.
- Do not treat JSON-LD aggregate metadata as success for listing/search tasks.
- Do not use capture/browser fallback to bypass payment or policy gates.
- Do not silently perform real-world side effects.
- Do not publish credentials.
- Do not make remote publish required before local reuse.

## North-Star Review Checklist

Every PR should answer:

1. Does this make `run` more capable?
2. Does this reduce agent decision burden?
3. Does this improve correctness or observability of route choice?
4. Does this reduce browser usage on repeated tasks?
5. Does this turn real browser work into reusable route knowledge?
6. Does this avoid per-domain special casing?
7. Does this preserve auth/payment/policy boundaries?

If the answer is mostly no, the PR is probably not on the North Star.

## Done State

The desired user experience:

```bash
unbrowse run "https://www.carousell.sg/search/beige%20pants" "find beige cargo pants size L under S$50 with links"
```

Unbrowse:

1. checks local routes
2. checks the shared graph
3. calls the best API route if known
4. captures/indexes if unknown
5. retries direct execution
6. opens browser only if interaction is needed
7. returns results or the single next action

The agent never asks:

- Should I resolve?
- Should I capture?
- Which endpoint should I execute?
- Should I open a browser?
- How do I index this?

That choice belongs to Unbrowse.

This is how the product becomes the paper: not a better browser, but an execution optimizer that continuously turns browser work into shared callable APIs.
