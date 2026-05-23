// BUG-011 (contract 311771e1): EdbKV.put must refuse oversize values BEFORE
// the network call, since qdkv/set returns ok:true on truncated writes.
// Pure unit test — no fetch, no real network — exercises the gate directly.

import { afterEach, describe, expect, it } from "bun:test";
import { EdbKV } from "../src/services/kv.js";

describe("BUG-011: EdbKV pre-write size gate (contract 311771e1)", () => {
  const originalFetch = globalThis.fetch;
  const originalLimit = process.env.EMERGENTDB_MAX_VALUE_BYTES;

  afterEach(() => {
    globalThis.fetch = originalFetch;
    if (originalLimit === undefined) {
      delete process.env.EMERGENTDB_MAX_VALUE_BYTES;
    } else {
      process.env.EMERGENTDB_MAX_VALUE_BYTES = originalLimit;
    }
  });

  it("rejects put() of a value over the 10KB default cap before any fetch fires", async () => {
    // Sentinel: any network call here is a bug — we must short-circuit pre-write.
    let fetchCalls = 0;
    globalThis.fetch = (async () => {
      fetchCalls++;
      return Response.json({ ok: true });
    }) as typeof fetch;

    const kv = new EdbKV("test-key", "stats");
    const oversize = "x".repeat(20 * 1024); // 20 KB > 10 KB default

    await expect(kv.put("skill:huge", oversize)).rejects.toThrow(/value_too_large/);
    expect(fetchCalls).toBe(0);
  });

  it("includes the byte count, threshold, and key name in the error message", async () => {
    globalThis.fetch = (async () => Response.json({ ok: true })) as typeof fetch;
    const kv = new EdbKV("test-key", "stats");
    const oversize = "y".repeat(20 * 1024);

    let captured: Error | null = null;
    try {
      await kv.put("skill:big", oversize);
    } catch (err) {
      captured = err as Error;
    }
    expect(captured).not.toBeNull();
    expect(captured!.message).toContain("value_too_large");
    expect(captured!.message).toContain("20480");
    expect(captured!.message).toContain("10240");
    expect(captured!.message).toContain("skill:big");
  });

  it("honors a constructor override (maxValueBytes)", async () => {
    let fetchCalls = 0;
    globalThis.fetch = (async () => {
      fetchCalls++;
      return Response.json({ ok: true });
    }) as typeof fetch;

    // Cap at 1024; a 2KB write must be rejected.
    const kv = new EdbKV("test-key", "stats", { maxValueBytes: 1024 });
    await expect(kv.put("k:small-cap", "z".repeat(2048))).rejects.toThrow(/value_too_large/);
    expect(fetchCalls).toBe(0);
  });

  it("allows a value under the cap (does call fetch)", async () => {
    let fetchCalls = 0;
    globalThis.fetch = (async (input: RequestInfo | URL, _init?: RequestInit) => {
      fetchCalls++;
      const url = String(typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url);
      // Stub both /qdkv/set and the _idx GET round-trip so put() can complete.
      if (url.includes("/qdkv/set")) return Response.json({ ok: true });
      if (url.includes("/qdkv/get/")) return Response.json({ found: false, value: null });
      return Response.json({ ok: true });
    }) as typeof fetch;

    const kv = new EdbKV("test-key", "stats");
    await kv.put("k:small", "tiny");
    expect(fetchCalls).toBeGreaterThanOrEqual(1);
  });

  it("putBatch rejects when any single value exceeds the cap, before any fetch", async () => {
    let fetchCalls = 0;
    globalThis.fetch = (async () => {
      fetchCalls++;
      return Response.json({ ok: true });
    }) as typeof fetch;

    const kv = new EdbKV("test-key", "stats");
    const pairs = [
      { key: "k:ok", value: "fine" },
      { key: "k:huge", value: "h".repeat(20 * 1024) },
    ];
    await expect(kv.putBatch(pairs)).rejects.toThrow(/value_too_large/);
    expect(fetchCalls).toBe(0);
  });

  it("does NOT gate _idx writes (managed by their own overflow logic)", async () => {
    // _idx values are handled by _idxSave which has MAX_IDX_BYTES eviction.
    // The gate would over-fire on legitimate _idx grow patterns, so it's
    // intentionally skipped for _idx*.
    const fetchUrls: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url);
      fetchUrls.push(url);
      if (url.includes("/qdkv/set")) return Response.json({ ok: true });
      return Response.json({ ok: true });
    }) as typeof fetch;

    const kv = new EdbKV("test-key", "stats");
    const oversize = "x".repeat(20 * 1024);
    // Should NOT throw — _idx writes bypass the gate.
    await kv.put("_idx:main", oversize);
    expect(fetchUrls.some((u) => u.includes("/qdkv/set"))).toBe(true);
  });
});
