# harness/agent-xp — meta-fractal API bench harness (CONTRACT-SHAPED)

Per standing rule `6f30ade6` (no-shell-scripts-use-contract-only) and contract
`ca14417c` (meta-fractal-harness-is-a-cloud-contract-DAG), the agent-xp bench
is **NOT** a bag of shell scripts. It is a DAG of contract-neurons mirroring
the EXACT shape of the Zig substrate (`zig/src/main.zig` declared rows) but
applied to **API endpoints instead of code**.

The bash scripts that lived here through wave-17 have been retired to
`.conductor/unbrowse-100/retired-scripts/agent-xp/` for historical reference.

## Shape (recursive, same at every layer)

Each axis is one parent contract-neuron with 1+ child probe-neurons:

```
contract:ca14417c              <-- meta-fractal harness parent
├── contract:99ffe53d  AXIS-1 PASSIVE_INDEX_SPEED
├── contract:8fc0e22e  AXIS-2 RESOLVE_LATENCY
├── contract:c3552aa1  AXIS-3 RESOLVE_DAG_WALK_ACCURACY
├── contract:019403c9  AXIS-4 EXECUTE_SUCCESS               <-- currently 96.6%
├── contract:e37c66a1  AXIS-5 MARKETPLACE_HIT_RATE          <-- currently 22.9% FAIL
├── contract:00d84417  AXIS-6 AUTH_HANDOFF_QUALITY
├── contract:73eeb32e  AXIS-7 ANTIBOT_BYPASS
├── contract:5cdc47c1  AXIS-8 CONCURRENCY_HONESTY           <-- PASS 0.1pp
├── contract:32d5eaa6  AXIS-9 ROUND_TRIP_FRESHNESS          <-- PASS identical-body
└── contract:1af4af70  AXIS-10 WALLCLOCK_BUDGET             <-- PASS p99=1238ms
```

Each axis declares its own probe-children (e.g. AXIS-4 has 35 children, one
per probe URL). Probe children carry an `action` field naming the HTTP call.

## How to fire

```
contract iterate ca14417c
```

The substrate fans out per `parent_id` lineage, executes each probe-neuron's
action (HTTP call), records `iterated` events into the ledger, fires
posthook contracts when satisfaction thresholds met.

Local: `env -u UNBROWSE_API_KEY contract iterate ca14417c`
Cloud: same shape, server-side at `beta-api.unbrowse.ai`.

## Why this shape

Per `6f30ade6` standing rule:

1. **No semantic duplication** — the substrate already canonicalizes truth-
   claim + action + lineage + signed ledger row + posthook chain.
2. **No drift** — bash scripts diverge silently; contract rows are signed.
3. **Native composition** — `parent_id` / prehook / posthook enforce gate
   ordering. The substrate fires children when parent fires.
4. **Same shape at every layer** — atom → cell → tissue → organ → organism.
   The Zig substrate (local, code-level), the agent-xp harness (API-level),
   and the staging-then-prod gate (`bd4b9715`) all use the SAME neuron shape.

## Current measurement (last full run 2026-05-25T14:07:42Z)

| Axis | Verdict | Metric | Target |
|---|---|---|---|
| CONCURRENCY_HONESTY | PASS | 0.1pp | <5pp |
| ROUND_TRIP_FRESHNESS | PASS | identical-body | identical-body |
| WALLCLOCK_BUDGET | PASS | p99=1238ms | ≤35000ms |
| RESOLVE_LATENCY | PARTIAL | p50=450ms p99=480ms | p50<300ms p99<1500ms |
| EXECUTE_SUCCESS | PARTIAL | 96.6% | ≥99% |
| MARKETPLACE_HIT_RATE | FAIL | 22.9% | ≥50% |
| PASSIVE_INDEX_SPEED | NOT_IMPLEMENTED | — | ≥5 dom/min |
| RESOLVE_DAG_WALK_ACCURACY | NOT_IMPLEMENTED | — | ≥80% |
| AUTH_HANDOFF_QUALITY | NOT_IMPLEMENTED | — | 0 ambiguous |
| ANTIBOT_BYPASS | NOT_IMPLEMENTED | — | ≥80% |

**Open fix-target contracts**:
- `fb653c19` MAKE-RESOLVE-FASTER (closes AXIS-2)
- `82c5e6c9` FIX-MARKETPLACE-HIT-RATE-VIA-DAG (closes AXIS-5)
- `c91adb95` Layer-3 byte-level Chrome OR `ae42fba7` x402 residential proxy (closes AXIS-7)
- `b5245716` DAG-walk resolve output shape (closes AXIS-3, lifts AXIS-5)
- `bbe92ca2` Layer-5 capture pipeline (closes AXIS-1)

## Runtime executor (the missing piece)

Today the contract substrate declares + signs rows but does not yet execute
HTTP actions natively. The runtime executor that walks contract-neuron DAGs
and fires their actions lives at `beta-api.unbrowse.ai` (cloud) — currently
`/v1/contract/declare` and `/v1/contract/iterate` accept neuron rows but
execution-side wiring for HTTP actions is the next-wave work.

Until then, the local CLI `contract` binary handles declare/iterate against
the local ledger; HTTP action execution is the open seam.
