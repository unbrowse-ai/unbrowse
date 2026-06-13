# Plan — make EmergentDB the primary shared-graph store

> Continuation. The contribution graph is on a dedicated CF `GRAPH_KV` (primary) + CF
> STATS_KV (fallback), stored as ONE blob. To make **EmergentDB** the primary store (the
> backend's production storage, EmergentDB→CF FallbackKV), the blob must become **per-endpoint
> keys** — EmergentDB's `qdkv` caps a value at ~10KB, and a growing whole-graph blob would be
> truncated. Witness: `scripts/zk-delta-emergent-gate.sh` exits 0 iff every node is real +
> tested. No fabricated green.

## Goal (one line)

The shared route graph lives in **EmergentDB primary + CF KV fallback** (the same
`FallbackKV` the rest of the backend uses), stored as one small key per winning endpoint and
one per ledger record — so no value approaches the 10KB cap, reads enumerate via `list`, and
an EmergentDB outage degrades to CF KV.

## Where it stands

| Now | Target |
|---|---|
| `saveGraph`/`loadGraph` read+write the WHOLE winners map as one blob | per-endpoint: `saveWinner(delta)` / `loadGraph` via `list("contrib:w:")` |
| ledger persisted as one blob | one record per key `contrib:l:<seq>` |
| store = CF GRAPH_KV primary + CF STATS_KV fallback | EmergentDB `FallbackKV` (EmergentDB primary + CF KV fallback) when keyed |
| route loads all → merges in memory → saves all | route loads the endpoint's winner → gates → writes ONE winner + ONE ledger key (O(1)) |

## Phased build (cheapest-first; each node = goal · primitive · witness)

| # | node · goal | primitive | witness (exit 0 ⇔ done) |
|---|---|---|---|
| 1 | **per-endpoint-store** — winner-per-key + ledger-per-record, enumerated via `list`; each value is one small delta/record | `graph-store`: `GraphKV.list`, `saveWinner`/`loadGraph`(list)/`appendLedgerRecord`/`loadLedger`(list) | `tests/graph-perkey.test.ts` — save N winners ⇒ N keys; loadGraph reconstructs via list; each value well under 10KB; ledger appends per-record |
| 2 | **emergentdb-primary-routing** — `makeGraphKV(env)` returns the EmergentDB-backed FallbackKV (EmergentDB primary, CF KV fallback) when EMERGENTDB_API_KEY is set; dedicated CF GRAPH_KV+STATS_KV otherwise; uniform `get/put/list` | `graph-store`: `makeGraphKV` + a list-adapter over EdbKV/CF list shapes | `tests/graph-emergentdb-routing.test.ts` — picks the EmergentDB tier when keyed; CF tier otherwise; the list-adapter normalises both shapes to `string[]` |
| 3 | **per-endpoint-merge** — the route loads only the endpoint's current winner, gates, and writes exactly ONE winner key + ONE ledger key | `contribution-route`: per-endpoint load/gate/save | `tests/graph-perkey-route.test.ts` — a contribution writes exactly 1 winner + 1 ledger key; gate + LWW still hold; root via list matches in-memory graphRoot |
| 4 | **goal** — all green; deployed to staging on EmergentDB-primary; live round-trip persists in EmergentDB | — | `scripts/zk-delta-emergent-gate.sh` exits 0 (+ staging live check, reported) |

## Honest boundaries

- EmergentDB's internal index/direct-key split is EdbKV's concern (the same store skills/stats
  use at scale). Per-endpoint values (~500 B) never hit the per-value cap; that is what this
  plan guarantees. The live EmergentDB round-trip is verified on staging, outside the unit gate.
- Reads use `list` (EdbKV serves it from its index; CF KV serves a prefix scan). An EmergentDB
  outage degrades to CF KV via `FallbackKV` (the existing resilience).

## WALK status — gate green (3/3); live: CF per-endpoint shipped, EmergentDB blocked on a workerd bug

- [x] node 1 — per-endpoint-store · `graph-store` per-key winner/ledger + `list` · `tests/graph-perkey.test.ts` (4✓)
- [x] node 2 — emergentdb-primary-routing · `makeGraphKV`/`adaptKV`/`buildEmergentGraphKV`, EmergentDB+CF compose · `tests/graph-emergentdb-routing.test.ts` (5✓)
- [x] node 3 — per-endpoint-merge · `gateAndCompare` + route writes one winner + one ledger key · `tests/graph-perkey-route.test.ts` (4✓)
- [x] goal (unit) — `scripts/zk-delta-emergent-gate.sh` exits 0; first + prod spines still green (no regression); backend compiles
- [x] **LIVE (CF)** — the per-endpoint store is DEPLOYED + working on staging via the dedicated CF `GRAPH_KV` (`store: dedicated-fallback`): POST admits, GET /root stable, no 500.
- [ ] **LIVE (EmergentDB) — HONEST NEGATIVE / BLOCKED.** The EmergentDB `EdbKV` path 500s on the **workerd runtime** with `TypeError [ERR_INVALID_ARG_TYPE]: first argument must be of type string or Buffer…` — a crypto/Buffer incompatibility that does NOT occur in local bun (the probe `kv.put`→`get`→`list` round-trips cleanly). Root cause is in the EmergentDB-on-workerd path, not the per-endpoint logic (the CF per-endpoint path works). EmergentDB is therefore **gated opt-in** behind `UNBROWSE_GRAPH_STORE=emergentdb` and wrapped over CF, so enabling it cannot 500 the route. Flipping it on is the remaining work: reproduce the workerd Buffer error against `EdbKV` (likely an `_idxLoad`/hash call passing a non-Buffer), fix it, then set the staging var.

Honest landing: the **structural goal** (per-endpoint keys under the qdkv cap, O(1) merge, EmergentDB-ready routing) is shipped and unit-proven; the **EmergentDB live cutover** is one workerd bug away and is held behind a flag rather than faked green.

(Prior plans — pay.sh, prod-hardening — WALK COMPLETE, preserved in git history.)
