import { test, expect } from "bun:test";
import { handleDeclare, handleMark } from "../src/routes/contract";
import type {
  ContractEventRow,
  ContractLedger,
} from "../src/services/contract-ledger";

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

test("mark dispatches posthook called-edges from the declared plan", async () => {
  const ledger = memoryLedger();
  const { id: target } = await handleDeclare(
    { plan: "downstream chain target", action: "neuron" },
    ledger,
  );
  const { id: source } = await handleDeclare(
    { plan: `upstream claim posthook:${target}`, action: "neuron" },
    ledger,
  );
  const res = await handleMark(
    { id: source, proof: "chain witness: satisfied with a posthook declared" },
    ledger,
  );
  expect(res.called).toEqual([target]);
  const called = ledger.rows.find(
    (r) => r.event === "called" && r.id === source,
  );
  expect(called).toBeDefined();
  expect(called?.target_pointer).toBe(`contract:${target}`);
  expect(called?.call_kind).toBe("posthook");
});

test("decalogue:purge:5 declare surfaces orphan rows in purge_evidence", async () => {
  const ledger = memoryLedger();
  // Plant an orphan directly — a declared row whose parent has no row here.
  await ledger.append({
    event: "declared",
    id: "aaaa0001",
    ts: new Date().toISOString(),
    plan: "orphan probe",
    action: "neuron",
    parent_id: "ffffffff",
  });
  const res = await handleDeclare(
    { plan: "decalogue:purge:5", action: "neuron" },
    ledger,
  );
  expect(res.purge_evidence?.join("\n")).toContain("aaaa0001");
});

test("decalogue:purge:9 declare surfaces proofless satisfactions", async () => {
  const ledger = memoryLedger();
  const { id } = await handleDeclare(
    { plan: "target that gets rubber-stamped", action: "neuron" },
    ledger,
  );
  // Proofless satisfied row appended directly (bypassing handleMark's guard,
  // the way legacy/mirrored rows arrive).
  await ledger.append({
    event: "satisfied",
    id,
    ts: new Date().toISOString(),
    wave: 1,
  });
  const res = await handleDeclare(
    { plan: "decalogue:purge:9", action: "neuron" },
    ledger,
  );
  expect(res.purge_evidence?.join("\n")).toContain(id);
});

test("decalogue:purge:3 declare surfaces workless declarations", async () => {
  const ledger = memoryLedger();
  const { id: bare } = await handleDeclare(
    { plan: "bare empty-invocation probe", action: "neuron" },
    ledger,
  );
  const { id: worked } = await handleDeclare(
    { plan: "worked target", action: "neuron" },
    ledger,
  );
  await handleMark(
    { id: worked, proof: "real work happened here, witnessed and recorded" },
    ledger,
  );
  const res = await handleDeclare(
    { plan: "decalogue:purge:3", action: "neuron" },
    ledger,
  );
  const evidence = res.purge_evidence?.join("\n") ?? "";
  expect(evidence).toContain(bare);
  expect(evidence).not.toContain(worked);
});

test("non-mechanical commandments answer with an honest HOLD", async () => {
  const ledger = memoryLedger();
  const res = await handleDeclare(
    { plan: "decalogue:purge:7", action: "neuron" },
    ledger,
  );
  expect(res.purge_evidence?.join("\n")).toMatch(/not .*mechanical|HOLD/i);
});
