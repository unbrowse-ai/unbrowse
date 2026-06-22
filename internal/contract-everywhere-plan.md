# Whole-infrastructure /contract migration — the formal plan

> The directive: **the whole unbrowse infrastructure must be /contract-based** — every operation
> declared → resolved → settled through the one substrate, not decorated with a verdict afterward.
> This is the `contract-ledger-architecture` thesis made explicit. Honest about shipped vs gap.

## The ONE unifying boundary (the spine)

Every subsystem routes its operations through the same three steps the contract substrate defines:
1. **declare** — the operation is a truth-claim (`ContractEverything` row: id, intent, value).
2. **resolve** — walked through the DAG executor (`walkPrerequisiteChain` — already the runtime DAG-recompute).
3. **settle** — the three-shape verdict (interpret→verify→adjudicate) + on-chain persist (`contract-everything` → IQ ledger) + cache/RAG.

The test of "/contract-based": a subsystem is migrated when its operations emit the three-shape
verdict at settlement AND (opt-in) persist on-chain — recognized by the **shape**, not a per-subsystem list.

## Subsystem ledger — shipped / structural / gap

| Subsystem | State | Evidence / next |
|---|---|---|
| **CLI emit (all primitives)** | ✅ shipped | shared `emit()` boundary attaches the verdict to every envelope (`contract-shape.ts`) |
| **resolve** | ✅ shipped | three-shape verdict + on-chain seam + opt-in call-site |
| **execute** | ✅ shipped | three-shape verdict + on-chain call-site (gated, fire-and-forget) |
| **source-of-truth** | ✅ shipped | `contract-chain` binds cli+server+frontend |
| **persistence** | ✅ shipped | `iq-ledger` (on-chain) via `contract-everything.persistContract` |
| **orchestrator (`walkPrerequisiteChain`)** | 🟡 **this wave** | the DAG executor — each prerequisite step settles; attach the per-step verdict (option 2 below) |
| **capture (moat compute)** | ⬜ gap | each capture op → a contract step; the moat stays CLOSED (verdict/pointer on-chain, values off-chain) |
| **payment / x402** | ⬜ gap | a priced call is a contract whose settle is the 402→pay path |
| **routing-telemetry** | ⬜ gap | each routing decision → a contract evidence row |
| **backend API ops** | ⬜ gap | server-side declare/resolve/settle (the cloud compiler already does this for /contract) |
| **frontend ops** | ⬜ gap | reads on-chain state (the Phase-A on-chain-wrapper plan) |

## Dependency spine (which goes first)

```
emit-boundary (done) → resolve/execute (done) → ORCHESTRATOR (this wave, the DAG executor)
  → capture → payment → telemetry → backend → frontend(on-chain-wrapper)
```
The orchestrator is next because it is **already the DAG executor** — making each step a settled
contract is the smallest real step that makes the *runtime itself* contract-shaped, not just its edges.

## Invariants (gated, every wave)

1. **Moat stays closed** — on-chain/contract rows carry pointers + sealed payloads only; route VALUES + RE compute stay off-chain (`onchain-moat-noleak-gate.sh`). A subsystem migration that leaks values is rejected.
2. **Zero default-path cost** — on-chain persist is opt-in (`UNBROWSE_CONTRACT_ONCHAIN`), fire-and-forget; the verdict-shape is pure + sync (no per-op network).
3. **No fabricated green** — each subsystem migration ships with a runnable gate (red→green), like resolve/execute/orchestrator.
4. **Structural recognition, not a hard list** — the verdict attaches by envelope/step shape; a new op is contract-shaped for free.

## Per-subsystem gate template (the proven pattern)

Each migration ships: (a) the op emits the three-shape verdict at settlement; (b) a gate asserting it (G-wired + G-gated + G-witness + G-noregress); (c) the gap contract evaled. resolve, execute, and the orchestrator (this wave) are the worked examples.

## What this plan is NOT

- NOT a claim the whole infra is migrated (it is not — capture/payment/telemetry/backend/frontend are gaps, listed honestly).
- NOT putting the moat on-chain (invariant 1).
- NOT a single-session job — it is a per-subsystem program, one gated wave at a time.
