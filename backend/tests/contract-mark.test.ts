import { test, expect } from "bun:test";
import {
  handleDeclare,
  handleMark,
  type MarkRequest,
} from "../src/routes/contract";
import {
  projectStatus,
  type ContractEventRow,
  type ContractLedger,
} from "../src/services/contract-ledger";

// Hermetic in-memory ledger — the handlers are pure projections over the
// interface, so no KV/Env is needed (same seam the route docs promise).
function memoryLedger(): ContractLedger & { rows: ContractEventRow[] } {
  const rows: ContractEventRow[] = [];
  return {
    rows,
    async append(row) {
      rows.push(row);
      return row;
    },
    async get(id) {
      const hits = rows.filter((r) => r.id === id);
      return hits.length ? hits : null;
    },
    async listAll() {
      return rows;
    },
    async listChildren(parentId) {
      return rows.filter((r) => r.parent_id === parentId);
    },
  };
}

test("handleMark appends a satisfied row on a declared target", async () => {
  const ledger = memoryLedger();
  const { id } = await handleDeclare(
    { plan: "target claim", action: "neuron" },
    ledger,
  );
  const req: MarkRequest = {
    id,
    proof: "deploy verified live: curl 200 + identity string present",
  };
  const res = await handleMark(req, ledger);
  expect(res.id).toBe(id);
  expect(res.row.event).toBe("satisfied");
  expect(projectStatus(ledger.rows.filter((r) => r.id === id))).toBe("satisfied");
});

test("handleMark refuses an undeclared id", async () => {
  const ledger = memoryLedger();
  await expect(handleMark({ id: "deadbeef" }, ledger)).rejects.toThrow(
    /not declared/,
  );
});

test("handleMark refuses a thin non-pointer proof", async () => {
  const ledger = memoryLedger();
  const { id } = await handleDeclare(
    { plan: "target claim", action: "neuron" },
    ledger,
  );
  await expect(handleMark({ id, proof: "ok" }, ledger)).rejects.toThrow(
    /proof too thin/,
  );
});

test("handleMark accepts a short pointer-prefixed proof", async () => {
  const ledger = memoryLedger();
  const { id } = await handleDeclare(
    { plan: "target claim", action: "neuron" },
    ledger,
  );
  const res = await handleMark({ id, proof: "contract:cafebabe" }, ledger);
  expect(res.row.event).toBe("satisfied");
});

test("declare with a satisfied:-prefixed plan lands the event on the target", async () => {
  const ledger = memoryLedger();
  const { id: target } = await handleDeclare(
    { plan: "target claim", action: "neuron" },
    ledger,
  );
  const res = await handleDeclare(
    {
      plan: `satisfied:${target} wave=2 — shipped and verified, suite green, binaries signed`,
      action: "neuron",
    },
    ledger,
  );
  expect(res.eval_evidence).toContain(target);
  const targetRows = ledger.rows.filter((r) => r.id === target);
  const sat = targetRows.find((r) => r.event === "satisfied");
  expect(sat).toBeDefined();
  expect(sat?.wave).toBe(2);
  expect(projectStatus(targetRows)).toBe("satisfied");
});

test("declare with satisfied: for an unknown target stays narrative-only", async () => {
  const ledger = memoryLedger();
  const res = await handleDeclare(
    {
      plan: "satisfied:deadbeef wave=1 — closure for a row this ledger has never seen",
      action: "neuron",
    },
    ledger,
  );
  expect(res.eval_evidence).toMatch(/narrative only|no declared row/);
  expect(
    ledger.rows.find((r) => r.id === "deadbeef" && r.event === "satisfied"),
  ).toBeUndefined();
});
