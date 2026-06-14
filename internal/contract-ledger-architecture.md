# Unbrowse as a discovered contract ledger — architecture + plan

> Status: planning. Thesis settled; levers ordered. The first organ (the prerequisite
> chain-walker) shipped in v9.0.1.

## Thesis (one line)

**Unbrowse is a ledger of inter-dependent contracts — *discovered*, not declared — and the
ledger semantics belong at the composition layer. The harness (the contract-DAG executor) is
the moat; a single route is commodity.**

## Why (the isomorphism)

Strip a route and a contract to the same skeleton: *a node with typed in-edges (deps) and
out-edges (yields), fired when its deps are met, producing a witnessed result; a set of them is
a DAG.*

| unbrowse | contract ledger |
|---|---|
| route / endpoint | contract |
| `semantic.requires` (binding keys) | `blocked_by` (dependency edges) |
| `semantic.provides` / yields | what the contract satisfies |
| `resolve` | find the contract for the intent |
| `execute` → real data | satisfy with a witness |
| **prerequisite chain-walker** | **walk the DAG topologically** |
| route graph | the ledger |
| fair-compensation split per call | settlement per satisfied contract |
| content-addressed routes | content-addressed declarations |

**The one structural break (keep only real matches):** a contract is *declared* (top-down); an
unbrowse route is *discovered* (bottom-up, captured from real traffic). That difference IS the
moat — the contracts are mined, not authored. So the move is **not** "replace routes with
declared contracts." The move is: treat the *discovered* graph as a contract ledger and make the
**composition** layer first-class.

## Two layers

- **Atomic layer — a single route.** Stays direct: captured → content-addressed → executed. A
  read-only fetch needs no contract ceremony. Unchanged.
- **Composition layer — a multi-step task** (*find → book → pay → reply*). **This is the contract
  ledger.** Each step is a discovered contract (`requires`/`provides`); they are walked in
  dependency order (chain-walker); each is satisfied by execution (witness = real data); the set
  is settled (fair-comp). A multi-step task = a sub-DAG of contracts that call each other.

## Current state (what already exists)

- ✅ **Route graph with typed edges** — endpoints carry `semantic.requires` / `semantic.provides`
  (`OperationBinding[]`), so the dependency DAG is already in the data model.
- ✅ **Chain-walker (the DAG executor)** — `walkPrerequisiteChain` in
  `src/orchestrator/index.ts`: when a target's param is unbound, it finds a prerequisite that
  yields that key (in `dagPlan.prerequisite_order`), runs it first, threads the real value. The
  walked chain is recorded in `decisionTrace.prerequisite_chain`.
- ✅ **Settlement** — `backend/src/services/fair-compensation.ts` + the per-call on-chain split
  already pay each route call; the ledger has native settlement.
- ✅ **Per-user private registry** — `/v1/account/skills` + the dashboard "Your captured routes"
  view (public/private per route).

So unbrowse already *is* a contract ledger; the gap is that the composition layer is **walked but
not persisted** — a multi-step resolution re-walks the DAG every time instead of replaying a
satisfied composite.

## Target — the composite contract

A **composite** is a content-addressed artifact recording one satisfied multi-step resolution:
the ordered list of contracts (endpoints) walked, the binding edges threaded between them, and
the witness (the final satisfied result). It is:

- **content-addressed** by `(intent-signature, url, ordered endpoint set, binding edges)`,
- **replayable** as one unit — the second agent with the same multi-step intent runs the
  composite directly (DAG-replay) instead of re-walking (DAG-recompute),
- **payable** as one unit — the fair-comp split applies across the composite's constituent
  contracts in one settlement,
- **shareable** — a composite is a route-of-routes that can be public (marketplace) or private,
  same visibility model as atomic routes.

This is the north star moving from **DAG-recompute → DAG-replay.**

## Plan — levers, Dijkstra-ordered (cheapest first win)

Each lever names a runnable **witness** (exits 0 exactly when the lever is pulled).

| # | lever | witness |
|---|---|---|
| 1 ✅ | **Walk the prerequisite DAG at execute time** (chain-walker) | `tests/prerequisite-chain-yield.test.ts` green; resolve threads a real prerequisite yield (shipped v9.0.1) |
| 2 | **Emit the walked chain as a structured `composite` in the resolve result** (not just a trace side-note) — ordered steps, binding edges, the satisfied target. First-class, inspectable. | a multi-step resolve returns `result.composite = { steps[], edges[], witness }`; unit test asserts the shape from the chain-walker output |
| 3 | **Persist the composite** to the local skill cache, content-addressed by `(intent-sig, url, endpoint set, edges)`. | after a successful multi-step resolve, the composite is in the cache; a witness re-reads it by content address |
| 4 | **Replay** — on a second resolve for the same multi-step intent, run the persisted composite directly (skip re-walking). | second run's `run_plan` shows `mode: composite_replay` (not re-walk); latency drops; same witnessed result |
| 5 | **Settle the composite as one unit** — fair-comp split across the composite's constituent contracts in one payment. | a paid composite replay produces one settlement row covering N constituent routes; ledger sums match |
| 6 | **Publish composites** to the shared graph (marketplace) with the same public/private visibility as atomic routes; a composite another agent captured is replayable by you. | `/v1/account/skills` lists composites; dashboard renders them; a foreign composite replays end-to-end |

## Non-goals

- **No declared contracts.** Composites are *discovered* from real multi-step resolutions, never
  hand-authored. The capture engine stays the source of truth.
- **No contract ceremony on atomic calls.** A single read-only fetch never becomes a composite.
- **No replacement of the route model.** Composites are routes-of-routes layered *on top of* the
  existing atomic route graph.

## Risks / open questions

- **Composite invalidation.** A constituent route going stale must invalidate the composite. Reuse
  the existing freshness/TTL binding model per constituent.
- **Content-address stability.** The address must be stable across equivalent walks but distinct
  across different binding edges. Define the canonical address precisely before lever 3.
- **Replay safety.** A composite that includes an irreversible step (pay/book) must re-confirm at
  replay, not silently re-execute. Carry the existing "asked before {gerund}" gate into replay.
- **Settlement atomicity.** One-unit settlement across N constituents must be all-or-nothing or
  cleanly partial; reuse the Flex authorization semantics.

## Ledger

- 2026-06-14 — thesis settled; lever 1 (chain-walker) shipped in v9.0.1. Levers 2–6 open.
