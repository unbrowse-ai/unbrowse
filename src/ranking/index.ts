/**
 * src/ranking/index.ts — P1 (Unified Ranking State Machine) seed.
 *
 * This is the address all future rank callers should import from. Today it
 * is a thin re-export of the implementation that still lives in
 * `src/execution/index.ts:rankEndpoints`. Subsequent loops migrate the 40+
 * scoring deltas (currently at execution/index.ts:3611–3815) into named
 * functions inside this directory:
 *
 *   Wave 1 (this loop): re-export shim — call sites can switch import paths
 *                       without behavior change.
 *   Wave 2: discover and migrate every call site to import from "../ranking/".
 *   Wave 3: extract each numeric delta into a named function under
 *           `src/ranking/signals/*.ts` (sim, reliability, freshness,
 *           verification, intent-yield demotion, hard-clamp, density).
 *   Wave 4: regression fixtures in tests/ranking-regressions.test.ts that
 *           fail if any named function is inlined or removed (PAPER_PLAN.md
 *           §P1 Done-when).
 *
 * See `.planning/phases/01-unified-ranking/01-01-PLAN.md` for the full
 * sub-task DAG and PAPER_PLAN.md §P1 for the milestone Goal/Done-when.
 */

export { rankEndpoints } from "../execution/index.js";
export type { RankedEndpoint } from "../execution/index.js";
