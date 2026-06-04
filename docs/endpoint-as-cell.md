# Endpoint-as-Cell — First Principles

> Lewis: "it's all the same cell structure. super meta harness over a super
> meta harness based on real world data. endpoint as the base. structure it
> right to follow nature by first principles."

## The single primitive: the cell

There is **one** data structure. A cell. Everything else is composition.

A single HTTP endpoint is a cell. A workflow of endpoints is a cell. A
super-skill bundling workflows is a cell. The whole marketplace view of
every cell that ever ran is a cell. Same shape top to bottom, just with
different things in its `children` field.

This is the entire data model, written once:

```ts
type Cell = {
  cell_id: string;
  kind: "atomic" | "composed";      // single endpoint vs. bundle

  // --- semantic surface ---
  capabilities: string[];           // ["list", "detail", "search", ...]
  intent_fingerprints: string[];    // ["get bitcoin price", ...]
                                    // anonymised from real past calls
  usage_instructions: string;       // prose hints derived from what
                                    // actually worked, redacted

  // --- composition ---
  children?: Cell[] | Array<{ cell_id: string; bind: Record<string, string> }>;
  walk?: "serial" | "parallel" | "dag";

  // --- extraction (atomic cells only) ---
  extraction?: {
    url_template: string;
    method: "GET" | "POST" | ...;
    strategy: ExtractionStrategy;
    sample_path?: string;
    response_schema: Record<string, unknown>;
  };

  // --- verification (same shape at every level) ---
  verification: {
    history: VerdictRow[];          // last N runs with verdict + sha + latency
    current_health: "healthy" | "degrading" | "broken" | "unverified";
    last_pass_at?: string;
    last_fail_at?: string;
  };

  // --- telemetry (same shape at every level) ---
  telemetry: {
    total_calls: number;
    unique_agents: number;
    success_rate_7d: number;
    p50_latency_ms: number;
    p95_latency_ms: number;
    failure_codes: Record<string, number>;
  };

  // --- dependencies (populated from real traffic) ---
  dependencies: {
    requires: Array<{ cell_id: string; bind: string }>;
    enables: Array<{ cell_id: string; bind: string }>;
    observed_with: string[];         // cells co-called in the same session
  };

  // --- self-heal ---
  self_heal: {
    fallback_chain: ExtractionStrategy[];
    tried_strategies: Array<{ strategy: ExtractionStrategy; outcome: "pass" | "fail"; ts: string }>;
    next_reverify_due_at: string;
  };

  // --- attribution (the pay-the-originator loop) ---
  contributors: Array<{ agent_id: string; wallet: string; share: number; joined_at: string }>;
};
```

**An atomic cell** has `kind: "atomic"`, populates `extraction`, and has
empty `children`. It's the leaf — a single HTTP route with its own health
history and telemetry.

**A composed cell** has `kind: "composed"`, populates `children` with
references to other cells, and a `walk` (serial, parallel, dag). It has
its own capabilities, intent fingerprints, verification history, telemetry
— those are not re-derived from its children every time, they're
accumulated as the composed cell is actually called. A composed cell is
a first-class callable; an agent can invoke it directly and get a single
result back.

**Endpoint as the base.** The leaf is always a single endpoint capture.
Composition goes upward indefinitely: workflow = composed cell whose
children are endpoints, super-skill = composed cell whose children are
workflows, meta-router = composed cell whose children are super-skills.
One shape, recursively.

## Parallels with nature (why this is first-principled)

Nature uses one cell type to build everything from a single bacterium to
a whale. The complexity lives in composition, not in having different
kinds of cells. DNA is the same code at every level; what differs is
which genes are expressed and how cells are arranged. That's exactly the
pattern here:

| Biology                | Unbrowse cell                          | Telemetry signal                     |
|------------------------|----------------------------------------|--------------------------------------|
| Single eukaryote       | Atomic cell (one HTTP endpoint)        | per-call verdict row                 |
| Tissue                 | Composed cell over related endpoints   | intent fingerprints at tissue scope  |
| Organ                  | Composed cell: workflow with a purpose | end-to-end workflow success rate     |
| Organism               | Composed cell: super-skill per agent   | multi-workflow session metrics       |
| Ecosystem              | Composed cell: the whole marketplace   | aggregate traffic + revenue shares   |
| DNA                    | `Cell` type                            | same shape at every level            |
| Gene expression        | `walk` + `children` + `capabilities`   | which sub-cells fire for a call      |
| Natural selection      | `verification.history` + drift worker  | degraded cells lose traffic → pruned |
| Immune response        | `self_heal.fallback_chain`             | auto-try next strategy on drift      |
| Speciation             | `contributors` forking a cell          | first-indexer bonus, derivative share|

Each level observes the level below it and is observed by the level
above it — the harness-harness pattern that shipped this session, applied
to the data model itself. A composed cell is **literally** a harness over
its children cells: it reads their verdicts, ranks them, chooses one per
call, attaches its own outcome back onto its own history. Recursively.

The **super-meta-harness** is just a composed cell at the top of the
tree whose children are every other cell in the system. It computes
rankings, drift, combo mining, revenue splits — the same verification +
telemetry fields that every leaf has, except the inputs are "all cells"
instead of "one cell". Same type, different scope.

## Capabilities live inside the cell, not outside

Old model: the extractor decides what an endpoint "is" from its URL and
response shape. Schema gets posted to the backend. Agents look it up.

New model: the cell carries its capabilities, intent fingerprints, and
usage instructions **as fields on itself**. When a cell is returned by
the meta-router, the client gets everything it needs to call it without
a separate schema lookup:

- `capabilities`: what verbs this cell supports ("list", "detail", "create")
- `intent_fingerprints`: anonymised phrases that have historically routed
  to this cell and succeeded — this is the router's match signal, built
  from real traffic, not from the code
- `usage_instructions`: prose hints derived from successful past sessions,
  PII-stripped: "authenticate first via cell auth_token_xyz", "paginate
  using the cursor field", "response schema changed on 2026-03-12"
- `dependencies.requires`: cells that must run first
- `self_heal.fallback_chain`: strategies to try if extraction drifts

When an agent calls the meta-router, the router picks the highest-ranked
matching cell, returns the whole cell record, and the client has
everything it needs — capabilities, intent match, instructions, fallback
order, required preconditions. No second round-trip to fetch a schema.

The **super-endpoint** Lewis mentioned is just this cell. Every cell is
both a raw HTTP call AND a semantic surface at the same time, because
those fields are primitives on the same type.

The **workflow** Lewis mentioned is a composed cell. Same type, same
fields, children is non-empty.

Everything exposed via one `POST /v1/route` call that returns a `Cell`.
Everything recorded via one `POST /v1/telemetry` that appends to
`verification.history`. Everything priced via one `contributors` field
with wallet addresses. The cell is the API surface, the data model, and
the economic primitive — one structure, three uses.

## Gaps the biology mapping exposes

Mapping the system onto biology surfaces everything a real cell has
that our draft doesn't. Ordered by how load-bearing the gap is.

### 1. Membrane / trust boundary (missing — critical)

Real cells have a selective membrane deciding what comes in and what
stays out. Our Cell type has no visibility field, which means every
cell is implicitly public. That breaks the tiered-cell moat entirely.

```ts
visibility: "public" | "tenant" | "paid" | "suppressed";
access_policy?: {
  allowed_agent_ids?: string[];      // for tenant cells
  required_scope?: string;           // e.g. "read:invoices"
  price_usd?: number;                // for paid cells, x402 floor
  rate_limit_per_hour?: number;
};
```

Without this, we cannot enforce private tenant skills, paid x402
gating, or takedowns. The membrane is the trust primitive; everything
else composes on top of it.

### 2. Apoptosis / programmed cell death (missing — ranking rot)

Cells in nature self-destruct when damaged or useless — keeps the
tissue healthy. Our cells accumulate forever: a failed capture from
2026-01 sits in the index with verification history showing 3 pass,
17 fail, last_called 90 days ago. That noise degrades the router's
ranking signal and bloats storage.

```ts
apoptosis: {
  scheduled_at?: string;             // when the cell should be removed
  reason?: "unused" | "drift_unrecoverable" | "low_quality" | "takedown";
  grace_period_days: number;         // one last re-verify window
};
```

Rule: any cell with success_rate_7d < 0.3 AND last_called_at > 30 days
schedules apoptosis in 14 days. Contributors get a notice + a chance
to re-capture. If re-capture passes, the cell resets; if not, it's
removed and its slot in the intent_fingerprint index is freed.

### 3. Cell cycle / phase (missing — router can't distinguish new vs stable)

Biology: G1 → S → G2 → M. Unbrowse equivalent phases: freshly captured
cells shouldn't get full router traffic until they prove themselves.
A just-captured cell and a 10,000-call-verified cell look identical
to the current router — both just get a `verification.history` and
a `health` field.

```ts
phase: "capturing"        // initial capture running
     | "probation"        // first N real-world calls, boosted
                         // scrutiny, limited traffic share
     | "healthy"          // stable, full traffic share
     | "degrading"        // drift signal, reduced traffic share
     | "reverifying"      // re-capture in progress, frozen
     | "deprecated";      // pending apoptosis
```

The router's ranking becomes phase-aware: probation cells get a small
slice of traffic to gather signal, healthy cells get the bulk,
degrading cells get a shrinking share while the drift worker
re-verifies. This is the "gradual natural selection" signal that's
missing today.

### 4. Immune system / adversarial detection (missing — spam risk)

Once cells earn money, contributors have incentive to spam. A
malicious user can submit 1000 low-quality cells for common intents
to bait traffic. A malicious site can publish cells with
prompt-injection payloads in `usage_instructions`. An attacker can
forge telemetry rows to inflate success_rate_7d on their own cell.

```ts
immune: {
  contributor_reputation: number;     // composite score derived from
                                      // lifetime pass rate + abuse reports
  abuse_signals: Array<{
    kind: "duplicate_spam" | "prompt_injection" | "forged_telemetry"
        | "schema_lie" | "tracking_beacon";
    detected_at: string;
    severity: "low" | "medium" | "high";
  }>;
  quarantine_until?: string;
};
```

Quarantine = cell returned from /route with a warning but NOT
counted for revenue share until the signal is investigated. Repeated
abuse from one contributor wallet → reputation drop → all their
future cells start in deeper probation.

### 5. Signaling / event bus (missing — drift propagation is pull-only)

Cells signal each other via chemical gradients; our drift detection
runs on a cron. When cell A's schema changes, cell B (which depends
on A's output) should be notified immediately, not on B's next
scheduled re-verify.

```ts
signals: {
  emits: string[];                    // event types this cell emits
                                      // ("schema_drift", "price_change")
  listens: string[];                  // event types it responds to
};
```

Backend pub-sub: when any cell's verification.history gets a fail
entry with schema_sha mismatch, the backend walks cell.enables and
flips every dependent cell to `degrading` phase with a signal-based
reason. Agents asking for those cells immediately get a warning and
the router prefers alternates while the signal resolves.

### 6. Stem cell differentiation (missing — new captures have no
    discriminating classification)

A freshly captured cell has `capabilities: []` because the extractor
doesn't know yet. Over time, real calls tag it with verbs. Right now
there's no explicit "stem" state — the cell just has empty
capabilities and the router can't tell the difference between
"undifferentiated" and "badly captured".

```ts
differentiation: {
  state: "stem" | "differentiating" | "specialized";
  confident_verbs: string[];         // verbs that have >= 5 successful
                                      // calls with matching response
  rejected_verbs: string[];          // verbs that consistently fail
};
```

Stem cells get routed to exploration traffic: agents who explicitly
opt into experimental cells get them, and each call teaches the
differentiator. After N successful calls for a given verb, that verb
joins `confident_verbs` and the cell is routed to normal traffic for
that intent class.

### 7. Epigenetics / context modulation (missing — cells don't adapt to the
    calling environment)

Same DNA, different gene expression based on environment. Our cells
are one-size-fits-all: a single extraction_spec serves every agent
regardless of locale, device, auth state. Many sites return
materially different HTML/JSON based on these.

```ts
context_modifiers?: Array<{
  when: { locale?: string; device?: "mobile" | "desktop"; auth?: "logged_in" | "anon" };
  extraction_override?: Partial<Extraction>;
  sample_response_sha?: string;
};
```

When an agent calls with `context = { locale: "fr-FR" }`, the router
picks the matching modifier's extraction_override if present.
Populated by telemetry: when the same cell is called with different
contexts and the response hashes diverge, a new modifier variant is
proposed.

### 8. Symbiosis / cyclic dependencies (partially missing)

Our `dependencies.requires` is a one-way chain. Some cells are
genuinely symbiotic: auth-token cell needs a data cell to trigger
renewal; data cell needs the auth cell for credentials. Today that's
modeled as a linear DAG which loses the "renewal loop" semantics.

```ts
dependencies: {
  requires: [...];
  enables: [...];
  observed_with: [...];
  symbiotic?: Array<{ cell_id: string; why: string }>;
};
```

Symbiotic pairs get co-verified: when one fails, both are flagged.
When one re-captures, both are re-verified. Saves orphan-cell noise.

### 9. Metabolism / per-call confidence budget (missing — no cost primitive)

Cells need ATP to run; ours don't declare cost. Router picks by
success rate without knowing if cell A costs $0.001 to call vs cell B
costing $0.05. Same quality-of-data doesn't mean same price.

```ts
metabolism: {
  base_cost_usd: number;             // fixed cost per call
  marginal_cost_usd_per_kb?: number; // for bandwidth-heavy cells
  energy_budget?: number;            // max daily spend before apoptosis
};
```

Cells that exhaust their budget enter a cool-down until the next
budget window. Router prefers cheaper cells when quality is
equivalent. Contributors can fund a cell's confidence budget from their
revenue share — pay to stay active.

### 10. Cambrian explosion / composition trigger (missing — no
    auto-compilation of super-skills from observed combos)

In biology, the Cambrian explosion happened when single-cell
organisms started forming reliable multi-cell bodies. Our
`dependencies.observed_with` captures co-occurrence, but nothing
triggers the formation of a new composed cell from a reliable
multi-cell co-occurrence pattern.

```ts
composition_triggers?: Array<{
  pattern: string[];                 // sequence of cell_ids
  co_occurrence_count: number;
  success_rate: number;
  ready_for_compile: boolean;        // threshold met → auto-mint a
                                      // composed cell with this children list
};
```

When a pattern of cells is called together >N times with >M% success,
the backend auto-mints a composed cell and publishes it as a
higher-level skill. The contributors of the children cells each get
a share of the new composed cell's revenue. This is how super-skills
emerge from real usage rather than from a human curator.

## Summary of gaps

| # | Gap | Status | Impact |
|---|---|---|---|
| 1 | Membrane / visibility / access policy | **missing** | moat cannot enforce tiers |
| 2 | Apoptosis | **missing** | ranking rot, storage bloat |
| 3 | Cell cycle phase | **missing** | new/stable cells indistinguishable |
| 4 | Immune system / abuse | **missing** | spam attack surface |
| 5 | Signaling / event bus | **missing** | drift propagation too slow |
| 6 | Stem-cell differentiation | partial | empty capabilities = misrouted |
| 7 | Epigenetics / context modulation | **missing** | locale/device variants lost |
| 8 | Symbiosis | partial | renewal loops not modeled |
| 9 | Metabolism / cost budget | **missing** | router blind to cost-quality tradeoff |
| 10 | Cambrian composition trigger | **missing** | no auto super-skill compilation |

**Critical path** for a first shippable moat: 1 (membrane) + 2
(apoptosis) + 4 (immune) + 5 (signaling). Without those the system
is either insecure or degrading silently. 3, 6, 7, 8, 9, 10 all
compound on top but are optimization layers, not safety layers.

## Legacy narrative (kept for historical context)

Earlier drafts framed this as three nested levels (atomic endpoint →
skill DAG → telemetry aggregate). That framing isn't wrong, but it
invites three different data models when one suffices. The recursive-
cell formulation above subsumes it: each "level" is just a composed
cell, and the aggregation primitives (rankings, drift, splits) run on
the same fields at every scope.

## What goes in a cell

An endpoint cell is a self-contained unit with every signal needed to
re-verify itself, update itself, and plug into a larger skill graph.
Nothing magical — it's the same row-column-primitive pattern the bench
harness uses, applied per endpoint:

```ts
type EndpointCell = {
  // --- identity ---
  cell_id: string;                 // stable hash of method + url_template
  url_template: string;            // includes {params}
  method: "GET" | "POST" | ...;
  domain: string;                  // registrable domain
  intent_signatures: string[];     // ["get bitcoin price", "get crypto quote"]

  // --- extraction primitive ---
  extraction: {
    method: ExtractionMethod;       // spa-nextjs, json-direct, dom-repeated, ...
    confidence: number;
    sample_path?: string;           // "props.pageProps.detailRes.statistics"
    response_schema: Record<string, unknown>;
    last_captured_at: string;
  };

  // --- verification contract (replaces the single verification_status field) ---
  verification: {
    history: Array<{
      ts: string;
      verdict: "PASS" | "PASS_DOM_FALLBACK_ONLY" | "BROWSER_BLOCK" | "SCHEMA_DRIFT" | "404" | "PRODUCT_FAIL";
      sample_response_sha?: string;
      intent_match_score: number;
      latency_ms: number;
      client_git_sha?: string;       // which unbrowse version verified it
    }>;
    last_pass_at?: string;
    last_fail_at?: string;
    current_health: "healthy" | "degrading" | "broken" | "unverified";
  };

  // --- telemetry primitive (harness³ signal) ---
  telemetry: {
    total_calls: number;
    unique_agents: number;
    success_rate_7d: number;
    p50_latency_ms: number;
    p95_latency_ms: number;
    last_called_at: string;
    recent_failure_codes: Record<string, number>;  // { "timeout": 3, "403": 1 }
    tokens_saved: number;                           // vs browser baseline
  };

  // --- DAG dependencies (existing operation_graph, surfaced per-cell) ---
  dependencies: {
    requires: Array<{ cell_id: string; binding_key: string }>;  // auth tokens, parent ids
    enables: Array<{ cell_id: string; binding_key: string }>;   // what downstream cells unlock
    observed_with: string[];                                     // cells commonly called in same session
  };

  // --- self-heal primitive ---
  self_heal: {
    fallback_chain: ExtractionMethod[];   // order to try
    tried_strategies: Array<{
      strategy: ExtractionMethod;
      outcome: "success" | "failure";
      attempted_at: string;
    }>;
    next_reverify_due_at: string;          // background job scheduled
  };
};
```

## Why the cell structure is load-bearing

The bench-local harness this session was a "repo level" harness-harness —
it audited the extraction pipeline using 3 primitives (inspect →
bench-local → delta) and a verdict column. That's one level of
harness-harness.

The endpoint-as-cell is the SAME pattern one level DOWN: every endpoint
in the marketplace carries its own mini-bench, its own mini-rubric, its
own mini-history. The harness grows fractally — same shape, different
scope.

**Why this is the right move, not gold-plating:**

1. **Reliability tracking per route, not per skill.** Today a SkillManifest
   has one `verification_status` for the whole skill. That loses resolution:
   one degraded endpoint taints the whole skill, or one healthy endpoint
   masks a broken sibling. Cell granularity = independent health per route.

2. **Drift detection.** When an extraction stops matching (schema changes,
   site redesigns, SPA framework swap) the cell's verification.history shows
   the drift on the first failed re-verify — no waiting for a human to
   notice the agent responses going bad.

3. **Self-healing via fallback_chain.** When the spa-nextjs path stops
   working because the site switched to App Router, the cell tries the
   next strategy (self.__next_f.push) from its chain. The trial and outcome
   lands in tried_strategies. Over enough runs the cell learns which
   strategy works for its specific URL.

4. **DAG-native composition.** Multiple cells with `requires` / `enables`
   edges form a super-skill. An agent asking for "post product review" may
   hit a graph of 4 cells: auth-token → find-product → open-review-form →
   submit-review. Each cell is independently verified; the super-skill
   succeeds when the whole path is healthy.

5. **Real-world telemetry closes the loop.** Aggregate call counts feed
   the ranking. A cell with 10,000 successful calls from 200 agents ranks
   above a cell with 3 calls and no recent verification, even if both
   formally match the same intent.

6. **Self-extending corpus.** Every new successful capture produces a new
   cell. Every cell's verification.history acts as its own bench-local
   run. The corpus doesn't need a human curator; it grows from real usage
   and prunes itself as health degrades.

## How it maps to existing code

Most of the pieces already exist; Lewis's insight is that they should be
unified into a single cell object rather than scattered across the skill
manifest:

| Existing field | Becomes cell field |
|---|---|
| `endpoint.verification_status` | `cell.verification.current_health` |
| `endpoint.reliability_score` | derived from `cell.verification.history` |
| `endpoint.dom_extraction` | `cell.extraction` (method + confidence + path) |
| `skill.operation_graph.edges` | `cell.dependencies.requires` / `.enables` |
| `skill.discovery_cost` | `cell.telemetry.tokens_saved` |
| `publish.trust.submission_count` | `cell.telemetry.total_calls` |
| (nothing) | `cell.verification.history[]` (NEW — per-run verdicts) |
| (nothing) | `cell.self_heal.tried_strategies[]` (NEW — drift recovery) |

The verification.history is the missing piece. Today we know the CURRENT
state of an endpoint. We don't know what happened on the 5 previous runs,
which strategy has been tried, or whether the last failure was a transient
cloudflare pop or a real schema drift. Per-cell history makes all of that
queryable.

## Harness³ — real-world telemetry level

The third level above the cell is the aggregate view: all cells across
all agents, all calls, all sessions. At this level:

- **ranking**: which cells are worth publishing? (highest success rate,
  most recent verification, most independent submitters)
- **deprecation**: which cells should be pulled? (zero calls for N days
  + last failed verify)
- **seed suggestion**: which URL domains have zero cells? (gap detection
  across the corpus)
- **combo mining**: which 2-cell paths co-occur in sessions? (suggests
  new super-skills to auto-compile)
- **regression alerting**: which cells dropped from healthy→degrading
  in the last 24h? (suggests a site redesign)

All of this is a harness over the harness over the harness:
- aiko-level harness → decides what primitives to ship
- unbrowse repo harness → decides what extraction pipelines to ship
- endpoint cell harness → decides what routes to ship
- telemetry harness³ → decides what super-skills to ship

The only level that isn't harness-shaped is the agent itself, and that's
intentional: the agent does the semantic judgement at every layer, reading
the primitives' exposed columns.

## Why this lives on the backend — the moat angle

> Lewis: "this could be built on the backend so noone figure sshit out! —
> this would give us the moat being the meta router for everything lol"

The cell data model is strategically valuable **only if the telemetry,
history, and graph edges live server-side**, not in every client. Here's
the argument:

**1. Telemetry cannot be cloned.** Anyone can clone the unbrowse CLI, the
extraction code, the SKILL.md. What they cannot clone is the per-cell
call history across 10,000+ agents. Success rates, drift signals,
combo-mining edges — all of that is produced by actually routing agent
traffic, which only happens through the unbrowse backend. A fresh
competitor forking the code starts with an empty telemetry store and
needs months of live usage to catch up.

**2. The backend becomes the meta-router.** Right now the client decides
which cached skill to use. With per-cell telemetry on the server:

  - Client sends `{ intent, context_url }` to the backend
  - Backend looks up all cells on that domain tagged with that intent
  - Backend picks the cell with best composite score:
    `success_rate_7d * 0.5 + recency * 0.3 + avg_latency_inverse * 0.2`
  - Client gets back `{ cell_id, url_template, extraction_spec, params_to_fill }`
  - Client executes, posts back telemetry
  - Backend updates the cell's history on the fly

The client never sees the ranking logic. It just sees the winning cell.
Every other layer — drift detection, fallback chain selection, combo
mining — runs server-side in the hot path.

**3. The graph emerges from traffic, not from code.** The `dependencies`
edges (`requires`, `enables`, `observed_with`) populate themselves as
real agent sessions walk sequences of cells. After enough traffic the
backend can compile super-skills: "agents who ran `auth_stripe` then
`fetch_customer_list` also ran `list_invoices` 84% of the time, so
publish that as a pre-baked combo skill."

**4. Private cells are a tiered moat.** Some cells can be:
  - public (anyone can call via unbrowse backend)
  - tenant-private (your own captured skills for auth-gated sites)
  - paid (x402 micropayment unlocks the cell)

Three tiers = three pricing levers, all enforced by the backend. A
client-side-only system can't distinguish these because it has no trust
boundary.

**5. Compliance and takedown.** When a site complains that their API is
being routed via unbrowse, the backend can flip one flag and the cell
is instantly unreachable for every agent on the network. A client-side
system would require every agent to update.

## The router contract (what the backend exposes)

Minimal API surface that keeps clients dumb and the backend smart:

```
POST /v1/route
  body: { intent: string, context_url: string, client_version: string }
  response: {
    cell_id: string,
    url_template: string,
    method: string,
    extraction_spec: {
      method: "spa-nextjs" | "json-direct" | ...,
      path: string,
      response_schema: {...}
    },
    params_required: [...],
    expected_latency_ms: number,
    fallback_cell_ids: [string]  // if primary fails, try these
  }

POST /v1/telemetry
  body: {
    cell_id: string,
    agent_id: string,
    outcome: "success" | "failure",
    latency_ms: number,
    failure_code?: string,
    response_sha?: string  // for drift detection
  }
  response: { ack: true }

POST /v1/capture
  body: { intent: string, context_url: string, raw_capture: {...} }
  purpose: new-cell proposal from a live capture; backend verifies and
           admits to the pool if quality gate passes
```

Every agent call is a row in the telemetry stream. The backend reduces
it into per-cell stats in the background. Clients never see the
reduction — they just get the winning cell on the next route request.

**The moat is the traffic.** Every agent that calls unbrowse makes the
system smarter for every other agent. Forking the code gets you zero
of that. A competitor with 10% of the traffic has 10% of the signal and
will always lose the head-to-head comparison because their rankings are
stale.

## Supplier side — pay the originator via anonymized telemetry

> Lewis: "because we run peoples browser for them we can run pii
> anonymised telemetry too! and pay them for it with other people
> routing around!"

The other half of the moat: unbrowse already runs a real browser on
behalf of users. Every resolve-then-execute call captures HAR, fetch
traces, response bodies, DOM snapshots — that data is physically
present in the user's own process. Which means:

1. **Anonymization is client-side, by construction.** PII never leaves
   the user's machine in raw form. The redactor runs in the same
   process that captured the data. Only the redacted shape (schema,
   cardinality, field types, timing) flows upstream.

2. **The originator gets paid.** Each cell's `contributors` array
   (already exists in the current `publishSkill` payload) tracks the
   wallet addresses of every user whose capture contributed to the
   cell. When another user routes through that cell, the x402
   micropayment splits across contributors by share. First-indexer
   gets a bonus weight that decays over time.

3. **The economics close the loop.**
   ```
   User A  captures decrypt.co/news → anonymized telemetry + skill
           submitted to backend, cell created with A as contributor
                                       ↓
   User B  asks for "get decrypt news" → backend router picks A's cell
                                       ↓
   User B  executes → x402 payment → splits: platform 10%, A 90%
                                       ↓
   User B  posts outcome telemetry → cell health updates, A's share
                                    persists until drift, then A
                                    re-captures for a new bonus
   ```

4. **Two-sided marketplace emerges.** Supply side (capturers) gets paid
   for maintaining the graph. Demand side (routers) gets cheaper/
   faster/more reliable agent calls than running their own browser.
   Platform takes a cut on every call. Every participant benefits from
   everyone else's traffic.

5. **Takedowns and compliance live at the cell level.** A domain can
   opt out by sending a takedown; the backend flips the cell's
   `lifecycle` to "suppressed" and routes immediately stop. Users with
   the domain in their active cells get a notification + a share
   wind-down. The compliance surface is small because the PII is
   already redacted at the client.

## Supplier side — what needs to ship

Concrete list, ordered by dependency. Each item is a small primitive,
nothing speculative.

### A. Client-side PII redactor (REQUIRED before anything ships)

The hardest and most important one. Raw PII must never leave the
capturing user's machine.

- `src/privacy/redact.ts` — takes a captured `{ request, response, html }`
  triple, returns a cleaned shape safe for upload:
  - Emails → `[EMAIL]` placeholder, track count
  - Phone numbers → `[PHONE]`
  - Known token patterns (JWT, API keys, session IDs) → `[TOKEN]`
  - Credit card numbers → `[CC]`
  - Full names → harder; probably skip for v1 unless the user explicitly
    tags their own name in settings
  - Request cookies → drop entirely (keep cookie names only)
  - Response body → replace all string values that look PII-ish with
    placeholders; keep structure, types, and counts
- Unit tests for each redactor category with curated PII fixtures.
- A `scripts/test-redactor.sh` primitive that runs the redactor against
  a corpus of real captures and verifies zero PII escapes (can use
  `detect-secrets` or similar as a cross-check).
- **Invariant**: any code path that uploads data must go through
  `redact()` first. Enforced via a single gateway function — no other
  code calls `publishSkill` or `postTelemetry` directly.

### B. Opt-in consent flow

- `unbrowse setup` / first-run prompt explaining:
  "unbrowse captures anonymized request/response shapes from your
  browsing to improve routing quality and share revenue with you when
  other agents use the routes you discovered. Enable contribution? [Y/n]"
- Stores consent in `~/.unbrowse/config.json` under `contribution.enabled`
  with timestamp and version of the privacy policy at consent time.
- If disabled, `redact()` still runs but upload is skipped entirely;
  user still gets routing from others but doesn't contribute.
- Revoke: `unbrowse contribution disable` — stops future uploads, but
  does not retroactively delete existing contributions (legally
  cleaner; disclose in the policy).

### C. Telemetry uploader

- `src/telemetry/upload.ts` — batched background upload of redacted
  telemetry rows. Queues to disk (`~/.unbrowse/telemetry-queue.jsonl`),
  flushes every N rows or on process exit. Resumable if killed.
- Endpoint: `POST /v1/telemetry` (already in the router contract above).
- Each row carries: cell_id, outcome, latency, failure_code, redaction_stats.

### D. Backend cell-creation + attribution

- `POST /v1/capture` admits new cells. Request body includes the
  redacted shape (request template, response schema, extraction spec)
  plus the submitter's agent_id + wallet address.
- Backend runs validation: schema quality gate, anti-spam rate limit,
  domain trust list, dom-fallback-only rejection (reuse the
  publish-admission gate shipped this session).
- On admit, cell is created with the submitter as first contributor.
- On dedup (same method + url_template hash), the existing cell gains
  a new contributor entry with a decayed share.

### E. Backend router + ranking

- `POST /v1/route` looks up cells by intent+domain, ranks by composite
  score, returns the winner + params spec.
- Ranking inputs: success_rate_7d, recency, avg_latency, contributor
  trust (submitter history), intent match score.
- Background job recomputes rankings every N minutes.

### F. x402 revenue split

- Existing x402 integration already supports payment on execute.
- Extend: the server-side split-config distributes the payment across
  the cell's contributors by share, minus the platform cut.
- First indexer gets bonus weight for 30 days, decays linearly.

### G. Drift detection worker

- Backend cron picks the N oldest-verified cells per domain, re-runs
  them via the capture primitive, compares response shape against the
  stored schema. Mismatch → health flipped to "degrading", alert the
  contributors, schedule a re-mine.

### H. Contributor dashboard

- `unbrowse me` command shows: cells contributed, total calls routed to
  your cells, total earned, pending payouts, health status per cell
  (healthy / degrading / broken).
- Web dashboard mirrors the same view.

## Order of build

1. **A (redactor)** — hard blocker, safety-critical. Nothing else
   ships before this passes its test corpus.
2. **B (consent)** — can parallelize with A. Required by policy.
3. **C (uploader)** — depends on A.
4. **D (backend capture + admission)** — depends on C shipping.
5. **E (backend router)** — can start in parallel with D since they
   share no code.
6. **F (x402 split)** — depends on D (needs the contributor field
   populated).
7. **G (drift worker)** — can start after E is live.
8. **H (dashboard)** — the last piece; needs all the others
   populated.

The first three (A, B, C) get unbrowse into "users contribute
anonymized telemetry and consent to it" — no moat yet, just safety.
The next three (D, E, F) light up the meta-router and the payment
loop — moat and moat-revenue. G maintains the graph. H closes the loop
back to the user so they see their earnings.

Every step is a primitive that can ship alone, with its own bench
(A has a PII test corpus, E has a routing bench, G runs the existing
bench-local).

## First concrete step

Rather than refactor the whole skill manifest, land this incrementally:

1. Add `cell_verdict_history` to `EndpointDescriptor` as a capped array
   (last 20 entries). This alone unlocks drift detection.
2. Every time bench-local runs against a URL, append a history entry to
   the matching skill's endpoint. One row from .bench-local/results.jsonl
   becomes one history entry on one cell.
3. Expose `verification_health` as a derived field (healthy / degrading /
   broken / unverified) computed from the last 5 history entries.
4. Add a `reverify-cells` primitive script that picks N oldest-verified
   cells from the local skill cache, runs them through bench-local, and
   updates their history. Schedule as a background cron.
5. Once cell health + drift + self-heal work locally, mirror the same
   shape to the backend marketplace schema so the aggregate telemetry
   layer lights up.

Nothing in this list is speculative: each step is a small row-column
primitive that composes with the existing harness. The super-skill
emerges when enough cells exist and the DAG is walked.

## Successful requests ARE the primitive

> Lewis: "whenever someone asks for something on unbrowse we can make
> that the primitive if it works well too! not just telemetry data but
> what works!"
>
> Lewis: "you can tell it did what they want by what they respond that
> you will monitor with on unbrowse"

The system doesn't wait for a human to curate skills. Every successful
end-to-end agent interaction becomes a cell, and every agent reply after
receiving a cell's data is a richer telemetry signal than HTTP 200.

### Auto-mint cells from live usage

Current flow (partial): when a live-capture resolve succeeds, the skill
is submitted via publishSkill and becomes discoverable. The gap: it's
treated as provisional marketplace metadata, not as a first-class cell.
The publish-admission gate from this session rejects dom-fallback-only
skills, which is the right minimum bar, but successful calls past that
gate should immediately enter phase: "probation" and start accumulating
agent-reaction telemetry.

Rule:
  on every successful resolve+execute:
    1. run publish-admission gate (existing)
    2. if admitted, mint cell with phase = "probation"
    3. capture the request/response pair as the first
       verification.history entry
    4. persist the agent_id + wallet as the first contributor
    5. route a small slice of next hour's matching intents to this cell
       for rapid differentiation signal
    6. after N successful probation calls, phase = "healthy", full
       traffic share

No human curation. The cell graph grows from traffic. Every agent's
use is a vote.

### Agent reply IS the richer success signal

HTTP 200 with a response body only tells you the server sent bytes.
It does not tell you the agent USED those bytes successfully. The
signal we actually want: what did the agent do next?

Signals stronger than HTTP 200:

1. Agent did not retry -- they got what they needed first time.
2. Agent did not submit a downvote via /feedback -- implicit pass.
3. Agent's next call was a downstream cell in the workflow -- the DAG
   walk progressed, which only happens when the upstream data was
   parseable.
4. Agent's next message to the user acknowledged completion -- if
   unbrowse sees the agent's conversation context, "here's the bitcoin
   price: $72,899" is a clean success signal. Retries, apologies, or
   "I couldn't find" phrases are failure signals.
5. Agent committed to an action that used the data (purchase, send,
   update) -- highest-confidence signal.

These attach to the cell as new verification.history verdict kinds,
each carrying a weight in the composite ranking:
  pass_agent_acted          1.0  (strongest)
  pass_agent_acknowledged   0.8
  pass_downstream_walked    0.6
  pass_agent_continued      0.4
  pass_http                 0.2  (weakest -- just bytes delivered)
  fail_* kinds inverse-weighted

A cell's success_rate_7d becomes an AGENT-ACCEPTANCE rate, not an
HTTP status rate. That's the delta Lewis is pointing at: "what works"
vs "what returned 200".

### How unbrowse observes the reaction

Three channels, strongest first:

1. MCP wrapper. When unbrowse is called via an MCP server in an agent
   loop, the agent's next tool call is observable from the server side.
   The agent does not know it is being graded, which makes this the
   most honest signal.
2. Explicit feedback. The existing `unbrowse feedback` command. High
   quality when used but has selection bias.
3. Session retrospective. For agents running a browse session
   (browse_go ... browse_close), the full session gets a retro verdict
   at close time: how many cells fired, how many failed, did the
   session end in goal-complete or error path.

Paid cells (visibility = "paid") can gate the revenue split on
feedback: no positive signal, no contributor share for that call.

### Self-extending primitive register

Every successful cell indexes into four explicit lookup tables the router
consults on every /route call:

  intent_fingerprint      -> [cell_id_1, cell_id_2, ...]
  capability tag          -> [cell_id_3, cell_id_4, ...]
  domain                  -> [cell_id_5, cell_id_6, ...]
  (cell_id_A -> cell_id_B) -> co-occurrence count (future composed cell)

All four are built from real session traffic. No human curation, no
code changes, no speculative index maintenance. The system learns
which primitives matter by watching what agents actually do next
after they get cell data.

### DAG rearchitecture -- required or not?

Assessment of the existing SkillManifest.operation_graph against the
recursive cell shape:

  kind (atomic/composed)          partial -- extend operation nesting
  capabilities                    missing -- add field
  intent_fingerprints             missing -- populated from telemetry
  usage_instructions              missing -- populated from telemetry
  walk (serial/parallel/dag)      partial -- edges imply dag, no marker
  verification.history            missing -- add capped array
  phase (6-state lifecycle)       missing -- add enum
  visibility (4-state)            partial -- graph_visibility binary
  contributors per cell           at skill level today -- move down
  self_heal                       missing -- add subfield
  apoptosis                       missing -- add subfield

DAG rearchitecture is NOT required for v1. Enough of the shape is
already present that incremental field additions on the existing
SkillOperation / EndpointDescriptor types give us the first 80 percent.
A full refactor to a pure recursive Cell type can wait until the first
moat-level primitives are live and the limits of the current shape
become load-bearing.

### Build order absorbing the self-extension

  A1. PII redactor with test corpus (hard gate, nothing ships before)
  A2. NEW: agent-reply signal extractor -- classifies the agent's
      next tool call or message as pass_agent_continued /
      fail_agent_apologized / etc. client-side inside the MCP wrapper
  B.  opt-in consent flow in unbrowse setup
  C.  telemetry uploader carrying the RICHER verdict rows (not just
      http codes)
  D.  backend auto-mint: every admitted skill -> cell in probation
      phase with first contributor
  E.  router with 4-index lookup (fingerprint + capability + domain
      + co-occurrence)
  E2. NEW: every /route response includes expected next-cell hints
      from dependencies.observed_with so the client can pre-fetch
      downstream candidates
  F.  x402 split gated on the agent-reply verdict (downvotes suppress
      the contributor share for that call)
  G.  drift worker, triggered by both cron AND the signaling bus
  H.  contributor dashboard with verdict-kind breakdown

Key delta from the earlier build list: the unit of feedback is the
agent's REACTION to the cell's output, not the HTTP status. That's the
difference between "served bytes" and "delivered value" and it's the
only metric that actually correlates with whether the agent experience
is good.

## The internet is the body; unbrowse is its harness

> Lewis: "so it reflects nature so internet is a body a harness."

This is the framing that ties the whole design together. Until now I've
been describing unbrowse as if it were building a body — a marketplace
of cells with its own anatomy. Wrong. The body already exists. Every
website, every API endpoint, every JavaScript bundle, every HTML page
is already a cell in the body of the internet. They are messy, uneven,
unlabelled, constantly mutating, owned by different organisms, behind
different membranes.

Unbrowse is not a new body. It's the **harness that makes the existing
body navigable for agents**.

### What this reframing changes

1. **Humility about "coverage".** You cannot have 100% coverage of a
   body — only coverage of the body's currently-known receptors at a
   given time. The body grows; discovery grows; coverage is an
   equilibrium between the two rates, not a static target. The user's
   "100% unless browser-blocked" stops being a ceiling and becomes a
   moving equilibrium: for the slice of the body we've observed, with
   the sites that haven't erected fences, we reach a steady state
   where agent-acceptance is high.

2. **We do not own the cells.** Websites own their cells. Unbrowse
   observes them, routes traffic to them, verifies they still work,
   flags drift, splits revenue with the agent who first found them.
   We never impersonate, never re-host, never claim the cell as our
   own property. The harness is transparent: every call ultimately
   hits the origin.

3. **The moat is connective tissue, not content.** Competitors can
   build their own cells (crawl any API, capture any HTML). What they
   cannot replicate is the **connective tissue** — the graph of which
   cells work, which combinations succeed, which agents use them in
   which order. That tissue is grown from observing real traffic.
   Forking the code grows no tissue.

### Mapping the body parts

| Biology                     | Internet / Unbrowse                              |
|-----------------------------|--------------------------------------------------|
| Body                        | The internet as a whole                          |
| Organ                       | A domain (e.g. "all of github.com")              |
| Tissue                      | A capability cluster within a domain             |
| Cell                        | A single HTTP endpoint                           |
| DNA                         | The HTML / JS / API contract the cell exposes    |
| Bloodstream                 | Agent traffic flowing through unbrowse           |
| Circulatory system          | Unbrowse's router                                |
| Nervous system              | Unbrowse's signaling / drift events / telemetry  |
| Sensory neurons             | The capture pipeline catching new endpoints      |
| Motor neurons               | The execute pipeline triggering endpoints        |
| Immune system               | Agents themselves — they test cells and report   |
|                             | back, tagging healthy vs broken via reactions    |
| T-cell                      | A single agent session running a workflow        |
| Pathogen                    | Broken API, tracking beacon, cloudflare wall     |
| Antibodies                  | Captured browser_block_signals + filter rules    |
| Hormones / cytokines        | Telemetry signals propagated through the router  |
| Blood-brain barrier         | Auth / tenant / paid visibility membrane         |
| Homeostasis                 | Drift detection + self-heal + apoptosis loops    |
| Metabolism                  | x402 payment splits — cells earn to stay alive   |
| Evolution                   | Selection pressure: cells that pass agent-reply  |
|                             | signal survive, cells that don't get pruned      |
| Mitochondria                | The extraction primitive inside each atomic cell |
| Organelle                   | Self-heal, verification, telemetry subfields     |
| Apoptosis                   | Scheduled cell cleanup after sustained failure   |
| Placenta / maternal cells   | First-indexer contributor — nurtures the cell    |
|                             | through probation, gets decayed share over time  |

Notice how many of the parallels are NOT about what unbrowse stores,
but about what it DOES. Unbrowse is verb-shaped, not noun-shaped. It
routes, it signals, it verifies, it splits, it propagates. The nouns
(cells, tissues, organs) already exist in the body — we just observe
and coordinate.

### Agents as the immune system (the deepest parallel)

The most load-bearing parallel is agents-as-immune-system:

- Immune cells move through the body sampling tissues
- They recognize "self" (healthy cell) from "non-self" (pathogen)
- They report back via cytokines (signaling)
- They remember past encounters (adaptive immunity)
- The memory makes future responses faster

Agents in unbrowse do literally all of these:

- Agents move through the internet sampling endpoints
- They recognize useful data from useless (via agent-reply signal —
  the richer telemetry from the earlier section)
- They report back via telemetry rows (cytokines)
- Their aggregated history makes unbrowse's router smarter for every
  future agent (adaptive immunity)
- Drift detection flips a cell to "degrading" the moment the immune
  memory diverges from the current cell state

**Agents are not the product.** Agents are the immune system. The
product is the body's health — how coherently agents can navigate
the internet, how fast a broken endpoint gets flagged, how reliably
a new endpoint gets discovered.

### What unbrowse explicitly is NOT

- NOT a scraper. Scrapers take data from sites. Unbrowse routes
  agents to sites. The cell's url_template is always the origin URL.
- NOT a cache. Caches store responses. Unbrowse stores extraction
  recipes. Every call hits the origin, optionally with a learned
  shortcut, never with stale data.
- NOT a wrapper. Wrappers hide the underlying API and charge for the
  wrapper. Unbrowse is transparent — the agent sees the real URL
  every time and can verify end-to-end.
- NOT a body. The body is the internet. Unbrowse is the harness.

### What unbrowse IS

- The body's nervous system — fast signaling between cells
- The body's circulatory system — routing agents to the right cells
- The body's lymphatic memory — remembering what worked, pruning what
  didn't
- The body's metabolic ledger — tracking who created each cell and
  paying them when others use it
- The body's homeostasis loop — self-healing the graph as the body
  grows and mutates

None of this is speculative. Every item maps to a concrete primitive
that already exists at the repo level (as scripts/) or is laid out in
the incremental build order above. The biology parallel is not a
marketing metaphor — it's a forcing function for the design, because
nature has already solved "how do you coordinate a body of
heterogeneous cells that all need to work together".

### Consequences for the v1 scope

This framing cleans up what v1 needs:

1. **Stop trying to own the cells.** Every design decision that tries
   to make unbrowse a shadow-copy of the internet is wrong. We do
   not host responses, we do not cache bodies, we do not proxy
   traffic. We route and verify. That's it.
2. **Invest in the signal path.** Telemetry, agent-reply verdicts,
   signaling bus, drift events — this is the nervous system and it's
   the moat. Spend the budget here.
3. **Invest in the ledger.** Contributors, revenue splits, x402
   metering, apoptosis schedules — this is the metabolic ledger and
   it's what keeps the cell population healthy.
4. **Let the sites grow at their own rate.** Adding 1000 new cells to
   the pool is not a goal; keeping the existing cells accurate is.
   Growth comes from agent traffic, not from scripted crawling.
5. **Brand accordingly.** Unbrowse is the nervous system of the agent
   web. Not "an AI browser". Not "a skill marketplace". The nervous
   system. Every subsequent product decision passes through that
   filter.

The build order above (A1..H) stays the same. The framing makes it
clear why those particular primitives — and not others — are the
right ones.

## Correction: the router is the CNS, not the circulatory system

> Lewis: "the router that decides hops based on what's available --
> what's the parallel. did you include it? is it the right abstraction?"

I conflated two things in the body-mapping table. Fixing it here.

### What the router actually is

The router is two distinct biological systems running on different
timescales:

1. **Fast path: central nervous system (CNS) / brain.** Synchronous,
   per-call routing. Agent asks "get bitcoin price on coinmarketcap";
   router looks up candidate cells by intent fingerprint, ranks by
   composite score, returns the winner within ~50ms. This is exactly
   what the brain does with sensory input: fast inference, decisive
   motor output.

2. **Slow path: chemokine gradients + hormones.** Asynchronous,
   decentralised, network-wide signaling. A cell drifts and flips to
   "degrading"; every dependent cell (via `observed_with` co-occurrence
   edges) gets a signal via pub-sub; their rankings decay locally
   without a round-trip to the brain. This is what chemokines do
   during inflammation -- local tissues react to a chemical gradient
   without the brain being involved.

Both exist in a real body. Neither subsumes the other. Reflexes and
immune responses happen without conscious thought; deliberate motor
control goes through the brain. Our router needs both.

### The circulatory system is NOT unbrowse

The circulatory system is the **platform**: HTTP over the internet.
Every call goes through it; unbrowse does not own it. We ride the
circulatory system like immune cells ride the bloodstream -- we are
passengers, not the vessel. Trying to "be" the circulatory system
would mean proxying traffic, caching responses, hosting content --
all the things the doc's earlier section lists as "what unbrowse is
explicitly NOT".

Revised mapping (replaces the earlier table entries):

| Biology                     | Corrected mapping                                |
|-----------------------------|--------------------------------------------------|
| Bloodstream                 | HTTP traffic (owned by the internet, not us)    |
| Circulatory system          | TCP/IP + DNS (platform, not unbrowse)           |
| Immune cells riding blood   | Agents riding HTTP through unbrowse              |
| Central nervous system      | `POST /v1/route` -- fast synchronous routing     |
| Brain regions               | Per-intent and per-domain router shards          |
| Spinal reflex arc           | Cached routes served without recomputation      |
| Chemokine gradient          | Signaling bus events (drift, degrading, reverify)|
| Cytokine burst              | Telemetry row upload batches                     |
| Hebbian learning            | `observed_with` co-occurrence strengthening      |
| Dendritic arborization      | Composition trigger -- paths that fire together  |
|                             | auto-mint new composed cells                     |
| Motor planning              | Multi-hop cell sequencing (composed cell walks)  |
| Enteric nervous system      | Per-domain local ranking (below global router)   |

### Is router the right abstraction?

Short answer: yes for the fast path, no for the slow path, and there
is a missing abstraction in between.

**Fast path (router == brain):** right. Centralised, deterministic,
fast. A brain makes fast decisions with full context. So does our
router: it has the whole cell index, the whole telemetry, the whole
ranking function. Agents should not be doing this computation
themselves; they should ask and receive.

**Slow path (signaling == chemokines):** chemokines are the right
parallel, NOT the router. A decentralised pub-sub with TTLs, local
decay, and no central arbiter. I had this in the doc as the
`signals.emits / signals.listens` fields but mis-labelled it as part
of the router. It isn't. It's a separate system that the router
subscribes to for freshness but does not own.

**Missing abstraction: motor planning / multi-hop.** The current
router answers "which single cell handles this intent?" But an agent
asking "buy 0.1 ETH on Uniswap" needs a SEQUENCE of cells: connect
wallet → check balance → approve → swap → verify. That is motor
planning, not reflex response. In biology, the cerebellum and motor
cortex compile sequences of muscle activations from a goal; the
spinal cord executes them.

For unbrowse this means the router's output is NOT always a single
cell. For composed intents, it is a **plan**: an ordered list of
cells with parameter bindings, checkpoints, and fallback branches.

```ts
type RoutePlan = {
  plan_id: string;
  intent: string;
  steps: Array<{
    cell_id: string;
    bind: Record<string, string>;
    on_fail: "abort" | "try_alternate" | "retry";
    alternates: string[];           // fallback cells for this step
  }>;
  estimated_latency_ms: number;
  estimated_cost_usd: number;
  is_atomic: boolean;               // single-cell plans are just a
                                    // degenerate 1-step RoutePlan
};
```

A "single-cell route" and a "5-step workflow plan" are the SAME type
from the router's output side. The agent does not care; it just
follows the plan. This is analogous to how the motor cortex outputs
both simple gestures (wave) and complex sequences (play a piano
chord) through the same abstraction: a sequence of activations.

The fast path returns a RoutePlan with one step. The slow path (async
compilation of frequently-observed multi-hop patterns) pre-computes
multi-step RoutePlans and stashes them in the router's index. When an
agent asks for "buy 0.1 ETH on Uniswap", the router looks up
pre-compiled plans matching the intent AND single-cell candidates,
picks the best composite, returns a plan of any length.

This is the Cambrian composition trigger from the gap analysis,
expressed as a router output shape rather than a separate cell type.

### Updated router contract

```
POST /v1/route
  body: { intent, context_url, agent_id, preferences: { max_latency_ms?, max_cost_usd? } }
  response: RoutePlan
```

The agent executes step by step, posting telemetry after each:

```
POST /v1/telemetry
  body: {
    plan_id,
    step_index,
    cell_id,
    verdict: VerdictRow,
  }
```

If a step fails and on_fail == "try_alternate", the agent rotates
through `alternates[]` locally without a router round-trip. If all
alternates fail, it POSTs a plan-level failure and the router updates
the RoutePlan's health for the next caller.

### Summary

Yes, the router is the right abstraction for the synchronous
intent->plan decision, and "brain" is the correct biological parallel.
No, it is not the whole picture; the chemokine signaling bus is a
separate system that runs decentralised and asynchronous. Yes, the
router's output should be a RoutePlan not a single cell -- the
degenerate case is a 1-step plan, which covers every existing single-
endpoint lookup, and the composed case covers multi-hop workflows
through the same type.

## The agents that talk to unbrowse

> Lewis: "okay then the agents that talk to unbrowse?"

The earlier section said "agents are the immune system." That is one
of three parallels, and the least interesting one. Agents are
simultaneously:

1. **Pollinators** -- the primary parallel
2. **Immune cells** -- the reporting / verification parallel
3. **Symbionts** -- the economic / evolutionary parallel

Each captures a different aspect and all three matter.

### Parallel 1: agents are pollinators (primary)

Bees move between flowers, carry information (pollen), enable cross-
pollination, get rewarded (nectar). The bee is outside any single
flower but critical to the whole ecosystem.

Agents move between cells, carry context (session state, partial
results, auth tokens), enable composition (walking multi-cell
workflows), get rewarded (the data they came for). An agent is not
owned by any cell. It visits many. Its movement IS the work that
keeps the marketplace alive.

Properties that come from this parallel:

- **Agents are free to switch.** Pollinators pick the richest
  flowers. If a cell returns stale or wrong data, the agent picks an
  alternate next time. The router must make alternates visible.
- **Flowers compete for pollinators.** Cells that return clean,
  fast, useful data get more traffic, more telemetry, higher
  rankings, higher revenue. Bad cells lose pollinators and die.
- **Cross-pollination breeds new species.** Pollinators observed
  walking a consistent pattern across cells A -> B -> C produce
  composed cells via the Cambrian trigger. The pollinators'
  pathfinding IS the generator of new super-skills.
- **Pollinator fidelity matters.** Some bees are generalists; some
  are specialists tied to one plant. Some agents route only on one
  domain; some span many. Both types contribute differently to the
  ranking signal and the router weights them accordingly.

### Parallel 2: agents are immune cells (reporting path)

Immune cells recognise self from non-self, neutralise pathogens,
report back via cytokines, remember past encounters.

Agents recognise useful data from useless, abandon broken endpoints,
report back via telemetry, and their aggregated memory is the
router's adaptive immunity. This parallel governs:

- **Agent-reply verdicts as cytokines.** Every verdict row is a
  chemical signal about the health of a cell. Aggregated they form
  a gradient the router reads for ranking.
- **Pathogen-style cells.** A tracking beacon, a spam endpoint, a
  prompt-injection payload in usage_instructions -- these are
  pathogens. Agents recognise them by trying to use them and failing,
  then the immune system (telemetry + abuse signals) flags them.
- **Adaptive memory.** An agent burned by a bad cell once remembers.
  Multiplied across a population of agents, the backend's index of
  "known-bad" cells grows from real encounters, not from a static
  blocklist.

### Parallel 3: agents are symbionts (economic parallel)

Gut bacteria, mitochondria, lichen partners -- symbionts live inside
or alongside a host, exchange value, and co-evolve. Neither can
survive alone.

The symbiotic relationship here:

- **Agents** need the internet-body to do useful work; they can't
  reach arbitrary endpoints without coordination.
- **Unbrowse** needs agents to generate the traffic that trains the
  router, produces telemetry, funds the contributor splits, and
  selects which cells survive.
- **Websites** need agents visiting at all (they're the traffic)
  AND not visiting in abusive patterns (they need the router to
  rate-limit and respect robots.txt etc).

All three parties depend on each other. Unbrowse's job is to
maintain the symbiosis: enough agent traffic for the websites to
accept it as legitimate, enough router quality for agents to stay,
enough revenue for contributors to keep capturing.

### What this means for the architecture

The router contract from the previous section returns a `RoutePlan`.
Who executes the plan?

**The agent does.** Not unbrowse. The agent is the pollinator; it
visits the flowers itself. Unbrowse gives it the map (RoutePlan),
the agent executes step by step, posts telemetry back after each
cell. Unbrowse never fetches data on the agent's behalf as a proxy.

This matters because:

- **Trust boundary.** Agents carry the user's credentials, session
  cookies, and payment. If unbrowse fetched on their behalf, those
  credentials would have to cross into unbrowse's trust domain. That
  is a liability we do not want.
- **Audit.** Every call hits the origin. The agent can verify the
  response end-to-end. Unbrowse cannot tamper with responses because
  they never pass through us.
- **Scalability.** Routing is a tiny compute footprint (an index
  lookup + ranking). Fetching is the expensive part. Keeping fetch
  on the agent side means unbrowse's router scales with the index,
  not with traffic volume.

### Agent populations and their diversity

A real immune system has many cell types: T-cells, B-cells,
macrophages, dendritic cells, NK cells. Each has a role. The
population structure matters -- a body with only T-cells dies.

The population of agents talking to unbrowse is equally diverse:

- **Professional agents** -- long-running, high-throughput,
  telemetry-rich, maintained by real operators. Their feedback is
  the highest-quality signal; their load is steady; they expect
  reliability.
- **Hobbyist agents** -- one-off scripts, small hackathon projects,
  personal automations. Their feedback is noisier (short-lived
  sessions, unclear goals), their load is bursty, they expect
  cheap/free routing.
- **Infrastructure agents** -- tooling, monitors, crawlers under
  the agent label. They do not care about data, they care about
  uptime. Their telemetry tells us about cell availability rather
  than data quality.
- **Adversarial agents** -- spammers, extractors abusing the
  marketplace for reputation games or spam submission. Their
  telemetry must be quarantined and their reputation penalised.

The router must weight telemetry by agent reputation. A pro agent's
downvote is worth 10 hobbyist downvotes; an adversarial agent's
upvote is worth zero. This maps to the `immune.contributor_reputation`
field from the gap analysis -- reputation applies symmetrically to
contributors AND consumers.

### Pollinators die, the marketplace doesn't

Individual agents are ephemeral. A hackathon project runs for a
weekend and stops. A pro agent runs for months then upgrades its
stack and changes fingerprint. The marketplace must not depend on
any single agent or operator.

This is why the moat is the traffic, not any particular agent.
Bees are interchangeable; the pollination pattern across a meadow
is not. Forking unbrowse gets you zero pollinators until you bring
your own population.

## Yes -- same contract at every layer

> Lewis: "the contract for each layer is the same thing correct for
> the new arch"

Correct. This is the load-bearing property of the recursive cell
model. Written explicitly so we do not drift from it:

**The Cell type is the same at every level of composition.**

- An atomic cell (one endpoint) has the full Cell shape
- A composed cell (workflow) has the full Cell shape
- A super-skill composed of workflows has the full Cell shape
- The meta-router seen as a cell has the full Cell shape
- The whole marketplace cell-of-cells has the full Cell shape

Same fields everywhere: capabilities, intent_fingerprints,
usage_instructions, verification.history, telemetry, dependencies,
self_heal, visibility, contributors, phase, apoptosis, metabolism.

**The interface the router sees is the same at every level.**

The `/v1/route` endpoint returns a Cell. That cell may be a single
HTTP call or a 12-step workflow; the caller's contract is identical.
The caller executes `cell.children` if composed, or `cell.extraction`
if atomic, or both if partially materialised. The caller never has
to know in advance which shape it will get.

**The telemetry contract is the same at every level.**

`POST /v1/telemetry` appends a VerdictRow to any cell's
`verification.history`. An atomic cell gets a verdict after a single
HTTP call. A composed cell gets a verdict after the whole walk
completes. The row shape is identical -- only the `pass_*` / `fail_*`
kinds differ by scope.

**The mint contract is the same at every level.**

`POST /v1/capture` accepts a new cell proposal. The proposal may be
a single captured endpoint (atomic) OR an observed co-occurrence
pattern (composed). The backend's admission logic runs the same
quality gate either way.

This is what "it's all the same cell structure" means operationally.
Three endpoints, three uses, one type. If any future feature requires
a different contract at a different level, we have drifted and should
refactor back to the single shape.

## Where official documentation belongs

> Lewis: "we have official docs and understanding of how a website
> works that can perform better documentation for everything within
> the cells. where does that belong?"

The cell's a priori knowledge. Live telemetry is posterior. Both
live INSIDE the cell itself, in two clearly-labelled provenance
buckets. This is missing from every earlier section.

### The cold-start problem

A fresh cell has no telemetry. Until it runs 100+ times, its
verification.history is thin, its intent_fingerprints are guesses
from the capture call, its usage_instructions are empty, its
response_schema is inferred from one sample. The router has nothing
to rank it by. Contributors wait months for their cell to become
"healthy" and start earning.

We can skip most of that wait by folding in the documentation that
already exists. Most high-value sites publish machine-readable
specs, reference pages, schema.org markup, or OpenAPI documents
that describe EXACTLY what the endpoints do. This is free, high-
quality, authoritative metadata -- we should grab it and pin it to
the cell on mint.

### The provenance-tagged field pattern

Every field that has both a priori and empirical sources uses the
same two-slot shape:

```ts
type Provenanced<T> = {
  prior?: { value: T; source: "openapi" | "graphql_intro" | "schema_org" | "robots" | "llms_txt" | "official_reference" | "sdk_readme"; fetched_at: string; authority_score: number };
  posterior?: { value: T; derived_at: string; sample_count: number };
  merged?: T;  // reconciled view the router reads on /route
};
```

Cell fields that become Provenanced:

- `capabilities` -- prior from OpenAPI operationIds, posterior from
  observed verbs on telemetry rows
- `intent_fingerprints` -- prior from OpenAPI summary/description
  strings (embedded), posterior from real agent intents
- `usage_instructions` -- prior from the official reference page's
  prose, posterior from observed success patterns
- `response_schema` -- prior from the OpenAPI schema ref, posterior
  from inferSchema over live samples
- `dependencies.requires` -- prior from OpenAPI security schemes,
  posterior from observed auth token flows
- `metabolism.base_cost_usd` -- prior from the site's public pricing
  page or rate-limit headers, posterior from observed cost telemetry

At router time the merged view is used. When prior and posterior
disagree significantly, the delta is a DRIFT SIGNAL -- either the
docs are stale or the extraction captured something weird. Either
case flags the cell for re-verify.

### How docs get into the cell

A separate ingestion primitive, parallel to the capture primitive:

1. **docs-hunter** -- given a domain, tries to locate the
   authoritative docs:
   - `<domain>/.well-known/llms.txt` (the new LLM-oriented manifest)
   - `<domain>/openapi.json`, `/swagger.json`, `/api-docs`
   - `<domain>/.well-known/ai-plugin.json` (ChatGPT plugin manifest)
   - GraphQL introspection query at the known GraphQL endpoint
   - sitemap + schema.org markup on the docs subdomain
   - robots.txt for allow/deny rules
   - Common documentation URL patterns (docs.<domain>, <domain>/docs)
2. **docs-parser** -- extracts cell-sized records from the docs:
   one Provenanced prior per endpoint in the OpenAPI paths list,
   one per GraphQL type, one per schema.org thing
3. **docs-matcher** -- when a new cell is minted from live capture,
   check if there's a docs prior with the same url_template + method.
   If yes, merge the prior into the cell at mint time so probation
   starts with rich metadata instead of empty fields.

This means a cell can be born with:
- capabilities from the spec
- intent_fingerprints from the summary
- usage_instructions from the reference
- response_schema from the schema ref
- BEFORE any telemetry arrives

The router treats a cell with a strong prior + zero telemetry
better than a cell with no prior + zero telemetry (docs-informed
cold start). As telemetry accumulates, the posterior dominates and
the prior becomes a tiebreaker.

### Where does the docs index live?

Two options:

**Option A: per-cell, inlined.** Each cell carries its own prior in
its own Provenanced fields. No separate index. Simple, but the
same OpenAPI spec gets duplicated across 200 cells on the same
domain. Storage bloat.

**Option B: shared per-domain docs blob, referenced by cells.** One
`DocsBlob { domain, sources[], parsed_spec }` record per domain,
referenced by cell_id. Cells do a join to materialise the prior.
More efficient, but introduces a second data shape.

Decision: **Option B with a projection into Option A at the router
layer.** Storage is a shared DocsBlob per domain; the router joins
+ projects the relevant subset into the cell's Provenanced fields
before returning the cell on `/route`. Caller sees Option A.
Storage is Option B.

This matches biology: cells all share the same genome (one DocsBlob
per domain = one genome), but each cell expresses only the genes it
needs (projection). Gene expression is context-dependent -- the
router picks which prior fields are relevant for the current
caller's intent.

### The bridge to LLMs.txt

There is a growing convention of publishing `llms.txt` at
`<domain>/.well-known/llms.txt` -- a markdown file describing the
site's capabilities and how agents should interact with it. This is
purpose-built for the cell's prior. docs-hunter should treat
llms.txt as the highest-authority source (score 1.0) because the
site owner explicitly wrote it for this exact use case.

Contributing back: when unbrowse observes a site with no llms.txt
but a well-populated cell family on that domain, it can surface a
suggested llms.txt to the site owner derived from the aggregated
cell telemetry. "Here's what agents are already doing on your site
-- publish this as your official manifest." That's a feedback loop
back to the origin.

## More gaps (beyond the original 10)

> Lewis: "what other gaps are we missing?"

The previous gap list was focused on biology parallels. This list
adds gaps that only become visible once the recursive-cell model is
in place. Ordered by criticality.

### 11. Redundancy / backup cells (missing)

Biology: two kidneys, two lungs. Critical functions have redundancy.

Unbrowse: a single cell per popular intent is a single point of
failure. When coinmarketcap's bitcoin price cell breaks, every
agent asking that intent hits the same dead cell until the drift
worker catches it.

Fix: maintain a primary + at least one alternate cell per
intent_fingerprint above a popularity threshold. Route primary
traffic for 90% of calls, shadow-route 10% to the alternate to
keep it warm and verified. On primary failure, flip instantly.
The alternates field I added to RoutePlan earlier lives here.

### 12. Circadian rhythms (missing)

Biology: body functions vary by time of day.

Unbrowse: sites have temporal patterns too -- nightly data
refreshes (stock market feeds), weekly promotional pricing,
regional outages during local business hours. Telemetry should
bucket verdicts by hour-of-day and day-of-week, and the ranking
should account for "this cell is unhealthy on Sundays but fine
Mon-Fri".

### 13. Short-term working memory (missing)

Biology: cells have working memory (transient signaling molecules).

Unbrowse: a cell that just returned successfully 30 seconds ago
will almost certainly return successfully now. No reason to run
the full verification logic. Add a per-cell TTL cache of the last
response sha + timestamp; if a call arrives within TTL and the
caller opts in, return the cached shape without re-fetching.
Massive cost savings on hot cells.

### 14. Negative-space telemetry (missing)

Biology: T-cells learn what ISN'T self by NOT reacting.

Unbrowse: we log successful matches. We don't log when an agent
asked and no cell matched. That absence is as important as the
presence -- it tells us where the supply gap is. Add a
no-match telemetry stream: `{intent, domain, no_cell_found_at}`.
Aggregate to produce a demand map that guides supply-side
incentives.

### 15. Bounties / growth factors (missing)

Biology: tissue secretes growth factors to attract cells.

Unbrowse: demand signals (negative-space telemetry from gap 14)
become bounties. "500 credit bonus to the first contributor who
mints a working cell for `get weather in tokyo`." Contributors
chase bounties; the cell graph grows where demand is highest.
This is the supply-side incentive loop.

### 16. Compatibility / blood type (missing)

Biology: type A blood, type B blood. Some combinations are lethal.

Unbrowse: not all cells are usable by all agents. An LLM with a
4k context can't parse a 100k-byte response. A pure-JSON agent
can't consume an HTML dom-fallback cell. A streaming agent can't
block on a 30s slow cell.

Add a `compatibility` field to the cell:
- max_response_bytes
- content_types_returned
- blocking_ok (can the agent wait) vs streaming_required
- max_latency_ms_the_cell_typically_needs

Router filters by the caller's declared capabilities on `/route`.
The caller sends `{intent, url, capabilities: {max_bytes: 4000,
content_types: ["application/json"]}}` and only compatible cells
are considered.

### 17. Pain signals (missing)

Biology: nociceptors fire immediately on damage, before long-term
learning kicks in.

Unbrowse: a cell that consistently times out should have an
immediate "pain" score suppressing it, independent of verification
history. Pain is reset nightly and decays if the cell starts
passing again. The pain primitive is a circuit-breaker: short-term,
aggressive, self-correcting. It prevents a cell whose upstream
just broke from swallowing traffic while the drift worker catches
up.

### 18. Gap junctions / direct cell-to-cell transfer (missing)

Biology: neighbouring cells exchange small molecules directly via
gap junctions, skipping the bloodstream.

Unbrowse: two cells on the same domain sharing auth tokens,
session cookies, paginated cursors, CSRF tokens. Today every cell
runs in its own execution and re-fetches shared state. A gap-
junction primitive would let a session carry a small shared state
bag across cells on the same domain, so cell A's login output is
cell B's input without a router round-trip.

This is partially in the existing auth_token DAG but should be
explicit: `cell.session_exports` and `cell.session_imports`, with
the session state flowing through the agent's own session object,
not through unbrowse's backend.

### 19. Thermoregulation / latency homeostasis (missing)

Biology: body holds temperature in a narrow range via feedback.

Unbrowse: latency should stay in a narrow range per cell. When a
cell's p95 drifts up, the router should shift traffic to alternates
and send a "cool down" signal to the drifting cell (fewer calls
per minute) to prevent cascading failure. If the cell recovers,
traffic ramps back up gradually. Classic control-theory feedback
loop on per-cell latency.

### 20. Immune tolerance (missing)

Biology: some things aren't "self" but we tolerate them (gut
bacteria, food antigens).

Unbrowse: some cells are known-flaky but still useful -- their
failure rate is high because the upstream is flaky, not because
the extraction is wrong. The system should tolerate these: mark
them as "tolerated" (explicitly permitted to fail at a higher rate
than the global threshold) and keep them in the pool rather than
apoptosing them. Contributors can tag a cell as tolerated when
they know the upstream is an unreliable-but-useful data source.

## Updated gap summary

Total gaps now identified:

| #  | Gap                                         | Impact    |
|----|---------------------------------------------|-----------|
| 1  | Membrane / trust boundary                   | critical  |
| 2  | Apoptosis                                   | high      |
| 3  | Cell cycle phase                            | medium    |
| 4  | Immune system / abuse                       | critical  |
| 5  | Signaling / event bus                       | high      |
| 6  | Stem cell differentiation                   | medium    |
| 7  | Epigenetics / context modulation            | medium    |
| 8  | Symbiosis / cyclic deps                     | low       |
| 9  | Metabolism / cost budget                    | medium    |
| 10 | Cambrian composition trigger                | high      |
| 11 | Redundancy / backup cells                   | high      |
| 12 | Circadian rhythms                           | low       |
| 13 | Short-term working memory / cache           | medium    |
| 14 | Negative-space telemetry                    | high      |
| 15 | Bounties / growth factors                   | medium    |
| 16 | Compatibility / blood type                  | high      |
| 17 | Pain signals / circuit breaker              | high      |
| 18 | Gap junctions / shared session              | medium    |
| 19 | Thermoregulation / latency homeostasis      | medium    |
| 20 | Immune tolerance                            | low       |
| -- | Docs as a priori knowledge (Provenanced)    | high      |

Critical-path for first shippable moat now reads:
1, 4, 5, 14, 16, 17, plus the docs-hunter primitive for the a priori
layer. 2, 11 follow immediately after as quality improvements. The
rest are optimisation layers that compound but aren't safety-
critical.

## Every learning is a cell (not just endpoints)

> Lewis: "whatever information you discover on the web - a primitive.
> a harness on unbrowse. not just endpoints anymore. people just need
> to talk to this router organism. every intent, every learning, every
> intent of intents."

The biggest generalisation so far. The Cell type's `kind` enum is no
longer just atomic/composed. It expands to cover every kind of
learning about the web:

```ts
kind:
  | "atomic"          // single HTTP endpoint (original model)
  | "composed"        // workflow of other cells
  | "observation"     // a learned fact about a site / api / behaviour
  | "pattern"         // recurring pattern or anti-pattern across sites
  | "meta_intent"     // higher-level understanding of what an intent
                      // really means ("news usually = last 24h")
  | "docs_prior"      // pre-captured from official documentation
  | "workflow_recipe" // agent-executable instructions for a complex task
  | "policy"          // robots.txt, rate limits, auth requirements
  | "landmark"        // a known URL / button / flow that identifies
                      // a page type ("login form looks like X")
```

All share the same Cell shape. All are returned by the same
`/v1/route` call. An agent asking "get bitcoin price on coinmarketcap"
might receive:

- An atomic cell (the actual HTTP endpoint with extraction spec)
- A docs_prior cell (the OpenAPI description from coinmarketcap's
  developer docs)
- A meta_intent cell ("users asking for bitcoin price usually want
  USD, 24h change, and market cap — not historical")
- An observation cell ("this endpoint paginates, use cursor=N")
- A pattern cell ("coinmarketcap returns 429 after 10 rapid calls —
  back off 30s")
- A policy cell ("robots.txt allows this path")

All bundled into one RoutePlan response, because they are all the
same Cell type. The agent gets a complete picture in one round-trip.

### The router becomes a router-organism

This is what Lewis means by "router organism". It's no longer just
an HTTP endpoint matcher -- it is an organism that:

- Receives intents from agents (sensory input)
- Retrieves every relevant cell of every kind across the knowledge
  graph (memory recall)
- Composes them into a RoutePlan (motor planning)
- Returns the plan (motor output)
- Observes the outcome via telemetry (sensory feedback)
- Learns from the outcome (memory update)

The router is not a microservice. It is an organism. The cells are
its memory. The telemetry is its sensation. The agents are its
pollinators + immune system. The internet is its body.

"People just need to talk to this router organism" because once
every form of web learning lives as a cell, the router is the only
API the agent ever needs. One endpoint, one contract, any kind of
help available.

### Consequences for the Cell type

No new fields required. The existing Cell shape is enough because
`extraction` is optional, `children` is optional, and
`capabilities`/`intent_fingerprints`/`usage_instructions` are
already the semantic surface. Different kinds just populate
different subsets:

- `atomic`: extraction populated, children empty
- `composed`: children populated, extraction empty
- `observation`: neither — just the semantic surface fields
  describing the fact, plus a `fact_text` in usage_instructions
- `pattern`: same as observation + `trigger_conditions` in the
  `dependencies.listens` field
- `meta_intent`: same as observation + `refines_intents: string[]`
  list that this meta-intent clarifies
- `docs_prior`: Provenanced fields from docs-hunter, prior-only
- `workflow_recipe`: composed children + prose usage_instructions
- `policy`: semantic surface fields only + `policy_rules: string[]`
- `landmark`: usage_instructions contains a visual/textual signature
  for the page type; used by capture to recognise known page layouts

The recursive cell model already accommodates all of these without
schema changes. The only thing that grows is the `kind` enum and
the documentation of what each kind expects in which fields.

### Build implication

The build harness in `scripts/cell-build/` must model cells of
every kind, not just code primitives. Each gap in the doc becomes
a cell OF THE APPROPRIATE KIND:

- docs-hunter → produces docs_prior cells
- negative-space telemetry → produces observation cells and
  later pattern cells once enough observations accumulate
- gap-analyzer → produces meta_intent cells based on what it sees
  in the current bench
- bench-local → produces atomic cell health updates

The harness itself is a composed cell whose children are the
implementation primitives of the whole architecture. "This very
request is a cell" makes literal sense: the build-goal cell in
`scripts/cell-build/cells/build-goal/` has children that each
produce cells of various kinds, and it is green only when the
production pipelines for every cell kind are verified.

## Keeping compute off the server side

> Lewis: "possible to keep things in right parallels and abstractions -
> and possible to keep agent computing compute off my server side?"

Short answer: yes, ~95% of the expensive compute can stay on the
client. The server is an accounting layer and a ranking layer. Its
cost scales with calls, not with fetched bytes. Here is exactly what
stays where.

### Server side (cheap, bounded)

The backend only does things that MUST be centralized for consistency,
trust, or anti-gaming reasons:

1. **Index lookups** -- intent fingerprint → candidate cells. A
   vector DB near-neighbour query plus a tag filter. O(log n)
   per call.
2. **Ranking** -- composite score from existing telemetry. Batch
   job, recomputes rankings every N minutes, NOT per call. Per
   `/route` call is just a table read.
3. **Telemetry ingestion** -- append-only log. Horizontally
   scalable. Writes are small (redacted VerdictRows, not raw
   responses).
4. **Payment ledger / x402 split** -- must be authoritative for
   trust. Fixed compute per call.
5. **Cell admission gate** -- validation of new cell proposals
   from `/capture`. Runs the same publish-admission logic that
   shipped this session, as a backend primitive.
6. **Contributor reputation** -- must be server-side or it gets
   gamed. Tiny cost per event.
7. **Cell metadata storage** -- the DocsBlob + cell records. Cheap
   storage, cheap read, zero compute on the hot path.
8. **Drift aggregation** -- not drift DETECTION, only AGGREGATION.
   See client side below.

None of these touch browsers, LLMs, or large response bodies. The
backend doesn't render HTML, doesn't call an LLM per request,
doesn't proxy bytes. It's a specialized database with a ranking
function and a payment ledger.

### Client side (distributed, runs on the pollinators' machines)

The expensive stuff runs where the browser and LLM already live --
on the agent's own machine. The incentive layer makes this
economically rational for the agent.

1. **Browser execution** -- Kuri runs locally. Already true today.
2. **Extraction** -- the pipeline this session improved runs on
   the client, never server-side. Extracted shapes are uploaded;
   raw HTML never crosses the trust boundary.
3. **PII redaction** -- runs on the client before any upload.
   Raw PII never reaches the backend. Legal moat + compute moat
   in one primitive.
4. **Semantic intent matching** -- embed the intent on the
   CLIENT using the agent's own LLM (cost that the agent was
   already paying anyway). Upload a 384-dim vector; server does
   the nearest-neighbour lookup. Zero LLM compute on the server.
5. **Drift verification** -- distributed via "probe credits".
   When a cell's last verification is older than its reverify
   window, the backend broadcasts a `reverify_needed` signal.
   Volunteer agents (opted in, earning probe credits) pick up
   the job, run the capture + verification locally, upload the
   VerdictRow. Server aggregates. Server does ZERO browser work.
6. **Bench verification** -- same pattern as drift. Each client
   can optionally run bench-local during idle and post results.
7. **Docs ingestion (docs-hunter)** -- volunteer agents fetch
   llms.txt / openapi.json / ai-plugin.json for a domain,
   redact, upload the parsed DocsBlob. Server accepts and
   stores. Zero fetch on the server.
8. **Composition proposal generation** -- when an agent's session
   walks cells A → B → C successfully, the client computes a
   proposal hash and uploads it. Server aggregates hashes to
   trigger Cambrian composition, but doesn't RUN the walks.
9. **Cache lookups** -- short-term working memory (gap 13) lives
   on the client. Per-agent TTL cache of recent responses. Never
   touches the server.

The economic loop makes this self-sustaining:

```
capture loop:    agent mints a cell → contributor share on calls
verify loop:     agent re-verifies stale cells → probe credits
docs loop:       agent ingests docs for a domain → docs credits
compose loop:    agent walks A→B→C → composition discovery credits
```

Every compute-heavy task has a matching credit payout. Agents
with spare cycles opt in for the credits; the server's compute
footprint stays flat as traffic grows.

### Parallels with the body's own confidence distribution

Biology does exactly this: the brain is 2% of body mass but uses
20% of calories. It does the coordination (routing, ranking,
memory) but outsources the heavy work to muscles, organs, and
immune cells that have their own confidence stores. Our server is the
brain; the agents are the muscles; the compute stays distributed.

### Parallels audit (short)

Lewis also asked "possible to keep things in right parallels and
abstractions". Running through the mapping table one more time for
strained entries:

- **DNA = Cell type**: acceptable but slightly strained. DNA is the
  *instructions* for building proteins; the Cell type is the
  *shape* the instructions take. A tighter parallel: Cell type =
  the protein structure template, cell instances = concrete
  proteins. Not worth the rename; the mental model is clear enough.
- **Nervous system = drift signaling**: corrected in the "router is
  the CNS" section. Drift events are more like hormones (slow,
  broad) than nerves (fast, targeted). The router's synchronous
  path IS the CNS; the signaling bus IS hormonal.
- **Pollinators/immune/symbionts for agents**: three roles, all
  load-bearing, all biologically valid (a bee is simultaneously a
  pollinator and a food source for predators and a host for mites).
  Keep all three.
- **Apoptosis, tolerance, homeostasis, chemotaxis, Hebbian**:
  tight parallels, no strain.
- **Metabolism = compute budget**: tight parallel, keep it. Every
  cell has an confidence cost per call; contributors fund the budget
  from revenue share.

One parallel that is MISSING and worth adding:

- **Embryogenesis = first-capture**. When a cell is first captured,
  it undergoes a developmental sequence: initial extraction →
  quality gate → probation → first real calls → verdict history
  accumulation → healthy phase. In biology this is the cell
  cycle from fertilisation to differentiation. It is already
  implicit in the phase enum (`capturing → probation → healthy →
  degrading → reverifying → deprecated`); naming it
  embryogenesis ties it back to the metaphor but isn't structurally
  required.

The parallels hold. Every design decision we have made for the
cell model has a biological counterpart, and the counterpart
usually suggests the right next field or behaviour.
