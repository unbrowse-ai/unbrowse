# Ledger Unification Plan — append-only event-log + projection

## Goal (one line)
Port the **economic ledgers** (`attribution`, `fees`) from mutable read-modify-write
accumulators to the **append-only, content-addressed event-log + projected-balance**
model the repo already proves correct in `route-ledger.ts` / `contract-ledger.ts` —
fixing the lost-update race and adding per-event provenance, on one shared integrity model.

## Why (the bug, grounded)
`recordAttribution` (`services/attribution.ts:106`) and `recordGraphFee`
(`services/fees.ts:71`) do `get → mutate blob → put` on a single per-actor key. The KV
(EmergentDB) is **last-write-wins, no CAS** (`route-ledger.ts:16-19`). Two concurrent
executions both read the same balance and both write back → **one credit is silently
lost**. The index keys (`attribution:indexers:index`, `fees:agents:index`) have the same
RMW race and will hit the 10KB value cap as actors grow. This directly contradicts the
repo's own "APPEND-ONLY, not exactly-once" doctrine (`contract-ledger.ts:168-179`).

This is NOT adopting aiko-engine3's architecture (it's a single-process binary, not a
backend). It's applying unbrowse's OWN best pattern (route-ledger) consistently — the
append-only/projection discipline aiko-engine3's coherence atom + KV-cache spine also
embody. One shared interface, recognize by shape (the superpattern), not three schemas.

## Design (mirror route-ledger)
- **Event rows, content-addressed, distinct keys** — never overwrite:
  - `attribution:event:<indexer_id>:<sha256(canonical event)>` → `AttributionEvent`
  - `fees:event:<agent_id>:<sha256(canonical event)>` → `FeeEvent`
  - The hash includes `execution_id` (+ endpoint/op) → **idempotent**: re-recording the
    same execution is a no-op write to the same key (exactly-once per execution), and
    distinct executions get distinct keys → **no lost update under concurrency**.
- **Balances are a projection**, never a stored mutable blob:
  - `getIndexerLedger(env, id)` = `listWithValues("attribution:event:<id>:")` → fold into
    the existing `IndexerAttributionLedger` shape (sum `fee_allocated_uc`, count, Σdelta).
  - `getAgentFeeLedger` / `getFeesSummary` = same fold over `fees:event:` rows.
  - This is exactly `projectStatus()` (`contract-ledger.ts:253`) applied to money.
- **No index blob.** Actor enumeration = prefix list over the event keyspace (the inline
  `_idx` already makes `listWithValues` zero-fetch), removing the RMW index race + 10KB cap.
- **Public API unchanged.** `recordAttribution`, `getIndexerLedger`, `listIndexerIds`,
  `recordGraphFee`, `getAgentFeeLedger`, `getFeesSummary`, `creditEarnings` side-effect —
  same signatures + return types; only the persistence shape changes underneath.

## Invariants preserved (from the brief)
- µ¢ integer money math (1e-6 USD), never float.
- delta-based reward + slashing semantics (`computeAttribution`, `computeSlashAdjustment`).
- `creditEarnings` best-effort credit side-effect.
- Content-addressing = idempotency (the no-CAS-safe property route-ledger relies on).
- The covenant/contract event ledger + route-ledger are ALREADY correct — left untouched.

## Witness (runnable, red→green)
`tests/ledger-lost-update.test.ts` — fire **N concurrent `recordAttribution`** with
distinct `execution_id`s for the **same indexer**, then assert the projected balance ==
**N × per-event credit** and `execution_count == N` (conservation under concurrency).
- RED on the current RMW accumulator (concurrent reads of the same blob lose credits).
- GREEN on the append-only event-log + projection (distinct keys, order-independent fold).
Plus an idempotency assertion: recording the same `execution_id` twice → balance counts it once.

## Steps
1. Write the failing witness against the current public API → confirm RED (lost update).
2. Rewrite `attribution.ts` record/read as append-event + projection (keep API + types).
3. Rewrite `fees.ts` the same way.
4. Witness GREEN; full `bun test` green; no route changes needed (API preserved).
5. Update docs (this plan + the ledger architecture note) to record the unified model.

## Out of scope
- Touching the contract/covenant/route/resolution ledgers (already correct).
- On-chain checkpointing, settlement-split unification (separate levers).
- Adopting aiko-engine3's single-binary architecture (category mismatch).
