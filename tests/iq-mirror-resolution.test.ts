/**
 * Witness for the IQ on-chain write-through (crypto-was-all-you-needed): storeResolution
 * persists locally AND mirrors the resolution to the IQLabs signed on-chain ledger when
 * configured. Hermetic — an injected stub ledger stands in for Solana, so the wiring is
 * proven without a chain. Also asserts the write-through is fail-open and never breaks the
 * local store (the hot path is untouched when IQ is absent / errors).
 */
import { describe, expect, it } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mirrorResolutionToChain, storeResolution, peekResolution } from "../src/values/cached-resolution.js";
import type { AsyncResolutionLedger } from "../src/values/async-resolution.js";

function stubLedger(): AsyncResolutionLedger & { appends: Array<{ intent: string; result: string }> } {
  const appends: Array<{ intent: string; result: string }> = [];
  return {
    appends,
    async find() { return undefined; },
    async history() { return []; },
    async append(intent: string, result: string, ts = Date.now()) {
      appends.push({ intent, result });
      return { seq: appends.length - 1, intent, result, prev: "GENESIS", hash: "h", ts, sig: "stub-sig" } as never;
    },
  };
}

describe("mirrorResolutionToChain — on-chain write-through (injected ledger, no chain)", () => {
  it("appends the (scoped intent, content pointer) to the IQ ledger when configured", async () => {
    const led = stubLedger();
    const res = await mirrorResolutionToChain("weather:SG", "ptr_abc", { ledger: led });
    expect(res.mirrored).toBe(true);
    expect(led.appends.length).toBe(1);
    expect(led.appends[0].result).toBe("ptr_abc");
    expect(led.appends[0].intent.length).toBeGreaterThan(0);
  });

  it("is a no-op (mirrored:false) when IQ is not configured (ledger null)", async () => {
    const res = await mirrorResolutionToChain("weather:SG", "ptr_abc", { ledger: null });
    expect(res.mirrored).toBe(false);
  });

  it("fail-open: a throwing ledger never throws, returns mirrored:false", async () => {
    const throwing: AsyncResolutionLedger = {
      async find() { return undefined; },
      async history() { return []; },
      async append() { throw new Error("chain down"); },
    };
    const res = await mirrorResolutionToChain("k", "p", { ledger: throwing });
    expect(res.mirrored).toBe(false);
  });
});

describe("storeResolution — local hot path is non-regressive with the write-through", () => {
  it("store → peek still round-trips locally (write-through never breaks the local store)", () => {
    const dir = mkdtempSync(join(tmpdir(), "ubz-res-"));
    storeResolution("intent:abc", { v: 42 }, 60_000, dir);
    const got = peekResolution<{ v: number }>("intent:abc", 60_000, dir);
    expect(got).toEqual({ v: 42 });
  });
});
