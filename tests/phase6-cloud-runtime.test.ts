/**
 * Phase 6 witness — native cloud-runtime plan+execute (crypto-was-all-
 * you-needed completion plan, docs/crypto-was-all-you-needed-completion-plan.md).
 *
 * Proves the cloud /contract/declare runtime, on REAL code paths
 * (the same functions executeDeclare calls):
 *   1. a substantive root declare auto-emits the interpret/verify/adjudicate
 *      three-shape children (the trinity floor) — NO LLM API key required.
 *   2. the drill resolves that multi-node plan to a SIGNED TERMINAL
 *      (adjudicate satisfied, after both siblings settle — Genesis order).
 *   3. it is BOUNDED one level deep (a child declare does NOT re-fan).
 *   4. system/eval-grammar plans (satisfied:/decalogue:/iterate:) do NOT fan out.
 *
 * No mocks of the substrate — a real in-memory ContractLedger drives the
 * real handlers. Run twice for the two-witness rule (deterministic).
 */
import { describe, expect, test } from "bun:test";
import type {
  ContractEventRow,
  ContractLedger,
} from "../backend/src/services/contract-ledger";
import {
  declareWithTrinityRuntime,
  emitTrinityChildren,
  drillResolveTrinity,
  shouldFanoutTrinity,
} from "../backend/src/routes/contract";

function inMemoryLedger(): ContractLedger {
  const rows: ContractEventRow[] = [];
  return {
    async append(row) {
      const stamped = { ...row, ts: row.ts || new Date().toISOString() };
      rows.push(stamped);
      return stamped;
    },
    async get(id) {
      const hit = rows.filter((r) => r.id === id);
      return hit.length ? hit : null;
    },
    async listAll() {
      return rows.slice();
    },
    async listChildren(parentId) {
      return rows.filter((r) => r.parent_id === parentId);
    },
  };
}

describe("Phase 6 — native cloud-runtime plan+execute", () => {
  test("root declare auto-emits the three-shape children (no API key)", async () => {
    const ledger = inMemoryLedger();
    const res = await declareWithTrinityRuntime(
      { plan: "ship the wallet-gated reveal surface end to end", action: "agent-judges" },
      ledger,
    );
    const shapes = res.child_rows.map((r) => r.plan?.split(":")[0]).sort();
    expect(shapes).toEqual(["adjudicate", "interpret", "verify"]);
    // every child is parented to the root
    for (const ch of res.child_rows) expect(ch.parent_id).toBe(res.id);
  });

  test("drill resolves the multi-node plan to a SIGNED TERMINAL", async () => {
    const ledger = inMemoryLedger();
    const res = await declareWithTrinityRuntime(
      { plan: "resolve a hole to an on-chain sealed value and reveal it", action: "agent-judges" },
      ledger,
    );
    // the runtime evidence must report the terminal
    expect(res.runtime_evidence).toContain("SIGNED TERMINAL");
    // and the adjudicate child must carry a satisfied terminal event
    const adjudicate = res.child_rows.find((r) => r.plan?.startsWith("adjudicate:"))!;
    const adjRows = (await ledger.get(adjudicate.id)) ?? [];
    expect(adjRows.some((r) => r.event === "satisfied")).toBe(true);
    // and so must both siblings (the drill settled them first — Genesis order)
    for (const shape of ["interpret", "verify"]) {
      const ch = res.child_rows.find((r) => r.plan?.startsWith(`${shape}:`))!;
      const rws = (await ledger.get(ch.id)) ?? [];
      expect(rws.some((r) => r.event === "satisfied")).toBe(true);
    }
  });

  test("bounded one level deep — a child declare does NOT re-fan", async () => {
    const ledger = inMemoryLedger();
    const child = await declareWithTrinityRuntime(
      { plan: "interpret:abcd1234 — some sub-claim", action: "agent-judges", parent_id: "abcd1234" },
      ledger,
    );
    expect(child.child_rows).toEqual([]);
    expect(child.runtime_evidence).toBeUndefined();
  });

  test("eval-grammar + system plans do NOT fan out", () => {
    expect(shouldFanoutTrinity("satisfied:abcd1234 wave=1 — proof", undefined)).toBe(false);
    expect(shouldFanoutTrinity("decalogue:purge:3 all", undefined)).toBe(false);
    expect(shouldFanoutTrinity("iterate:abcd1234 — wave", undefined)).toBe(false);
    expect(shouldFanoutTrinity("interpret:x — y", undefined)).toBe(false);
    expect(shouldFanoutTrinity("x", undefined)).toBe(false); // too thin
    // a real claim DOES fan out
    expect(shouldFanoutTrinity("complete the cloud runtime emission", undefined)).toBe(true);
  });

  test("emit + drill primitives compose deterministically", async () => {
    const ledger = inMemoryLedger();
    const parentId = "deadbeef";
    await ledger.append({
      event: "declared",
      id: parentId,
      ts: new Date().toISOString(),
      plan: "a real truth claim worth decomposing",
      action: "agent-judges",
    });
    const children = await emitTrinityChildren(parentId, "a real truth claim worth decomposing", ledger);
    expect(children).toHaveLength(3);
    const drill = await drillResolveTrinity(
      parentId,
      "a real truth claim worth decomposing",
      children,
      ledger,
    );
    expect(drill.child_ids).toHaveLength(3);
    expect(drill.terminal.event).toBe("satisfied");
    expect(drill.evidence.some((e) => e.includes("SIGNED TERMINAL"))).toBe(true);
  });
});
