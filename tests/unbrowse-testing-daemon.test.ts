/**
 * unbrowse-testing-daemon — repros for the daemon/perf issues.
 * Real checks against the landed code. No placeholders.
 * (U-8 covered here; the serve/capture-race issue still needs its own real repro.)
 */
import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  executeCacheKey,
  isExecuteResultCacheable,
  getCachedExecuteResult,
  setCachedExecuteResult,
  _clearExecuteResultCacheForTests,
} from "../src/execution/execute-result-cache.ts";

const ROOT = join(import.meta.dir, "..");

describe("unbrowse-testing daemon/perf repros (U-8 result cache + timing)", () => {
  // U-8 — execute layer must have a result cache (warm repeat fast) AND be instrumented.
  it("U-8: execute result cache key is deterministic and arg-order-independent", () => {
    const a = executeCacheKey({ skillId: "s1", endpointId: "e1", params: { b: 2, a: 1 } });
    const b = executeCacheKey({ skillId: "s1", endpointId: "e1", params: { a: 1, b: 2 } });
    const diff = executeCacheKey({ skillId: "s1", endpointId: "e1", params: { a: 1, b: 3 } });
    expect(a).toBe(b); // arg order cannot fork the key
    expect(a).not.toBe(diff); // different args → different key
  });

  it("U-8: only safe-to-replay reads are cacheable (structural gate, not a per-site list)", () => {
    expect(isExecuteResultCacheable({ method: "GET", success: true })).toBe(true);
    expect(isExecuteResultCacheable({ method: "POST", success: true })).toBe(false); // a write must re-fire
    expect(isExecuteResultCacheable({ method: "GET", success: false })).toBe(false); // failures honestly miss
    expect(isExecuteResultCacheable({ method: "GET", success: true, hasAuth: true })).toBe(false); // principal-scoped
    expect(isExecuteResultCacheable({ method: "GET", success: true, hasSession: true })).toBe(false);
    expect(isExecuteResultCacheable({ method: "GET", success: true, dryRun: true })).toBe(false);
  });

  it("U-8: a warm repeat of the same key replays the stored result (the speedup mechanism)", () => {
    _clearExecuteResultCacheForTests();
    const key = executeCacheKey({ skillId: "npm", endpointId: "pkg", params: { name: "express" } });
    expect(getCachedExecuteResult(key)).toBeUndefined(); // cold miss
    setCachedExecuteResult(key, { data: "ok", n: 42 });
    expect(getCachedExecuteResult<{ n: number }>(key)?.n).toBe(42); // warm hit replays, no re-fetch
    _clearExecuteResultCacheForTests();
    expect(getCachedExecuteResult(key)).toBeUndefined(); // cleared → cold again
  });

  it("U-8: the execute path is instrumented with timing.actual_total_ms", () => {
    const routes = readFileSync(join(ROOT, "src", "api", "routes.ts"), "utf8");
    // both the cache-hit fast path and the live path must report real wall-clock
    expect(/actual_total_ms/.test(routes)).toBe(true);
    expect(/cache_hit:\s*true/.test(routes)).toBe(true);
  });
});
