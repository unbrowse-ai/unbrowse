# plan-client-boundary.md — keep the moat logic on the backend

**Problem (confirmed):** the public client bundle (`unbrowse-ai/unbrowse` `src/`, the
npm `unbrowse` source) ships **reverse-engineerable moat intelligence** — `src/ranking/`
signals, `src/reverse-engineer/`, `src/graph/`, `src/intent-match.ts`, `src/indexer/`
heuristics. `src/ranking/index.ts` itself documents this ("the tuning weights shipped in
the npm bundle and were reverse-engineerable") and a partial "WAVE 2" server-move exists
(`rankEndpointsServerFirst` → `/v1/search/rank`). The migration is **incomplete**.

**Goal (settle condition):** the public client surface ships **no moat intelligence as a
primary code path** — ranking, route-graph compilation, RE heuristics, and intent-match
run **server-first** (a backend route), with the client carrying only thin glue + a
*degraded* local fallback where offline availability genuinely requires one. Enforced by
a runnable gate so it can't silently regress.

**Hard constraint (the boundary is NOT "all logic on the backend"):** capture of local
browser traffic, credential/auth handling, value-pointer resolution, wallet signing, and
execution/replay **must stay client-side** — moving them server-side would send the
user's traffic/credentials to the server and break the "credentials never leave your
machine" security promise (and the local-capture value prop). So the boundary is:
**shared intelligence → backend; local execution → client.**

---

## The gate (pinned `check`)

```
bash scripts/client-boundary-gate.sh
```

Two-part, exits 1 on any failure:

1. **Coverage** — every top-level module under public `src/` is classified in the
   boundary manifest `scripts/boundary/CLIENT-BOUNDARY.md`. An UNCLASSIFIED public module fails the
   gate (no silent additions).
2. **Conformance** — for every module classified `moat-server`, the public client must
   not ship its intelligence as the *primary* path: it must call a backend route
   server-first (grep-provable: an outbound `/v1/...` call in the module's entrypoint),
   with any local compute behind an explicit fallback. Modules not yet migrated are
   listed in a tracked **exposed-debt ledger** (`scripts/boundary/CLIENT-BOUNDARY.debt.tsv`); the gate
   PASSES only when every `moat-server` module is either server-first OR carries a debt
   row with an owner + remediation pointer (no untracked exposure).

The witness is real: it makes the current exposure *explicit and counted*, and it fails
if new moat logic is added to the public client without a server-first path or a tracked
debt row.

---

## Classification (draft — Lewis confirms; evidence from the public clone)

| public `src/` module | class | rationale |
|---|---|---|
| `capture/`, `cdp/`, `browser/`, `kuri/` | **client-local** | observes LOCAL browser traffic; cannot move server-side without shipping user traffic. KEEP. |
| `auth/`, `values/`, `payments/` (signing), `cli-wallet.ts` | **client-local** | credentials + wallet keys are local by security. KEEP. |
| `execution/` (replay), `orchestrator/` (local glue), `cli*`, `mcp.ts`, `contract-bridge.ts`, `interop/` | **client-local** | run the resolved route locally / bridge surface. KEEP. |
| `ranking/` | **migrating** | server-first path exists (`rankEndpointsServerFirst`); local ranker is the degraded fallback. Finish: ensure the agent-facing path never uses the local signals as primary. |
| `reverse-engineer/` | **moat-server** | RE heuristics (traffic→API inference) are the moat; should be a backend pass over sanitized capture, not shipped weights. |
| `graph/` | **moat-server** | route-graph / DAG compilation is shared intelligence. |
| `intent-match.ts` | **moat-server** | intent→endpoint matching logic. |
| `indexer/` | **moat-server** (partial) | capture→route inference heuristics; some local indexing is fine, the *scoring/admission intelligence* is moat. |

`marketplace/`, `api/` need per-file review (likely client of the backend, not server) —
the gate's coverage check forces a verdict on each.

---

## Phases

### Phase 1 — audit + enforceable gate (SAFE, dev-side, loop now)
- [ ] **A1** — `scripts/boundary/CLIENT-BOUNDARY.md`: classify every top-level public `src/` module
  (client-local / migrating / moat-server) with one evidence line each (entrypoint +
  whether it calls a `/v1/...` route or computes locally).
- [ ] **A2** — `scripts/boundary/CLIENT-BOUNDARY.debt.tsv`: one row per `moat-server` module still
  shipping primary-path logic — `module \t owner \t backend_route_target \t status`.
- [ ] **A3** — `scripts/client-boundary-gate.sh`: coverage + conformance check above.
  Derive the public module list from the open-core/public surface, not a hand list.
- [ ] **A4 (settle)** — `bash scripts/client-boundary-gate.sh` exits 0: 100% coverage,
  every `moat-server` module server-first OR a tracked debt row. The exposure is now
  visible, counted, and regression-proof.

### Phase 2 — per-module server-move (GATED follow-on, NOT autonomous on public/backend)
For each debt row, replicate the ranking WAVE-2 template, one module per checkpoint:
1. backend route computes the intelligence over sanitized input (in the dev `backend/`);
2. client calls it server-first; local logic becomes a degraded fallback or is deleted;
3. flip the debt row to RESOLVED; gate stays green.
Touches the private backend + the public client → each module is a reviewed checkpoint,
never an autonomous deletion.

---

## Guardrails
- **Do not move client-local modules server-side** — capture/auth/values/signing/execution
  stay local (security). The gate must classify them `client-local`, never flag them.
- **No autonomous public-repo deletions** — Phase 1 is dev-side (manifest + gate). Phase 2
  edits to the public surface / backend are human-gated checkpoints.
- **Honest debt** — a `moat-server` module that's still exposed gets a real debt row, not a
  silent reclassification to hide it. The gate counts exposure; it doesn't bury it.
