/**
 * Witness for the ledger unification (LEDGER-UNIFICATION-PLAN.md).
 *
 * The economic ledgers must CONSERVE credits under concurrency. The old
 * read-modify-write accumulator on a CAS-free KV silently loses concurrent
 * updates (all readers see the same balance, last writer wins). The append-only
 * content-addressed event-log + projection model conserves all of them
 * (distinct keys, order-independent fold) and is idempotent per execution_id.
 *
 * RED on the RMW accumulator, GREEN on the event-log + projection.
 *   bun test backend/tests/ledger-lost-update.test.ts
 */
import { describe, it, expect } from "bun:test";
import {
  recordAttribution,
  getIndexerLedger,
  BASE_FEE_UC,
  DELTA_BONUS_UC,
} from "../src/services/attribution.js";
import {
  recordGraphFee,
  getAgentFeeLedger,
  GRAPH_OPERATION_COST_UC,
} from "../src/services/fees.js";
import type { Env } from "../src/types.js";

const env = { ENVIRONMENT: "local-dev" } as unknown as Env;
let seq = 0;
const uniq = (p: string) => `${p}-${Date.now()}-${seq++}`;

describe("ledger conservation under concurrency (lost-update witness)", () => {
  it("attribution: N concurrent credits for one indexer conserve ALL (no lost update)", async () => {
    const N = 25;
    const indexer = uniq("indexer-conc");
    // delta=1 (reliability 1.0 vs next-best 0.0) → identical fee = BASE+BONUS each.
    await Promise.all(
      Array.from({ length: N }, (_, i) =>
        recordAttribution(env, {
          execution_id: uniq(`exec-${i}`),
          skill_id: "s",
          endpoint_id: "e",
          indexer_id: indexer,
          reliability_score: 1.0,
          next_best_score: 0.0,
        }),
      ),
    );
    const ledger = await getIndexerLedger(env, indexer);
    expect(ledger).not.toBeNull();
    expect(ledger!.execution_count).toBe(N);
    expect(ledger!.total_credited_uc).toBe(N * (BASE_FEE_UC + DELTA_BONUS_UC));
  });

  it("attribution: idempotent — the same execution_id counts once", async () => {
    const indexer = uniq("indexer-idem");
    const ev = {
      execution_id: uniq("dup-exec"),
      skill_id: "s",
      endpoint_id: "e",
      indexer_id: indexer,
      reliability_score: 1.0,
      next_best_score: 0.0,
    };
    await recordAttribution(env, ev);
    await recordAttribution(env, ev); // replay of the SAME execution
    const ledger = await getIndexerLedger(env, indexer);
    expect(ledger!.execution_count).toBe(1);
    expect(ledger!.total_credited_uc).toBe(BASE_FEE_UC + DELTA_BONUS_UC);
  });

  it("fees: N concurrent charges for one agent conserve ALL", async () => {
    const N = 20;
    const agent = uniq("agent-conc");
    const cost = GRAPH_OPERATION_COST_UC.search; // cost is derived from the operation
    await Promise.all(
      Array.from({ length: N }, () =>
        recordGraphFee(env, agent, "search"),
      ),
    );
    const ledger = await getAgentFeeLedger(env, agent);
    expect(ledger).not.toBeNull();
    expect(ledger!.event_count).toBe(N);
    expect(ledger!.total_charged_uc).toBe(N * cost);
  });
});
