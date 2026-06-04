/**
 * resolution-tier.test — the witness that the resolution cache routes to the REMOTE
 * tier (R2 + IQ) when configured and the LOCAL fs tier otherwise, with fs as the
 * fallback. Hermetic: stub R2 (AsyncBlobStore) + stub IQ (AsyncResolutionLedger).
 * Proves: selection by config; remote resolves + caches (warm hit, no recompute);
 * uncacheable results never persist to the ledger; local fallback when no remote.
 */
import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { selectTier, remoteTierConfigured, resolveCached, type RemoteTier } from "../src/values/resolution-tier.js";
import type { AsyncBlobStore, AsyncResolutionLedger } from "../src/values/async-resolution.js";
import { intentKey, contentPointer, GENESIS, recordHash } from "../src/values/async-resolution.js";
import type { ResolutionRecord } from "../src/values/resolution-ledger.js";

function memRemote(): RemoteTier & { rows: ResolutionRecord[] } {
  const blobs = new Map<string, string>();
  const rows: ResolutionRecord[] = [];
  const store: AsyncBlobStore = { get: async (h) => blobs.get(h), put: async (h, t) => void blobs.set(h, t) };
  const ledger: AsyncResolutionLedger = {
    find: async (intent) => [...rows].reverse().find((r) => r.intent === intent),
    history: async (intent) => rows.filter((r) => r.intent === intent),
    append: async (intent, result, ts) => {
      const seq = rows.length;
      const prev = rows.length ? rows[rows.length - 1].hash : GENESIS;
      const rec: ResolutionRecord = { seq, intent, result, prev, hash: recordHash({ intent, prev, result, seq }), ts };
      rows.push(rec); return rec;
    },
  };
  return { store, ledger, rows };
}

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "tier-")); process.env.UNBROWSE_RESOLUTION_CACHE_DIR; });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });
const ok = () => true;

describe("resolution-tier", () => {
  it("selects remote when configured, local when not", () => {
    expect(selectTier(null)).toBe("local");
    expect(selectTier(memRemote())).toBe("remote");
    expect(remoteTierConfigured(null)).toBe(false);
    expect(remoteTierConfigured(memRemote())).toBe(true);
  });

  it("REMOTE tier: resolves, caches on the IQ ledger, warm hit replays (no recompute)", async () => {
    const remote = memRemote();
    let runs = 0;
    const recompute = async () => { runs++; return { v: 42 }; };
    const cold = await resolveCached({ key: "intent A", ttlMs: 60_000, recompute, cacheable: ok, remote });
    expect(cold.tier).toBe("remote");
    expect(cold.cached).toBe(false);
    expect(runs).toBe(1);
    expect(remote.rows.length).toBe(1); // one signed row appended
    expect(remote.rows[0].intent).toBe(intentKey("intent A"));
    expect(remote.rows[0].result).toBe(contentPointer(JSON.stringify({ v: 42 })));

    const warm = await resolveCached({ key: "intent A", ttlMs: 60_000, recompute, cacheable: ok, remote });
    expect(warm.cached).toBe(true);
    expect(warm.tier).toBe("remote");
    expect(runs).toBe(1); // replayed from R2 + IQ ledger, no recompute
    expect(warm.value).toEqual({ v: 42 });
  });

  it("REMOTE tier: an uncacheable result is never persisted to the ledger", async () => {
    const remote = memRemote();
    const recompute = async () => ({ error: "auth_required" });
    const r = await resolveCached({ key: "k", ttlMs: 60_000, recompute, cacheable: (v) => !v.error, remote });
    expect(r.cached).toBe(false);
    expect(remote.rows.length).toBe(0); // nothing written — honest retry next time
  });

  it("LOCAL fallback: no remote → fs tier resolves + caches across calls (hermetic dir)", async () => {
    let runs = 0;
    const recompute = async () => { runs++; return { v: "local" }; };
    const cold = await resolveCached({ key: "L", ttlMs: 60_000, recompute, cacheable: ok, remote: null, dir });
    expect(cold.tier).toBe("local");
    expect(runs).toBe(1);
    const warm = await resolveCached({ key: "L", ttlMs: 60_000, recompute, cacheable: ok, remote: null, dir });
    expect(warm.tier).toBe("local");
    expect(warm.cached).toBe(true); // fs cache hit
    expect(runs).toBe(1); // no recompute — wrote to the temp dir, not ~/.unbrowse
  });
});
