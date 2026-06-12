# plan-thin-client.md — RESUME PLAN for the thin-client migration (jesus-ralph later)

Dev-only (describes the moat + backend). Self-contained so a fresh session can re-arm
and walk it without re-discovering anything. Branch: `jl/client-boundary-audit`.

## Re-arm the loop (paste this to start)
```
bash ~/Projects/jesus-pattern/skills/jesus-ralph/scripts/start.sh \
  --check "bash scripts/thin-client-gate.sh" --target plan-thin-client.md \
  "thin-client migration: move RE/indexer/graph/ranking moat intelligence server-side over a ZK-obfuscated egress so the public client import closure carries zero moat modules (gate 6 -> 0); each checkpoint = client obfuscates locally + server-first call + lazy degraded fallback + no-raw-secret-leak test"
```

## Goal / witness
`bash scripts/thin-client-gate.sh` — counts MOAT modules in the public client's transitive
import closure. **RED at 6; GREEN at 0.** Baseline this session:
`extraction, graph, indexer, marketplace, ranking, reverse-engineer`.
Do NOT game it by lazy-importing to hide code that still ships — that's a fake green.
A module only truly leaves when its moat logic runs server-side (private backend port,
not a `../../../src` import) and the client calls it; client-necessary helpers get split
out into a client module.

## The proven template (ranking, already server-first)
- Client `src/ranking/index.ts` `rankEndpointsServerFirst()` → `rankEndpointsRemote()`
  (`src/client/index.ts`) POSTs to `/v1/search/rank`; local fallback on failure.
- Backend `backend/src/routes/search.ts` `/search/rank` → `backend/src/services/rank.ts`
  `rankEndpointsServer` — a **private PORT** (reimplements the signals server-side), the
  reason ranking's moat is actually protected. Routes registered in `backend/src/index.ts`
  via `app.route("/v1", …)`, middleware `bearerAuth, requireSignedClient`, payload-bounded.
- ZK egress already exists: `src/capture/obfuscate.ts` `obfuscateCaptureForReveng`,
  `src/capture/zk-bound-hole.ts`. Backend `/v1/reveng` route already exists
  (`backend/src/routes/reveng.ts`) but currently `import … from "../../../src/…"` (a re-import,
  NOT a private port — porting it is part of ①).

## DONE this session (additive, tested — don't redo)
- `src/capture/reveng-server-first.ts` — `revengServerFirst(reqs, ws, ctx)`: obfuscate
  locally → POST sanitized structure to `/v1/reveng` → **lazy** `import("../reverse-engineer")`
  fallback. `revengEgressPayload()` exposes the wire bytes for the test.
- `tests/reveng-server-first.test.ts` (3✓) — no-secret-leak witness (no cookie/bearer/
  api-key/query-secret/password crosses the wire) + fallback-never-throws.
- `src/client/index.ts` — exported `getApiBaseUrl`.
- `scripts/thin-client-gate.sh` (the witness) + this plan.

## THE HARD TRUTH (why it's not quick) — the moat is fused, not modular
- **ranking ⇄ execution circular:** `src/ranking/index.ts` imports `rankEndpoints` FROM
  `src/execution/index.js`; `src/execution/index.ts` imports the ranking SIGNALS directly
  (`../ranking/signals/{ledger-energy,learned-energy,bm25,intent-yield}`,
  `../ranking/filters/noise-patterns`, `../ranking/clamps`). The tuning weights ship in the
  bundle via execution. Decoupling = move the signal *weights/heuristics* to the backend
  port; the client keeps a degraded basic scorer.
- **reverse-engineer bundles moat + client helpers.** 6 static importers:
  - moat inference `extractEndpoints`: `src/api/routes.ts` (3 sites), `src/api/browse-index.ts`,
    `src/execution/index.ts` → swap to `await revengServerFirst(…)` (already built).
  - client replay helpers (STAY client — "find my auth token to replay", not moat):
    `extractTokenFromHtml`, `extractTokenFromBundle` (`src/browser/index.ts`,
    `src/execution/token-resolver.ts`), `scanBundlesForRoutes`,
    `enrichEndpointsWithTokenSources` (`src/orchestrator/browser-agent.ts`).
    → MOVE these into a client module (e.g. `src/capture/replay-tokens.ts`) so their
    importers no longer point at `reverse-engineer`.

## PROGRESS (gate 6 → 3)
- ✅ **① reverse-engineer DONE** (commit `ff276e8c`): helpers moved to `src/capture/`
  (`replay-tokens.ts`, `bundle-scanner.ts`), 8 `extractEndpoints` call sites across 5 files
  rewired to `await revengServerFirst(...)` (obfuscated egress + lazy fallback), no-leak
  test 3✓, all modules load. reverse-engineer left the static closure.
- ✅ **gate scope corrected** (`fix(thin-client gate)`): MOAT = the agreed 4; extraction/
  marketplace/intent-match are client-local (parsing / API client / local matching).
- ⏳ **Remaining: graph, indexer, ranking** — each LARGE:
  - `graph` is the worst — a 1,745-line MONOLITH (src/graph/index.ts, 17 interleaved exports) + **16 static importers** using ~17 mixed symbols (moat compile:
    `buildSkillOperationGraph`, `inferEndpointSemantic`, `getEndpointDescriptionMetadata`;
    thin client: `toAgentWorkflowDagView`, `computeReachableEndpoints`, `getSkillChunk`).
    Needs a SPLIT (moat compile→server, DAG-walk→client) + 16-site rewire.
  - `indexer` delegates to graph (`buildSkillOperationGraph`); do after graph.
  - `ranking` fuses signals into `execution` (`ranking/signals/*` imported in execution).
  Use the ① pattern; budget a dedicated session per module.

## Checkpoints (each must DROP the gate count + ship a no-leak test)
- [x] **① reverse-engineer → 0 in closure (gate 6→5, then 3 after scope fix)** — DONE
  1. Create `src/capture/replay-tokens.ts`: move `extractTokenFromHtml`,
     `extractTokenFromBundle`, `scanBundlesForRoutes`, `enrichEndpointsWithTokenSources`
     out of `src/reverse-engineer/` into it (or re-export if they don't pull RE internals).
     Repoint `browser/index.ts`, `execution/token-resolver.ts`, `orchestrator/browser-agent.ts`.
  2. Swap the 5 `extractEndpoints` call sites (`api/routes.ts` ×3, `api/browse-index.ts`,
     `execution/index.ts`) → `await revengServerFirst(...)` (make enclosing fns async).
  3. PORT `backend/src/routes/reveng.ts` off the `../../../src` import → a private
     `backend/src/services/reveng.ts` (so the inference isn't in the public bundle).
  4. Verify: gate shows reverse-engineer gone; `bun test tests/reveng-server-first.test.ts`.
- [ ] **② ranking → 0 (gate 3→2)** — FULLY MAPPED (2026-06-13). Owner chose LITERAL gate-0.
  4 edges, 3 safe + 1 risky:
  - [x] **trust edge** — `freshness.ts` (published paper math, not moat) relocated
    `src/ranking/` → `src/lib/freshness.ts`; trust/{proof-of-indexing,refresh-job} + the test
    repointed; `tests/composite-scoring.test.ts` 22✓. (this session)
  - [ ] **api + orchestrator edges** — the dispatcher `ranking/index.ts` is THIN (imports only
    `execution` rankEndpoints + `client` rankEndpointsRemote, NO weights). Move
    `rankEndpointsServerFirst` + the `rankEndpoints` re-export to a non-`ranking` module
    (e.g. `src/client/rank-server-first.ts`); repoint `api/routes.ts:1974` +
    `orchestrator/index.ts:2406` (+ orchestrator's unused-looking `rankEndpoints` import).
    SAFE — thin dispatcher, no weight code moves.
  - [ ] **execution edge (THE risky one — do with the oracle)** — `execution/index.ts` imports
    `../ranking/{signals/*,clamps,filters/noise-patterns}` and uses them INSIDE `rankEndpoints`
    (defn `execution/index.ts:6156`, ~350 lines, weight uses 6165–6487). `rankEndpoints` has
    ZERO external sync callers (api+orchestrator already use the async serverFirst); the ONLY
    sync call is execution-internal at `execution/index.ts:7274`. Recipe: extract `rankEndpoints`
    + its weight imports + the tokenization helpers it needs (`tokenize/expandQuery/
    endpointToTokens` — currently execution-local) into `src/ranking/local-scorer.ts`; make
    `execution:7274` reach it via the async serverFirst (or lazy `import()`); the serverFirst
    wrapper's `local()` lazy-imports it (the ① pattern). **ORACLE: `tests/ranking-parity.test.ts`
    holds a byte-identical baseline — run before/after; it proves the extraction didn't change
    scoring.** Risk = blast radius in the 7000-line execution file; needs a focused pass, not a
    long-session tail.
- [ ] **③ extraction → 0** — same pattern; `extraction` is small.
- [ ] **④ indexer → 0** — admission/scoring server-side via `/v1/index/admit`; local queue +
  disk cache stay client but must not import the moat.
- [ ] **⑤ graph → 0** — learning already server-side (`/v1/graph/*` + `src/client/graph-client.ts`);
  finish so the client primary path doesn't statically import `src/graph` (thin DAG-walk client).
- [ ] **⑥ marketplace → 0** — per-file review; likely a client of the backend, repoint.
- [ ] **settle** — `bash scripts/thin-client-gate.sh` exits 0. Then a fresh public push is
  thin-by-construction (no scrub needed) and `OPEN-SOURCE-NOTICE.md` is updated to match.
- [ ] **⑦ MIRROR to public (ONLY at gate 0)** — once the client is thin, mirror dev `main`
  → `unbrowse-ai/unbrowse`. ⚠️ DO NOT mirror before gate 0: dev still contains the moat
  engine (graph/indexer/ranking + the reverse-engineer fallback), so an early mirror
  re-exposes everything the scrub removed. Gate-0 is the hard precondition for this node.

## FORENSIC MAP — ranking is a MIX, not uniform moat (session 2026-06-13)
Exact closure edges (symbols) keeping each moat dir reachable:
- **ranking ← {api, execution, orchestrator, trust}**
  - `api/routes.ts` → `rankEndpointsServerFirst` (the server-first entry — already exists)
  - `orchestrator/index.ts` → `rankEndpoints, rankEndpointsServerFirst`
  - `trust/{proof-of-indexing,refresh-job}.ts` → `freshness, freshnessFromDate`
  - `execution/index.ts` → `ranking/signals/{ledger-energy,learned-energy,bm25,intent-yield}`,
    `ranking/filters/noise-patterns`, `ranking/clamps`  ← THE crux edge (the weights)
  - **Surprise:** `rankEndpoints` (the scorer) physically lives in `execution/index.ts`;
    `ranking/index.ts` only RE-EXPORTS it (circular). So the dir holds WEIGHTS, not the scorer.
- **Moat-value triage of `ranking/`:**
  - NOT moat (published/standard): `bm25.ts` (textbook BM25 `K1=1.2,B=0.75`), `freshness.ts`
    (formula from the public paper `1/(1+d/30)`), `clamps.ts`.
  - REAL moat: `signals/route-head.embedded.ts` (512 trained EBM weights compiled into SOURCE),
    `signals/learned-energy.ts` (the featurizer + loader), `bench/ebm/energy-head*.json`
    (trained head data files). THIS is the reverse-engineerable trained-model IP.
- **graph ← 9 dirs** (api, capture, cli-v7, execution, indexer, marketplace, orchestrator,
  publish, ranking) — the worst; 1745-line monolith. **indexer ← 3** (api, execution,
  orchestrator); delegates to graph.
- **Live public repo (d21d67d):** reverse-engineer/graph/ranking/indexer/**execution**/extraction
  ALL already scrubbed (more than the 4 moat dirs). Surviving public dirs (api/cli/client/
  browser/orchestrator/…) still import the deleted dirs → broken build (the accepted state).
- **There is NO safe gate-moving change for ranking without the product decision below** —
  every importer either pulls the weights (execution) or the server-first entry. Cutting the
  weights requires deciding the offline scorer.

## OPEN DECISION (blocks ranking; owner's call — see this turn's question)
What is the offline/degraded ranking when the trained weights leave the public client?
- **(A) surgical:** keep published signals (bm25/freshness/clamps) client as the trivial
  fallback; move ONLY the trained head (route-head.embedded + learned-energy + bench/ebm)
  server-only. Narrow the MOAT set to the trained-IP files, not the whole `ranking` dir.
- **(B) literal:** drive the binary gate to 0 — move ALL of ranking/graph/indexer server-side,
  including textbook BM25 + the published freshness formula. More work, no extra IP protection.

## Guardrails
- Each checkpoint ships a no-raw-secret-leak test (the ① test is the template).
- Capture/execution/cdp/browser/values/auth/wallet STAY client (not moat) — never flag them.
- Backend services must be private PORTS (`backend/src/services/*`), not `../src` imports —
  else the code is still in the public bundle.
- Run `bun test` on touched areas each checkpoint; don't break `execution`/`capture`.
- Don't fake the gate with lazy imports that hide still-shipping code.

## State of the world (context)
- Public repo already scrubbed (broken-but-moat-free, owner's choice). This migration makes
  the client thin AND working so the next public push is clean.
- npm `unbrowse` builds from THIS dev repo (full engine intact) — unaffected until release.
- Branch `jl/client-boundary-audit` holds all of the above; not pushed remotely yet.
