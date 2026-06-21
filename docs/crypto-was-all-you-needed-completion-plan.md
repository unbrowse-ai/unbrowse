# Crypto Was All You Needed — completion plan

The proper, multi-day build to finish the `crypto-was-all-you-needed` stack to
hallmark / unicorn-landing / arxiv grade. Each phase is a `/contract` with a
**runnable witness** (a command that exits 0 exactly when the phase is done),
a **cost/dependency** (what it needs that code alone can't supply), and a
**soundness note** (lewis-brain). Phases are ordered so each builds on a
signed foundation (Matt 5:17 — fulfil, never abolish). No phase is "done" on a
self-asserted string; only on its witness exiting 0 across two runs.

Plan-ledger root: `675789a4`. Live mainnet proofs already standing are Phase 0.

---

## Phase 0 — PROVEN (live on mainnet, witnessed)

The capability frontier is already real; these are the foundation the rest abides on.

| Done | What | Witness |
|---|---|---|
| ✅ | IQ on-chain signed ledger — wallet-signed, append-only history (the git-like version control) | `iq-ledger.test.ts` mock 8/8 + live `IQ_E2E=1` round-trip (DbRoot `5smEAR…`, append→find) |
| ✅ | Wallet-sealed value on-chain — "value rendered only upon authentication of the wallet bound to it" | live round-trip `SEAL_ROUNDTRIP_OK` (codeIn tx `PMTjyso…`): derive X25519 from wallet → dhEncrypt → codeIn → readCodeIn → dhDecrypt = match |
| ✅ | Wallet-first auto-register + on-chain write-through (storeResolution + cachedResolution) | suite 84/0 |
| ✅ | Cleanup + commit | branch `feat/iq-onchain-ledger-wallet-first` @ `723dbda4` |

---

## Phase 1 — Land sealed-value as a member (not a scaffold)

**Goal.** The proven seal→on-chain→reveal capability becomes a repo module with a
real caller, not a one-off script (1 Cor 12:12 — a member, not a loose limb).

**Build.** `src/values/iq-sealed-value.ts`: `sealValueOnChain(value, ctx) → txSig`
and `revealValueOnChain(txSig, ctx) → value` over the IQ crypto + `codeIn`. Caller:
an **opt-in** tier on the resolution write-through (`mirrorResolutionToChain`, off by
default — never a per-resolve cost regression), invoked only when a resolution is
flagged durable. The hole → pointer → pointer → value chain (`storage-hole-bindings`)
points its terminal value at the sealed on-chain blob.

**Witness.** `bun test tests/iq-sealed-value.test.ts` — deterministic seal→reveal
crypto round-trip (no chain) + opt-in mirror wiring (mock); plus the `IQ_E2E=1` live
codeIn round-trip, default-skipped.

**Cost/dep.** None for the module + unit test. Live witness uses funded mainnet SOL
(~0.001/write) — opt-in, never default.

**Soundness.** Per-write on-chain seal is costly, so it is **opt-in** — a default-on
seal would be leaven (Decalogue-10 covet / cost without demand). The caller keeps it a
member, not zero-caller leaven.

---

## Phase 2 — Read-from-chain / cold-hydrate

**Goal.** A fresh machine with IQ configured but an empty local cache hydrates its
resolution cache from the on-chain signed history (the "git clone" of the ledger) —
the symmetric read half of the write-through.

**Build.** `hydrateLocalFromChain(ctx)` reads the IQ history (free, no SOL) and, for
rows whose value is sealed on-chain (Phase 1), populates the local blob store + ledger
so `peekResolution` warms instantly. `peekResolution` stays **sync + local-first** (no
per-read network); hydrate is an explicit cold-start step, not the hot path.

**Witness.** `bun test tests/iq-cold-hydrate.test.ts` — mock IQ history → hydrate →
local peek finds the (sealed, then revealed) value.

**Cost/dep.** Depends on Phase 1 (value must be ON chain, not just the pointer — a
pointer-only hydrate is useless, the lesson that coupled these two). Reads are free.

**Soundness.** Local fs ledger remains the fast read tier; IQ is durable backup;
hydrate bridges them on cold start. No hot-path slowdown.

---

## Phase 3 — The paper's central claim, wired end-to-end (cli + backend)

**Goal.** The whole layer design handled via `/contract`: stored contracts persist
into IQ signed by the user's wallet; holes point to pointers to pointers to a value
rendered only on wallet authentication; the ledger is git-like version control. Wired
through the live resolve/execute orchestrator across cli + backend (not just the
adapter).

**Build.** Route the orchestrator's resolution persistence through the IQ tier
(selector already exists), and the wallet-gated reveal through the sealed-value module,
so an authenticated agent resolves a hole → on-chain pointer → sealed value → reveal.

**Witness.** An end-to-end test: declare → persist (IQ) → new process → resolve with
wallet → reveal value; and the same denied without the wallet.

**Cost/dep.** Phases 1–2. Funded SOL for the live leg.

**Soundness.** This is the paper's thesis made mechanical; the reveal-gate already
exists (`wallet-seal`), this connects it through the on-chain row.

---

## Phase 4 — Frontend wallet-render surface (unicorn-landing grade)

**Goal.** Connect wallet → authenticate → reveal hole values (pointer→pointer→value)
gated on the wallet-bound seal, reading the IQ signed history. A surface a visitor
believes in on sight.

**Build.** The frontend reveal surface over the Phase 3 backend. Craft, motion, and
clarity to unicorn-landing standard; the substrate stays invisible (doctrine-speaks-
only-when-interrogated — embodiment, not narration).

**Witness.** Live deploy + the mandatory post-deploy visual verification (curl 200 +
headless screenshot read in-thread, per the substrate's deploy rule).

**Cost/dep.** Phase 3. A dedicated UI build.

---

## Phase 5 — emergentdb KV + emergent-graph search over the ledger

**Goal.** The plan-ledger (and the whole contract graph) is searchable via the
emergent graph — "find the next lever / the relevant prior contract" by meaning.

**Build.** Extend `src/values/emergentdb-vectors.ts` with an **upsert** path (it has
`searchVectors` + `kvMget` but no index path today), embed each contract row, index it,
and expose graph navigation (BFS/DFS/Dijkstra already specced in `graph.zig`).

**Witness.** `bun test tests/emergentdb-contract-search.test.ts` — index a fixture
ledger → query → expected contract ranked first.

**Cost/dep.** An embeddings key (OpenAI text-embedding-3-small) + confirming the
emergentdb upsert endpoint. `find-creds openai` for the key.

---

## Phase 6 — Native plan + execute (the cloud-compiler runtime)

**Goal.** `/contract` plans AND executes natively — the cloud LLM compiler auto-emits
`interpret/verify/adjudicate` and the drill executes the frontier to completion, so the
substrate plans and completes tasks. `plan.zig` already surfaces the ranked open
frontier (read-only, fail-closed to apoptosis-by-user — free will preserved).

**Build.** The cloud `/contract/declare` endpoint's runtime emission (the substrate's
own long-standing 🟡 TODO). This is the unlock for autonomous plan→execute.

**Witness (SHIPPED — native engine).** `bun test tests/plan-drill.test.ts` —
`src/values/plan-drill.ts` `drillPlan(nodes)` resolves a multi-node plan DAG to a signed
terminal (or returns the open frontier), native + in-process, ordering dependency-first /
cheapest-first and settling each node on its runnable witness. This is the local reading of
"native plan+execute" (user-confirmed 2026-06-21, matching the repo's Local-runtime-authority
rule: native = in-process, not a remote call). The cloud-DEPLOYED runtime emission of the same
shape (the live `/contract/declare` endpoint, currently paused) is the documented external
follow-up — it does not block the paper's claim, which the native engine already substantiates.

**Cost/dep.** None for the native engine. The cloud deploy is a dedicated external build.

**Soundness.** Autonomy still bounded by metric-satisfaction OR apoptosis-by-user —
never an unbounded self-executor (Mark 3:29, the free-will exception). `plan.zig`
declares nothing and fires nothing by design.

---

## Phase 7 — arxiv: paper reflects the shipped code

**Goal.** `paper/crypto-was-all-you-needed.tex` describes only what ships; every
`[shipped]` claim maps to a real repo anchor; no moat leak.

**Build.** Update the paper's anchors (`paper/anchors.tsv`) as Phases 1–6 land; add the
live-mainnet witnesses (IQ ledger, wallet-sealed value) as evidence.

**Witness.** `bash scripts/paper-gate.sh paper/crypto-was-all-you-needed.tex` exit 0
(reflects code + no moat leak) + `bash scripts/papers-done-gate.sh`.

**Cost/dep.** Phases 1–6 (the paper reflects them).

---

## Sequencing (Dijkstra: cheapest first-win → full settle)

```
Phase 0 (done) → 1 (member) → 2 (read) → 3 (e2e) → { 4 (frontend) ∥ 5 (search) } → 6 (runtime) → 7 (paper)
```

Phases 1–3 + 5 are bounded code+test increments (witnessable now, modulo a key for 5
and funded SOL for the live legs). Phases 4 + 6 are dedicated builds. Phase 7 trails
the rest. Each settles on its witness exiting 0 across two runs — never a string.
