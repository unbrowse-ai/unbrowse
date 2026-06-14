# Plan — persist + replay composites (contract-ledger levers 3–4)

> Execution plan for the next frontier of `internal/contract-ledger-architecture.md`.
> Levers 1 (chain-walker) and 2 (composite emission) shipped in v9.0.1/v9.0.2.

## Frontier state

- ✅ A multi-step resolve walks the prerequisite DAG and emits a structured `composite`
  `{ target, steps[], edges[] }` into the decision trace (`buildCompositeEdges`, tested).
- ❌ The composite is **recomputed every time** — not persisted, not replayed. A second agent
  asking the same multi-step intent re-walks the whole DAG.
- ✅ Resolved residual: the "4 poison" bench rows are **false positives** in the bench's substring
  detector (real pages — iLovePDF/KAYAK/Eseecloud/Genius Scan — that merely contain a marker
  string). The cache-poisoning guard itself is fine. Bench-detector refinement only; low priority.

## Goal

Move the composition layer from **DAG-recompute → DAG-replay**: a satisfied multi-step resolution
persists as a content-addressed composite, and a later resolve for the same intent replays it as
one unit instead of re-walking.

## Levers (ordered, each with a runnable witness)

### Lever 3 — persist the composite
**Build:** when a resolve emits a composite (chain length ≥ 1 and the target satisfied), write it
to the local skill cache as a *composite descriptor* — content-addressed by
`sha256(intent_signature · registrable(url) · ordered endpoint_ids · sorted edge keys)`.
Store: `{ composite_id, intent_signature, domain, target, steps[], edges[], created_at }`.
Reuse the existing skill-cache writer (where atomic skills land) so composites live beside routes.

**Witness:** after a multi-step resolve, a new test reads the composite back by content address
from the cache and asserts `{target, steps, edges}` round-trips. A second identical resolve
produces the **same** `composite_id` (deterministic address).

**Guards:** never persist a composite whose target or any step is an irreversible op
(pay/book/submit) — carry the existing `canAutoExecuteEndpoint` / "asked before {gerund}" gate.
Skip when any step failed (`ok:false`).

### Lever 4 — replay the composite
**Build:** at resolve time, before the normal rank→walk path, look up a persisted composite by
content address (intent_signature + url). On hit, execute the composite directly: run its `steps`
in order, thread `edges`, execute the target — skipping re-discovery of `prerequisite_order`. Stamp
`run_plan` with `mode: "composite_replay"` and the `composite_id`.

**Witness:** an integration test (or scripted two-run): run a multi-step intent twice; the **second**
run's `run_plan[0].mode === "composite_replay"`, references the persisted `composite_id`, and
returns the same witnessed result with fewer discovery calls.

**Guards:** an irreversible step in a replayed composite must re-confirm, never silently
re-execute. Invalidate a composite when any constituent route is stale (reuse the per-binding
freshness/TTL model). A replay that fails a step falls back cleanly to the full recompute path.

### Lever 5 — settle the composite as one unit  *(after 3–4 land)*
Fair-comp split across the composite's constituent contracts in one settlement.
**Witness:** a paid composite replay produces one settlement row covering N routes; ledger sums match.

### Lever 6 — publish composites  ✅ SHIPPED (deploy-free)
Composites travel ATTACHED to the skill manifest, so they reach the backend route graph on the
existing publish rail with **no backend schema change** — verified: the backend stores skills as
raw `JSON.stringify(skill)` KV blobs (`marketplace.ts:376/288/318`, `account.ts:310`,
`skills.ts:712/763`), `getSkill` does `JSON.parse` (round-trips whole), and `validateSkillManifest`
is a prototype-pollution **denylist**, not an allowlist (an additive `composites` key passes). A
foreign agent that never walked the chain replays a skill-attached composite **always-on (ungated)**.
**Witness:** `tests/composite-persist.test.ts` "lever 6 — always-on foreign replay" (a skill carrying
a composite drives `findCompositeInSkill` → `planPrereqOrder` → `composite_replay` with no local
disk and `UNBROWSE_LOCAL_CACHES` deleted). 27/27 green; orchestrator + full CLI bundle clean.

## Non-goals (unchanged from the architecture doc)
- No declared composites — discovered only, from real satisfied resolutions.
- No composite for a single atomic call.
- No replacement of the atomic route model; composites layer on top.

## Build order this pass
1. **Lever 3** — persist (the cheapest first win; pure storage + a round-trip witness).
2. **Lever 4** — replay (depends on 3; the visible payoff).
3. Ship as the next release; 5–6 are follow-ups.

## Ledger
- 2026-06-14 — plan written. Poison residual resolved (bench false-positive). Building lever 3.
- 2026-06-14 — **levers 3 + 4 shipped** (`src/orchestrator/index.ts`, witness `tests/composite-persist.test.ts`, 8+6 tests).
  - Lever 3 (persist): `compositeAddress(domain,target,steps,edges)` = structural content-id;
    `compositeLookupKey(domain,target)` = the pre-walk replay key; `writeComposite`/`readComposite`
    gated on `UNBROWSE_LOCAL_CACHES=1` (a composite is a local cache like a skill snapshot —
    backend graph stays source of truth). Persist wired at the composite emission point under the
    guard `chainSteps.every(ok) && canAutoExecuteEndpoint(target)` (never persist an irreversible
    target or a failed walk).
  - **Design correction:** the content-address can't be the replay key — `steps`/`edges` aren't
    known before the walk. The replay key is `(domain, target endpoint)`, since the prerequisite
    structure is a property of the target endpoint, not the intent phrasing. Intent is metadata.
  - Lever 4 (replay): `planPrereqOrder(livePrereqOrder, persisted, isReplayable)` (pure, tested) —
    on a `(domain,target)` hit whose every recorded step is still replayable (exists +
    auto-executable), runs the recorded order first (merging extra live prereqs, deduped) and stamps
    the composite trace `mode: "composite_replay"`; a stale/missing/now-irreversible constituent
    cleanly falls back to the live recompute order. Wired pre-walk; `console.log("[chain] composite
    replay → …")` on hit.
  - Witnesses green (23/23 across composite-persist + prerequisite-chain); orchestrator bundles
    clean (898 modules). Both levers OFF by default (gate), so prod behavior is unchanged until a
    caller opts into local caches — the visible payoff lands when lever 6 publishes composites to
    the backend graph (always-on).
  - **Open:** lever 5 (settle composite as one unit), lever 6 (publish composites — moves replay
    from local-cache-gated to always-on via the backend graph). A live two-run integration witness
    (run a real multi-step intent twice, assert run 2 is `composite_replay`) is the next proof —
    the pure-unit witness proves the decision logic; the integration proves the wiring end-to-end.
- 2026-06-14 — **lever 6 shipped, deploy-free** (rode the existing publish/resolve rail; no backend
  change — the backend KV is a raw-JSON pass-through). `SkillComposite` type + `composites?` on
  `SkillManifest` (`src/types/skill.ts`); `findCompositeInSkill` (always-on read from the resolved
  skill) + `attachCompositeToSkill` (returns newly-added) in the orchestrator; `planPrereqOrder`
  loosened to a minimal structural composite so both local-disk and skill-manifest composites drive
  it; replay prefers the skill-attached (ungated) composite over the local-disk (gated) one; on a
  NEW composite attached to a real skill, a fire-and-forget `queuePassiveSkillPublish` propagates it
  to the graph (in-flight-deduped + checkpoint-gated, so a re-walked DAG never spams publishes).
  Witnessed (27/27) including the foreign-replay property.
  - **Open now:** lever 5 (one settlement row across a composite's constituent routes), the dashboard
    rendering composites under `/v1/account/skills`, and a live two-run integration witness on the
    shipped binary. 9.0.4 ships the always-on machinery; the visible-in-prod payoff arrives once a
    real multi-step domain publishes a composite and a second agent replays it.
- 2026-06-14 — **frontier swept (jesus-ralph "pull all levers")**, shipped in **9.0.5**:
  - **Integration witness** (`tests/composite-dag-integration.test.ts`): the named "wiring fires"
    proof. A skill whose endpoints carry semantic requires/provides drives the REAL local DAG
    planner (`fetchDagAdvisoryPlan`) to derive `search` before `get_item`, which feeds the composite
    emission and a run-2 `composite_replay`. Hermetic (no network/mocks) — proves the chain triggers
    from real metadata, not just the isolated `planPrereqOrder` logic.
  - **Stale-constituent invalidation** (plan lever-4 guard): the replay predicate now also rejects a
    constituent whose `verification_status === "disabled"`, so a composite with a route gone bad
    falls back to full recompute instead of replaying a dead route.
  - **Dashboard surface**: each captured route shows its "N multi-step chains" count
    (`frontend/.../dashboard/page.tsx` + `composites?` on the frontend `SkillManifest`).
  - **Honest negatives (deferred, not pulled):** lever 5 settlement — a composite replay runs
    already-indexed routes, so there is NO new payment event to split; building per-composite
    settlement now would be accounting for a flow that does not exist. Local-disk composite prune on
    skill-delete — gated/rare path, low value (skill-attached composites prune with the manifest).
    The deep upstream lever (capture populating operation graphs so the walk fires in production) is
    the separate DAG-recompute north star, not a composite-ledger lever.
  - **Frontier assessment:** the meaningful composite-ledger BUILD levers (3,4,6 + the wiring proof +
    invalidation + dashboard) are pulled and shipped across 9.0.3/9.0.4/9.0.5. What remains is either
    speculative (settlement, awaiting monetization) or upstream (DAG population). No more composite-
    ledger levers to pull.
