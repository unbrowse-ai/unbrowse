/**
 * Witness for cold-hydrate (crypto-was-all-you-needed Phase 2): a fresh machine with an
 * empty local ledger clones the on-chain signed history into its local fast tier — the
 * symmetric read half of the write-through. Hermetic: a stub chain (readRows over a fixture)
 * + a real in-memory local AsyncResolutionLedger (find/history/append with the real
 * hash-chain). No chain, no SOL. Proves: full clone, idempotency, and tail-only hydrate.
 */
import { test, expect } from "bun:test";
import { hydrateLocalLedgerFromChain, type IqClient } from "../src/values/iq-ledger.js";
import { type AsyncResolutionLedger, type ResolutionRecord, GENESIS, recordHash } from "../src/values/async-resolution.js";

/** A real in-memory local ledger: same append-only hash-chain semantics as the fs ledger. */
function memLedger(): AsyncResolutionLedger & { rows: ResolutionRecord[] } {
  const rows: ResolutionRecord[] = [];
  return {
    rows,
    async find(intent) {
      for (let i = rows.length - 1; i >= 0; i--) if (rows[i].intent === intent) return rows[i];
      return undefined;
    },
    async history(intent) {
      return rows.filter((r) => r.intent === intent);
    },
    async append(intent, result, ts) {
      const seq = rows.length;
      const prev = rows.length ? rows[rows.length - 1].hash : GENESIS;
      const hash = recordHash({ intent, prev, result, seq });
      const rec: ResolutionRecord = { seq, intent, result, prev, hash, ts };
      rows.push(rec);
      return rec;
    },
  };
}

/** A stub chain whose readRows replays a fixed set of signed rows (what live IQ returns). */
function stubChain(raw: Array<Record<string, unknown>>): Pick<IqClient, "readRows"> {
  return { async readRows() { return raw; } };
}

const chainRows = [
  { seq: 0, intent: "ptr:food", result: "ptr:v1", prev: GENESIS, hash: "h0", ts: 1000, sig: "tx0" },
  { seq: 1, intent: "ptr:food", result: "ptr:v2", prev: "h0", hash: "h1", ts: 2000, sig: "tx1" }, // a 2nd version
  { seq: 2, intent: "ptr:news", result: "ptr:n1", prev: "h1", hash: "h2", ts: 3000, sig: "tx2" },
];

test("cold-hydrate clones the full on-chain signed history into an empty local ledger", async () => {
  const local = memLedger();
  const res = await hydrateLocalLedgerFromChain(stubChain(chainRows), local);
  expect(res).toEqual({ scanned: 3, hydrated: 3 });

  // The version chain is preserved: food has both past values, oldest→newest.
  const food = await local.history("ptr:food");
  expect(food.map((r) => r.result)).toEqual(["ptr:v1", "ptr:v2"]);
  expect((await local.find("ptr:news"))?.result).toBe("ptr:n1");
});

test("cold-hydrate is idempotent — re-running hydrates nothing", async () => {
  const local = memLedger();
  await hydrateLocalLedgerFromChain(stubChain(chainRows), local);
  const again = await hydrateLocalLedgerFromChain(stubChain(chainRows), local);
  expect(again.hydrated).toBe(0);
  expect(local.rows.length).toBe(3);
});

test("cold-hydrate appends only the MISSING tail when local is partially warm", async () => {
  const local = memLedger();
  await local.append("ptr:food", "ptr:v1", 1000); // local already has food@0
  const res = await hydrateLocalLedgerFromChain(stubChain(chainRows), local);
  expect(res.hydrated).toBe(2); // food@1 (v2) + news@0 (n1) — NOT food@0 again
  expect((await local.history("ptr:food")).map((r) => r.result)).toEqual(["ptr:v1", "ptr:v2"]);
});

test("malformed chain rows are skipped, not crashed on", async () => {
  const local = memLedger();
  const res = await hydrateLocalLedgerFromChain(
    stubChain([{ intent: "ptr:x", result: "ptr:y", seq: 0 }, { garbage: true }]),
    local,
  );
  expect(res).toEqual({ scanned: 1, hydrated: 1 });
});
