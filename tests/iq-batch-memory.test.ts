// Witness: cross-machine wallet-bound on-chain memory, the full loop — batched push →
// on-chain → cross-machine hydrate. Hermetic: an in-memory fake IqClient stands in for the
// IQLabs Solana table (funding only gates the LIVE write, never the logic), so this proves
// the redesign without SOL. Three claims:
//   1. multi-row batch (justrach-style): N memory records land in ONE writeRow = ONE tx.
//   2. cross-machine recall: a FRESH local ledger rebuilds its memory from the chain pack.
//   3. backward-compat: a legacy single-row (pre-batch) still expands to one record.
import { test, expect } from "bun:test";
import { type IqClient, appendBatch, expandRows, hydrateLocalLedgerFromChain } from "../src/values/iq-ledger.js";
import { type AsyncResolutionLedger, GENESIS, recordHash } from "../src/values/async-resolution.js";
import type { Pointer, ResolutionRecord } from "../src/values/resolution-ledger.js";

// In-memory stand-in for the on-chain table; counts writeRow calls (= Solana txs).
function fakeChain() {
  const rows: Array<Record<string, unknown>> = [];
  let writes = 0;
  const client: IqClient = {
    async writeRow(json: string) {
      rows.push(JSON.parse(json));
      writes += 1;
      return `sig-${writes}`;
    },
    async readRows() {
      return rows.map((r) => ({ ...r, sig: "sig" }));
    },
  };
  return { client, writeCount: () => writes };
}

// The fast-tier local ledger a fresh machine starts with (empty), minimal in-memory impl.
function memLedger(): AsyncResolutionLedger {
  const store = new Map<string, ResolutionRecord[]>();
  return {
    async find(intent: Pointer) {
      const h = store.get(intent);
      return h && h.length ? h[h.length - 1] : undefined;
    },
    async history(intent: Pointer) {
      return store.get(intent) ?? [];
    },
    async append(intent: Pointer, result: Pointer, ts?: number) {
      const h = store.get(intent) ?? [];
      const seq = h.length;
      const prev = h.length ? h[h.length - 1].hash : GENESIS;
      const hash = recordHash({ intent, prev, result, seq });
      const rec: ResolutionRecord = { seq, intent, result, prev, hash, ts };
      h.push(rec);
      store.set(intent, h);
      return { ...rec, sig: "local" };
    },
  };
}

const MEMORIES = [
  { intent: "did:compile-email", result: "ok:regex" },
  { intent: "did:deploy-worker", result: "ok:v2" },
  { intent: "did:charge-0.05", result: "ok:stamped" },
];

test("multi-row batch: N memory records land in ONE tx (justrach-style efficiency)", async () => {
  const chain = fakeChain();
  const { records } = await appendBatch(chain.client, MEMORIES);
  expect(records.length).toBe(3);
  expect(chain.writeCount()).toBe(1); // 3 memory rows, ONE Solana tx (not 3) — the rent amortization
  const back = expandRows(await chain.client.readRows());
  expect(back.length).toBe(3);
  expect(back.map((r) => r.intent)).toEqual(MEMORIES.map((m) => m.intent));
  // the hash-chain is continued across the pack (each prev links to the previous record's hash)
  expect(back[1].prev).toBe(back[0].hash);
  expect(back[2].prev).toBe(back[1].hash);
});

test("cross-machine recall: a fresh local ledger rebuilds memory from the on-chain pack", async () => {
  const chain = fakeChain();
  await appendBatch(chain.client, MEMORIES);
  const fresh = memLedger(); // a DIFFERENT machine: empty local store, same wallet's chain
  const { scanned, hydrated } = await hydrateLocalLedgerFromChain(chain.client, fresh);
  expect(scanned).toBe(3);
  expect(hydrated).toBe(3); // remembered across machines — nothing carried over locally
  expect((await fresh.history("did:deploy-worker")).length).toBe(1);
  const again = await hydrateLocalLedgerFromChain(chain.client, fresh);
  expect(again.hydrated).toBe(0); // idempotent: re-hydrate adds nothing
});

test("backward-compat: a legacy single-row (no batch) still expands to one record", async () => {
  const raw = [{ seq: 0, intent: "did:legacy", result: "ok", prev: GENESIS, hash: "h", sig: "s" }];
  const back = expandRows(raw);
  expect(back.length).toBe(1);
  expect(back[0].intent).toBe("did:legacy");
});
