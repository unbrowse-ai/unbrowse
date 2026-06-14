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

### Lever 6 — publish composites  *(after 5)*
Composites get the same public/private visibility as atomic routes; a foreign composite replays.
**Witness:** `/v1/account/skills` lists composites; the dashboard renders them; a foreign composite
replays end-to-end.

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
