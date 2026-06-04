/**
 * iq-ledger.test — the witness that the IQLabs on-chain ledger tier preserves the
 * SIGNED HISTORY of past values (git-style) and satisfies the AsyncResolutionLedger
 * contract. Hermetic: a stub IqClient (in-memory append-only rows, each writeRow
 * returns a fake tx signature) stands in for Solana, so the adapter is proven without
 * a chain. Also proves resolveAsync runs end-to-end through the IQ ledger.
 */
import { describe, expect, it } from "bun:test";
import { iqLedger, type IqClient } from "../src/values/iq-ledger.js";
import { intentKey, contentPointer, recordHash, GENESIS, resolveAsync, type AsyncBlobStore } from "../src/values/async-resolution.js";

// stub on-chain table: append-only rows, each write "signed" with a deterministic sig
function stubIq(): IqClient & { rows: Array<Record<string, unknown>> } {
  const rows: Array<Record<string, unknown>> = [];
  return {
    rows,
    writeRow: async (json) => {
      const row = JSON.parse(json) as Record<string, unknown>;
      const sig = `sig_${rows.length}_${String(row.hash).slice(0, 8)}`;
      rows.push({ ...row, sig });
      return sig;
    },
    readRows: async () => rows.map((r) => ({ ...r })),
  };
}

function memBlob(): AsyncBlobStore {
  const m = new Map<string, string>();
  return { get: async (h) => m.get(h), put: async (h, t) => void m.set(h, t) };
}

describe("iq-ledger — signed, append-only history of past values", () => {
  it("append writes a signed, hash-chained row; find returns the latest", async () => {
    const client = stubIq();
    const ledger = iqLedger(client);
    const key = intentKey("weather in SG");
    const r1 = await ledger.append(key, contentPointer("sunny"));
    expect(r1.seq).toBe(0);
    expect(r1.prev).toBe(GENESIS);
    expect(r1.hash).toBe(recordHash({ intent: key, prev: GENESIS, result: r1.result, seq: 0 }));
    expect(client.rows[0].sig).toBeTruthy(); // the row was signed (tx sig)
    const found = await ledger.find(key);
    expect(found?.result).toBe(contentPointer("sunny"));
  });

  it("preserves PAST values — history shows every prior resolution (git-style)", async () => {
    const client = stubIq();
    const ledger = iqLedger(client);
    const key = intentKey("weather in SG");
    await ledger.append(key, contentPointer("sunny"));   // past value
    await ledger.append(key, contentPointer("rainy"));   // newer value
    const hist = await ledger.history(key);
    expect(hist.length).toBe(2);
    expect(hist[0].result).toBe(contentPointer("sunny")); // the PAST value is still readable
    expect(hist[1].result).toBe(contentPointer("rainy"));
    // chain links: row[1].prev == row[0].hash
    expect(hist[1].prev).toBe(hist[0].hash);
    // every past row carries its own signature (signed history)
    expect(hist.every((_r, i) => client.rows[i].sig)).toBe(true);
    // find returns the latest, not the past
    expect((await ledger.find(key))?.result).toBe(contentPointer("rainy"));
  });

  it("distinct intents do not interleave in history", async () => {
    const client = stubIq();
    const ledger = iqLedger(client);
    await ledger.append(intentKey("a"), contentPointer("1"));
    await ledger.append(intentKey("b"), contentPointer("2"));
    await ledger.append(intentKey("a"), contentPointer("3"));
    expect((await ledger.history(intentKey("a"))).map((r) => r.result))
      .toEqual([contentPointer("1"), contentPointer("3")]);
    expect((await ledger.history(intentKey("b"))).map((r) => r.result))
      .toEqual([contentPointer("2")]);
  });

  it("resolveAsync runs end-to-end through the IQ ledger + a blob store", async () => {
    const ledger = iqLedger(stubIq());
    const store = memBlob();
    let runs = 0;
    const recompute = async () => { runs++; return "resolved value"; };
    const cold = await resolveAsync("intent X", recompute, store, ledger);
    expect(cold.recomputed).toBe(true); expect(runs).toBe(1);
    const warm = await resolveAsync("intent X", recompute, store, ledger);
    expect(warm.cached).toBe(true); expect(runs).toBe(1); // ledger hit + blob replay, no recompute
    expect(warm.value).toBe("resolved value");
  });
});
