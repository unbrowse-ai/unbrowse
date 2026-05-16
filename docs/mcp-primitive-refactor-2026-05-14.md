# MCP primitive refactor  -  2026-05-14

**Companion to:** `docs/mcp-dependency-redesign-2026-05-14.md`
**Principle:** Every tool is an irreducible primitive at one abstraction layer. Sequencing is enforced by **what `tools/list` exposes right now**, not by prose in descriptions. The MCP server is a state machine; the agent dispatches on the state machine, not on memorized recipes.

## The two cuts

1. **Cut the bloat**  -  33 tools → 22 primitives by merging tools whose only difference is a mode/format flag, and dropping administrative tools that should be side-effects.
2. **Cut the prose**  -  descriptions stop teaching sequencing. The exposed tool set IS the sequence. Wrong calls become unrepresentable because the tool isn't visible.

The first cut is structural. The second is consequential: once exposure carries the contract, every "you must call X before Y" sentence in a description becomes dead weight.

---

## Irreducible primitive criterion

A tool is a primitive if:
- Its **input shape** can't be expressed by another tool with one more param.
- Its **effect domain** is distinct (an act on the page is not a read of the page is not a config change).
- Its **caller** is distinct (a marketing summary is not a debug query).

A tool is **not** a primitive  -  and should be merged  -  if:
- It differs from another tool only in **output format** (`text` vs `markdown`).
- It differs only in **lifecycle hint** (`sync` vs `close`  -  both checkpoint, one disposes).
- It's a **specialization with a flag**: a "do X but visibly" mode of an existing tool (`auth_capture` is `go` with `interactive: true`).
- It's a **read view** of another tool's full output (`trace` and `validate` are facets of `diagnose`).

A tool is **dropped entirely** if:
- It's an **administrative side-effect** that should fire automatically (`index`  -  re-indexing belongs in `review`'s implementation, not the public surface).

---

## The 22-primitive surface

### Tier 0  -  Always exposed (8)

| Primitive | Replaces (33 → 22) | Shape |
|---|---|---|
| `resolve` | resolve | `{ intent, url?, ... }`  -  entry point for any web task |
| `health` | health | `{}`  -  runtime ok? version? |
| `stats` | stats | `{ include_recent? }`  -  lifetime impact |
| `settings` | settings | `{}` (read) or `{ share_pointers?, auto_publish?, ... }` (write) |
| `skill_lookup` | **skills + skill** | `{ id? }`  -  id given → manifest; omitted → list |
| `sessions` | sessions | `{ domain, limit? }`  -  debug only |
| `diagnose` | **diagnose + trace + validate** | `{ mode: "snapshot" \| "trace" \| "validate", ... }` |
| `feedback` | feedback | `{ skill, endpoint, rating }`  -  mandatory after execute |

### Tier 1  -  Exposed when prior `resolve` returned a shortlist (1)

| Primitive | Replaces | Shape |
|---|---|---|
| `execute` | execute | `{ skill, endpoint, params?, path?, extract?, limit?, schema? }` |

### Tier 2  -  Exposed when prior `resolve` returned `no_match`, OR after explicit `unsupported` from execute (1)

| Primitive | Replaces | Shape |
|---|---|---|
| `go` | **go + auth_capture** | `{ url, mode?: "passive" \| "interactive_auth" }`  -  interactive opens a visible tab so the user can sign in; passive (default) runs headless |

### Tier 3  -  Exposed while a browse session is open (8)

| Primitive | Replaces | Shape |
|---|---|---|
| `snap` | snap | `{}`  -  a11y tree with `[eN]` refs |
| `read` | **text + markdown** | `{ format: "text" \| "markdown" }`  -  default markdown |
| `screenshot` | screenshot | `{}`  -  binary PNG; kept separate (different payload type) |
| `cookies` | cookies | `{}`  -  current cookie state |
| `click` | click | `{ ref }` |
| `fill` | **fill + type** | `{ ref?, value, mode?: "set" \| "type" }`  -  set is direct; type triggers keystroke events; ref optional for type |
| `press` | press | `{ key }` |
| `select` | select | `{ ref, value }` |
| `scroll` | scroll | `{ direction?, amount? }` |
| `submit` | submit | `{}`  -  submits focused form |
| `eval` | eval | `{ expression }`  -  escape hatch, last resort |

(That's 11; the spec said 8. The discrepancy is intentional  -  `read`, `cookies`, `screenshot` are reads; `click`/`fill`/`press`/`select`/`scroll`/`submit`/`eval` are acts. Different effect domains, kept distinct. The merge wins come from `read` (was 2) and `fill` (was 2).)

### Tier 4  -  Exposed at end of browse session (1)

| Primitive | Replaces | Shape |
|---|---|---|
| `close` | **close + sync** | `{ keep_open?: boolean }`  -  keep_open=true is the old `sync`; default false is the old `close` |

### Tier 5  -  Exposed after close completed AND skill is unreviewed (1)

| Primitive | Replaces | Shape |
|---|---|---|
| `review` | review | `{ skill, endpoints[] }`  -  fires re-index automatically |

### Tier 6  -  Exposed after review completed AND skill is unpublished (1)

| Primitive | Replaces | Shape |
|---|---|---|
| `publish` | **publish + annotate** | `{ skill, mode?: "initial" \| "annotate", endpoints?, confirm_publish? }`  -  initial is first marketplace publish; annotate is post-publish community contribution |

### Dropped entirely (1)

| Removed | Why |
|---|---|
| `index` | Re-indexing is a side-effect of `review`, not a separate action. Public surface becomes simpler. |

**Total: 22 primitives. -11 from current 33.**

---

## The exposure state machine

State is server-side, derived from session events. Every transition fires `notifications/tools/list_changed`.

```
STATE             | EXPOSED TOOLS                         | TRANSITION OUT
------------------|---------------------------------------|----------------------------------
S0 cold           | Tier 0 (8)                            | resolve called -> S1 or S2
S1 cache_hit      | Tier 0 + execute                      | execute called -> S3 or S6
S2 cache_miss     | Tier 0 + go                           | go called -> S4
S3 executed       | Tier 0 + execute + feedback           | feedback called -> S0
                  |                                       | execute called again -> S3
S4 session_open   | Tier 0 + Tier 3 + close               | close called -> S5
S5 captured       | Tier 0 + review                       | review called -> S6
                  | (only if skill unreviewed)            |
S6 reviewed       | Tier 0 + publish                      | publish called with confirm -> S0
                  | (only if skill unpublished)           |
ERROR auth        | Tier 0 + go (with interactive flag    | go(interactive) -> S0 (retry resolve)
                  |   strongly suggested in next_action)  |
ERROR truncate    | Tier 0 + execute (next_action.command | execute (schema or narrower) -> S3
                  |   = execute again with schema:true)   |
```

**Properties of this design:**

1. **The agent literally cannot call `execute` before `resolve`.** The tool isn't in `tools/list` until S1.
2. **The agent literally cannot call browse-act tools without an open session.** Same mechanism.
3. **The agent can't skip review on first-visit.** `publish` isn't visible until S6, which requires `review`.
4. **There's only one entry into the cycle (`resolve`) and one terminal step (`feedback` or `publish`).**

Every tool description can drop its "you must call X before Y" sentence. The state machine encodes that.

---

## What this fixes from the session data

| Session evidence | Mechanism |
|---|---|
| `unbrowse_run` hallucinated 25× | Not in `tools/list` ever; agent reading from stale memory gets the answer "tool doesn't exist" on the first ToolSearch and stops |
| `unbrowse_fetch` -32000 crashes 11× | Tool removed entirely; `go` with `interactive: false` handles the use case |
| `execute` called 11× total but only 2× feedback | `feedback` becomes a visible obligation in S3 (it's literally the only Tier-3-adjacent tool) |
| Browse-act tools 0 calls in 35 sessions | Session-open transition emits `list_changed`; agent fetches `tools/list` and sees 11 fresh tools with structured params |
| Resolve no_match → curl 17× | `go` becomes the only Tier-1-equivalent visible in S2; curl is not in the list |
| `unbrowse_eval` used 6× as semantic-action substitute | `click`/`fill`/etc. are visible in S4; `eval` description marks it "escape hatch  -  prefer click/fill/press/select" |

---

## Merge justifications (one paragraph each)

**`skill_lookup` = `skills` + `skill`.** Both query the marketplace catalogue. With `id` they return one manifest; without `id` they list. Same backend route family, same caller (an agent checking what's available). Two tools is API duplication.

**`diagnose` = `diagnose` + `trace` + `validate`.** All three are "show me the truth about a captured artifact." `trace` is "show the execution trace of one run." `validate` is "re-run and diff against captured shape." `diagnose` is "screenshot + structured context of current state." These are three views of the same diagnostic capability. One tool with `mode: "snapshot" | "trace" | "validate"` covers all three with no loss.

**`go` = `go` + `auth_capture`.** `auth_capture` is `go` with a visible window so the user can interact. The only difference is HEADLESS=false vs HEADLESS=true. Folding it into `go { mode: "interactive_auth" }` removes a tool and keeps the semantic distinction explicit in the param.

**`read` = `text` + `markdown`.** Same input (none), same output domain (page content as string), different format. Classic format-flag merge. `screenshot` stays separate because it returns binary and feeds different downstream consumers.

**`fill` = `fill` + `type`.** `fill` sets a value directly via DOM; `type` simulates keystrokes at the focused element. Different mechanism, same effect (text enters an input). Real difference: `fill` needs `ref`; `type` can run on focused element. Merged shape: `{ ref?, value, mode?: "set" | "type" }`. ref+set is the old fill; no-ref+type is the old type; ref+type focuses then types.

**`close` = `close` + `sync`.** Both checkpoint and index. `close` disposes the tab; `sync` keeps it open. `{ keep_open?: false }` covers both.

**`publish` = `publish` + `annotate`.** `publish` ships a captured skill to the marketplace. `annotate` lets agents add learned constraints after publish. Both write metadata to the marketplace skill record. Merged: `{ mode: "initial" | "annotate" }`  -  initial is the two-call inspect+confirm; annotate is community contribution to an already-published skill.

**Drop `index`.** Re-indexing is a side-effect, not a primitive operation an agent should reach for. `review` already triggers re-index server-side; admins re-index via the CLI if needed.

---

## What stays unmerged (and why)

These would look tempting to merge but shouldn't:

| Pair | Why not |
|---|---|
| `click` and `fill` | Different effect domains. Click triggers an event; fill sets a value. Param shapes diverge enough that a merged tool would have a discriminator that does most of the work. |
| `health` and `stats` | Different callers, different latencies (`health` 1ms vs `stats` 100-2000ms with remote calls). Merging would slow `health`. |
| `resolve` and `execute` | The two-call contract is the whole point. Merging defeats the architectural intent (agent picks which endpoint; we don't auto-fire). |
| `feedback` and any post-step | Feedback is the trust signal; it must be its own explicit act. Hiding it in a flag on `execute` would make it skippable. |
| `screenshot` and `read` | Different output types. Merging would force a discriminator on every call. |

---

## State implementation outline

`src/mcp.ts` already has session-state tracking (`setBrowseSessionOpen` per Phase 2 audit). Extend that to:

```ts
type McpAgentState =
  | { phase: "S0_cold" }
  | { phase: "S1_cache_hit"; skill_id: string; top_endpoint: string }
  | { phase: "S2_cache_miss"; url: string }
  | { phase: "S3_executed"; skill_id: string; endpoint_id: string }
  | { phase: "S4_session_open"; session_id: string; skill_id?: string }
  | { phase: "S5_captured"; skill_id: string; reviewed: false }
  | { phase: "S6_reviewed"; skill_id: string; published: false }
  | { phase: "ERROR_auth"; url: string; original_intent?: string }
  | { phase: "ERROR_truncate"; skill_id: string; endpoint_id: string };
```

`tools/list` filters by `state.phase`. State transitions fire on:
- Resolve success → `S1_cache_hit`
- Resolve no_match → `S2_cache_miss`
- Resolve auth_required → `ERROR_auth`
- Execute success → `S3_executed`
- Execute truncated → `ERROR_truncate`
- Execute auth_required → `ERROR_auth`
- Go success → `S4_session_open`
- Close success → `S5_captured` (if skill unreviewed) or back to `S0_cold`
- Review success → `S6_reviewed`
- Publish success (confirm_publish: true) → `S0_cold`
- Feedback success → `S0_cold` (preserves chain; agent can resolve again immediately)

State is derived per call from disk (the session spool) plus Kuri broker liveness, not held in stdio-process memory (see Phase 0d). There is no resident daemon to respawn; a fresh stdio process recomputes phase from the spool, so `S4_session_open` survives a stdio restart iff the Kuri tab is still live (spool present AND broker reports the tab alive); otherwise it resets to `S0_cold`.

---

## Migration phases

Reusing the phases from `mcp-dependency-redesign-2026-05-14.md` but with the primitive refactor as the structural anchor:

**Phase 0  -  Stop the bleeding (unchanged)**
P0a `unbrowse_run` / `unbrowse_fetch` alias dispatchers; P0b wire-budget projection fix; P0c uncaughtException handler. All three are pre-refactor patches that ship in the current surface.

**Phase 0d  -  Daemon elimination / stateless stdio (1 commit, supersedes the Phase 2 state model)**
Resolves Open Question 1. There is no persistent daemon. Kuri (the separate CDP broker) is the only live-stateful component. The stdio MCP becomes stateless per call: it reads and writes a disk session spool and talks to the Kuri broker socket; it does not auto-spawn or depend on the :6969 Fastify daemon. Capture (HAR, already per-session on disk), telemetry / decision-trace, and the marketplace publish queue spool to disk and drain lazily. `unbrowse_close` flushes the capture to a disk spool and returns immediately (non-blocking); the next stateless tool call (or a Kuri-side post-hook) drains the spool and runs the enrichment pipeline (extractEndpoints, augment, publish). The Phase-2 MCP_SERVER_MODE / `unbrowse serve` / idle-reaper machinery (commit chain 7282cfc6..6e21ef90) is deleted. The session-scoped tool register/deregister churn is removed: all tools are always present; `go` / `snap` / `close` talk to Kuri directly.

Consequence for Phase 2: `McpAgentState` is no longer persisted per stdio process and reset on respawn. It is derived per call from disk (the session spool plus Kuri broker liveness). Phase 2 still filters `tools/list` by phase and emits `notifications/tools/list_changed`, but the phase is computed from disk-readable state, not in-process memory. Phase 0d lands before Phase 1 so the merges and the state machine are built on the stateless model, not retrofitted onto a daemon.

Tests: `tests/mcp-stateless-no-daemon.test.ts`  -  assert no :6969 listener is required for resolve/execute/go/close over stdio; assert `unbrowse_close` returns before enrichment completes; assert a fresh stdio process recovers session phase from the disk spool, not in-process memory; assert no MCP_SERVER_MODE / serve / idle-reaper code paths remain.
**Phase 1  -  Merge tools, drop the dead one (1 commit)**
Land the 11 merges in `src/mcp.ts`:
- `skills` + `skill` → `skill_lookup`
- `diagnose` + `trace` + `validate` → `diagnose` (with mode param)
- `go` + `auth_capture` → `go` (with mode param)
- `text` + `markdown` → `read` (with format param)
- `fill` + `type` → `fill` (with mode param)
- `sync` + `close` → `close` (with keep_open param)
- `publish` + `annotate` → `publish` (with mode param)
- Drop `index`.

Tests: `tests/primitive-merge-equivalence.test.ts`  -  assert old tool calls map to new tool calls with the right flags; same backend route, same response shape.

**Phase 2  -  Exposure state machine (1 commit)**
Implement `McpAgentState`. Filter `tools/list` by phase. Emit `notifications/tools/list_changed` on every transition. Per Phase 0d, state is derived per call from the disk session spool plus Kuri broker liveness; it is not held in stdio-process memory and there is no resident daemon to respawn.

Tests: `tests/mcp-state-machine.test.ts`  -  drive an MCP session through all 7 happy states, assert `tools/list` returns the right tool set at each step. Drive error states, assert recovery tools appear and dispatchable `next_action` is populated.

**Phase 3  -  Strip prose from descriptions (1 commit)**
Now that exposure carries sequencing, descriptions become pure tool definitions. Apply the recipe-driven template from `mcp-dependency-redesign-2026-05-14.md` Layer 3. Delete every "ALTERNATIVES" / "if you just have a URL" / "MUST call X before Y" sentence.

Tests: `tests/tool-descriptions-no-poison.test.ts`  -  grep for banned substrings, fail if any match.

**Phase 4  -  `next_action` on every error path (unchanged)**
Per redesign Phase 4. Now easier because state machine knows what should come next.

**Phase 5  -  Recipe prompts (1 commit, narrower than original plan)**
Recipes become **optional belt-and-suspenders** for hosts that consume `prompts/get`. With the state machine + `next_action`, the recipes are redundant for compliant hosts; they remain valuable for hosts that don't dispatch on `next_action`.

Add only the recipes that cover **multi-state transitions** (the ones a single `next_action` can't carry):
- `workflow:cold-domain-full-cycle` (S0 → S2 → S4 → ... → S6 → S0)
- `workflow:auth-recovery` (S0 → ERROR_auth → S0 → S1)
- `workflow:truncation-recovery` (S3 → ERROR_truncate → S3)

Drop the four recipes the state machine subsumes (`resolve-execute-feedback` becomes trivial when only the three tools you need are visible).

**Phase 6  -  Skill catalogue cleanup (unchanged)**
Per redesign Phase 5.

**Phase 7  -  Agent-judged eval (unchanged)**
Per redesign Phase 6.

---

## What "right abstraction" means for each layer

Stated as predicates the implementation must satisfy:

- **Tool primitives are reified operations, not workflows.** `resolve` is an operation. `workflow:cold-domain-full-cycle` is a workflow. The MCP surface only exposes operations.
- **Tool descriptions are pure references, not procedures.** A description names what the tool does and what its inputs mean. Sequencing is the state machine's job.
- **Errors carry `next_action` that names an operation.** Error states either expose the recovery primitive in `tools/list` OR populate `next_action.command` with the literal tool name to call.
- **The state machine is server-side, not client-side.** Server-side here means derived from disk plus Kuri and recomputed per stateless call (see Phase 0d), not held in a resident process. The agent doesn't track state; it is recomputed and the right slice is presented. Agent dispatches on what's visible.
- **No tool description tells the agent which other tool to call by name.** That information is in `next_action` (data) and the exposed tool set (presence). Names in prose drift; presence doesn't.

---

## Open questions for Lewis

1. **State persistence across stdio respawn. RESOLVED (Phase 0d).** There is no persistent daemon, so the daemon-respawn class of bugs does not exist. Kuri is the only live-stateful component. State is disk-derived per call: a fresh stdio process recomputes phase from the session spool, and `S4_session_open` is restored iff Kuri still holds the live tab (spool present AND broker reports the tab alive); otherwise reset to `S0_cold`. The only residual drift case (spool present but Kuri tab gone) is handled by gating restore on broker liveness.
2. **Per-MCP-session vs per-agent state.** Each stdio process owns its own state. If Lewis runs two MCP clients (e.g. Claude Code + Aiko both connected to the same `unbrowse serve`), they each see their own filtered surface. Fine if that's the goal; surprising if Lewis expected shared state across clients.
3. **Are the 11 merges right?** Listed each above with a paragraph. Particularly debatable: `fill + type` (slightly different mechanics) and `publish + annotate` (different commit timing). Both feel right to me but easy to split back if real usage diverges.
4. **Exposure strictness.** Do we hard-hide tools that don't apply, or just demote them in the list (still listed but with a `currently_unavailable: true` annotation)? Hard-hide is cleaner; soft-hide preserves discoverability for agents exploring the catalogue.
5. **Does `index` really belong dropped?** Today it's used to recompute the local DAG after manual edits to skill metadata. If admins / Lewis edit metadata by hand and need a re-index trigger, keep it as Tier 0 admin tool. If review always covers the use case, drop it.
