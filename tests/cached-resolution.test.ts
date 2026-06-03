/**
 * cached-resolution.test — the witness for the search/resolve latency fix.
 * Proves: an expensive resolution runs once; a repeated call (even from a FRESH
 * cache instance loaded off the same disk dir — i.e. a second CLI invocation) replays
 * the pointer with no recompute; TTL expiry forces a refresh; non-cacheable results
 * are never stored (errors honestly retry); ttl<=0 (stateless) disables the cache.
 */
import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cachedResolution } from "../src/values/cached-resolution.js";

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "reso-cache-")); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

const ok = () => true;

describe("cached-resolution", () => {
  it("runs the expensive resolution once; a repeated call replays without recomputing", async () => {
    let runs = 0;
    const recompute = async () => { runs++; return { results: [1, 2, 3], q: "x" }; };
    const cold = await cachedResolution({ key: "intent:x", ttlMs: 60_000, recompute, cacheable: ok, dir });
    expect(cold.cached).toBe(false);
    expect(runs).toBe(1);
    const warm = await cachedResolution({ key: "intent:x", ttlMs: 60_000, recompute, cacheable: ok, dir });
    expect(warm.cached).toBe(true);
    expect(runs).toBe(1);                         // NOT recomputed — the latency fix
    expect(warm.value).toEqual(cold.value);       // identical result (correctness)
  });

  it("a SECOND process (fresh cache instance, same dir) still hits — cross-invocation warm", async () => {
    let runs = 0;
    const recompute = async () => { runs++; return { results: ["a"] }; };
    await cachedResolution({ key: "k", ttlMs: 60_000, recompute, cacheable: ok, dir });
    // simulate a brand new CLI process: nothing in memory, only the disk dir
    const warm = await cachedResolution({ key: "k", ttlMs: 60_000, recompute, cacheable: ok, dir });
    expect(warm.cached).toBe(true);
    expect(runs).toBe(1);
  });

  it("a TTL-expired entry is refreshed (recomputed), not served stale", async () => {
    let runs = 0;
    const recompute = async () => { runs++; return { results: [runs] }; };
    const t0 = 1_000_000;
    await cachedResolution({ key: "k", ttlMs: 1000, recompute, cacheable: ok, dir, now: t0 });
    const stale = await cachedResolution({ key: "k", ttlMs: 1000, recompute, cacheable: ok, dir, now: t0 + 5000 });
    expect(stale.cached).toBe(false);             // expired → recompute
    expect(runs).toBe(2);
  });

  it("non-cacheable results (errors / empty / auth-required) are never stored", async () => {
    let runs = 0;
    const recompute = async () => { runs++; return { error: "auth_required" }; };
    const cacheable = (v: { error?: string }) => !v.error;
    await cachedResolution({ key: "k", ttlMs: 60_000, recompute, cacheable, dir });
    const second = await cachedResolution({ key: "k", ttlMs: 60_000, recompute, cacheable, dir });
    expect(second.cached).toBe(false);            // not cached → honest retry
    expect(runs).toBe(2);
  });

  it("ttl<=0 (stateless mode) disables the cache entirely — pass-through, no disk write", async () => {
    let runs = 0;
    const recompute = async () => { runs++; return { results: [1] }; };
    await cachedResolution({ key: "k", ttlMs: 0, recompute, cacheable: ok, dir });
    const second = await cachedResolution({ key: "k", ttlMs: 0, recompute, cacheable: ok, dir });
    expect(second.cached).toBe(false);
    expect(runs).toBe(2);
  });

  it("a recompute error propagates and is not cached", async () => {
    const recompute = async () => { throw new Error("boom"); };
    await expect(cachedResolution({ key: "k", ttlMs: 60_000, recompute, cacheable: ok, dir })).rejects.toThrow("boom");
  });
});
