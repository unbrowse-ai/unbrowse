import { test, expect } from "bun:test";
import type { SkillManifest } from "../src/types";
import type { ContractEventRow, ContractLedger } from "../src/services/contract-ledger";
import { persistSkillContract } from "../src/services/skill-contract-persist";
import { makeSkill } from "./fixtures/skill";

// Witness for Layer 2 (step 3 seed): a resolved skill persists into the contract
// ledger as 1 parent + N child rows, parity with compiled-contract persistence,
// child.action carrying the real endpoint execute pointer. Hermetic — in-memory
// ledger, no env, no network (mirrors tests/contract-routes.test.ts memLedger).

function memLedger(): ContractLedger & { rows: ContractEventRow[] } {
  const rows: ContractEventRow[] = [];
  return {
    rows,
    async append(row) {
      const stamped = { ...row, ts: row.ts || new Date().toISOString() };
      rows.push(stamped);
      return stamped;
    },
    async get(id) {
      const hit = rows.filter((r) => r.id === id);
      return hit.length ? hit : null;
    },
    async listAll() { return rows.slice(); },
    async listChildren(parentId) { return rows.filter((r) => r.parent_id === parentId); },
  } as ContractLedger & { rows: ContractEventRow[] };
}

const FIXTURE: SkillManifest = makeSkill();

test("persistSkillContract writes 1 parent + N child rows with correct chaining", async () => {
  const ledger = memLedger();
  const declared: ContractEventRow[] = [];
  const deps = {
    ledger,
    // the route wires this to handleDeclare; here it appends the parent row + returns its id
    declareParent: async (req: { plan: string; action: string }) => {
      const row: ContractEventRow = { event: "declared", id: "parent_skill_acme_123", ts: "", plan: req.plan, action: req.action, parent_id: undefined, visibility: "lineage" };
      declared.push(await ledger.append(row));
      return row.id;
    },
  };

  const result = await persistSkillContract(deps, FIXTURE);

  expect(result.child_count).toBe(2);
  expect(result.parent_id).toBe("parent_skill_acme_123");
  // 1 parent + 2 children landed in the ledger
  expect(ledger.rows.length).toBe(3);
  const parent = ledger.rows[0];
  const children = ledger.rows.slice(1);
  // parent is the skill truth claim, action = the skill contract pointer
  expect(parent.action).toBe("contract:skill/skill_acme_123");
  // every child chains to the parent
  expect(children.every((r) => r.parent_id === "parent_skill_acme_123")).toBe(true);
  // child.action carries the real endpoint EXECUTE pointer (after its kind — not "agent-judges")
  expect(children[0].action).toBe("contract:skill/skill_acme_123/endpoint/ep_search");
  expect(children[1].action).toBe("contract:skill/skill_acme_123/endpoint/ep_detail");
  // deterministic, content-addressable child ids (idempotent re-persist)
  expect(children[0].id).toBe("skill-contract:skill_acme_123:ep_search");
});

test("persistSkillContract is idempotent in id (same skill → same child ids)", async () => {
  const a = memLedger(), b = memLedger();
  const mk = (l: ReturnType<typeof memLedger>) => ({ ledger: l, declareParent: async () => "p" });
  await persistSkillContract(mk(a), FIXTURE);
  await persistSkillContract(mk(b), FIXTURE);
  expect(a.rows.slice(1).map((r) => r.id)).toEqual(b.rows.slice(1).map((r) => r.id));
});

// Luminary — sheep A: a skill with ZERO endpoints persists the parent only (0 children).
test("persistSkillContract on a no-endpoint skill writes parent only, child_count 0", async () => {
  const ledger = memLedger();
  const empty = { ...FIXTURE, skill_id: "skill_empty_0", endpoints: [] } as unknown as SkillManifest;
  const result = await persistSkillContract(
    {
      ledger,
      // the route's declareParent writes the parent row (via handleDeclare); mirror that
      declareParent: async (req) => {
        await ledger.append({ event: "declared", id: "parent_empty", ts: "", plan: req.plan, action: req.action, visibility: "lineage" });
        return "parent_empty";
      },
    },
    empty,
  );
  expect(result.child_count).toBe(0);
  expect(ledger.rows.length).toBe(1);          // parent only; the per-endpoint loop never runs
});

// Luminary — sheep C: every persisted child action is a parseable execute pointer,
// round-trips to (skill_id, endpoint_id), and the parent action is a strict prefix.
test("persisted child actions are lossless, parseable, parent-prefixed pointers", async () => {
  const ledger = memLedger();
  const PTR = /^contract:skill\/([A-Za-z0-9_-]+)\/endpoint\/([A-Za-z0-9_-]+)$/;
  await persistSkillContract(
    { ledger, declareParent: async () => "p", },
    FIXTURE,
  );
  // declareParent here didn't write a parent row, so rows are all children
  const parentAction = `contract:skill/${FIXTURE.skill_id}`;
  for (const row of ledger.rows) {
    const m = String(row.action).match(PTR);
    expect(m).not.toBeNull();                                   // matches the invariant regex
    expect(m![1]).toBe("skill_acme_123");                       // round-trips skill_id
    expect(["ep_search", "ep_detail"]).toContain(m![2]);        // round-trips endpoint_id
    expect(String(row.action).startsWith(parentAction + "/")).toBe(true);  // parent is strict prefix
  }
});
