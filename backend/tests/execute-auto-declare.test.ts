/**
 * Declare-on-execute — collapsing `/contract` into the agent's natural
 * interface. The EXECUTE path (GET /v1/skills/:id) auto-declares a witnessed
 * truth-claim, exactly mirroring search.ts's declare-on-resolve, so an agent
 * never needs to call a contract verb: the act of executing IS the declare.
 *
 * Witnesses:
 *   (a) authed execute      → a `declared` row lands with plan `execute skill=…
 *                             status=ok` — route SHAPE only, NO param values.
 *   (b) anonymous execute   → no declare (the fire-site is agent_id-gated;
 *                             this asserts the same guard declareResolve uses).
 *   (c) ledger error        → swallowed; declareExecute never throws.
 *   (d) secret gate         → the execute-declare plan PASSES valueLooksLikeSecret
 *                             (shape-only, no false reject), and the plan is
 *                             accepted by the real handleDeclare secret guard.
 */
import { describe, expect, test } from "bun:test";
import {
  buildExecuteDeclarePlan,
  declareExecuteForTest,
} from "../src/routes/skills";
import { handleDeclare, valueLooksLikeSecret } from "../src/routes/contract";
import type {
  ContractEventRow,
  ContractLedger,
} from "../src/services/contract-ledger";

function recordingLedger(): { ledger: ContractLedger; rows: ContractEventRow[] } {
  const rows: ContractEventRow[] = [];
  const ledger: ContractLedger = {
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
  return { ledger, rows };
}

describe("buildExecuteDeclarePlan — route shape only", () => {
  test("skill + status, no endpoint", () => {
    expect(buildExecuteDeclarePlan({ skillId: "quotes.toscrape.com", status: "ok" })).toBe(
      "execute skill=quotes.toscrape.com status=ok",
    );
  });

  test("skill + endpoint + status", () => {
    expect(
      buildExecuteDeclarePlan({
        skillId: "quotes.toscrape.com",
        endpointId: "list_quotes",
        status: "ok",
      }),
    ).toBe("execute skill=quotes.toscrape.com endpoint=list_quotes status=ok");
  });

  test("plan carries NO url/param/response values — only ids + outcome", () => {
    const plan = buildExecuteDeclarePlan({
      skillId: "api.example.com",
      endpointId: "search",
      status: "ok",
    });
    // Shape tokens only.
    expect(plan).toContain("execute skill=");
    expect(plan).toContain("status=ok");
    // Never a query string, body, or filled url.
    expect(plan).not.toContain("?");
    expect(plan).not.toContain("http");
    expect(plan).not.toContain("Bearer");
    expect(plan).not.toContain("&");
  });
});

describe("declare-on-execute — ledger witness", () => {
  test("(a) authed execute appends a declared row with the route-shape plan", async () => {
    const { ledger, rows } = recordingLedger();
    await declareExecuteForTest(ledger, {
      skillId: "quotes.toscrape.com",
      status: "ok",
    });
    const declared = rows.filter((r) => r.event === "declared");
    expect(declared.length).toBe(1);
    expect(declared[0].plan).toBe("execute skill=quotes.toscrape.com status=ok");
    expect(declared[0].action).toBe("agent-executes");
    // SHAPE + outcome only — no param values leaked into the witness.
    expect(declared[0].plan).toContain("status=ok");
    expect(declared[0].plan).not.toContain("?");
    expect(declared[0].plan).not.toContain("Bearer");
  });

  test("(c) a ledger error is swallowed — declareExecute never throws", async () => {
    const throwingLedger: ContractLedger = {
      async append() {
        throw new Error("kv down");
      },
      async get() {
        return null;
      },
      async listAll() {
        return [];
      },
      async listChildren() {
        return [];
      },
    };
    // Must resolve, not reject — a ledger failure NEVER fails the execute.
    await expect(
      declareExecuteForTest(throwingLedger, { skillId: "any.com", status: "ok" }),
    ).resolves.toBeUndefined();
  });
});

describe("declare-on-execute — secret gate", () => {
  test("(d) execute-declare plan passes valueLooksLikeSecret (no false reject)", () => {
    expect(
      valueLooksLikeSecret(
        buildExecuteDeclarePlan({ skillId: "quotes.toscrape.com", status: "ok" }),
      ),
    ).toBe(false);
    expect(
      valueLooksLikeSecret(
        buildExecuteDeclarePlan({
          skillId: "api.example.com",
          endpointId: "search",
          status: "error",
        }),
      ),
    ).toBe(false);
  });

  test("(d') real handleDeclare accepts the execute-declare plan (secret guard green)", async () => {
    const { ledger } = recordingLedger();
    const res = await handleDeclare(
      {
        plan: buildExecuteDeclarePlan({
          skillId: "quotes.toscrape.com",
          endpointId: "list_quotes",
          status: "ok",
        }),
        action: "agent-executes",
        visibility: "lineage",
      },
      ledger,
      { admission: "legacy-anonymous" },
    );
    expect(typeof res.id).toBe("string");
    expect(res.row.plan).toBe(
      "execute skill=quotes.toscrape.com endpoint=list_quotes status=ok",
    );
  });
});
