/**
 * Witness: the route-cache snapshot-invalidation primitive + its IQ-ledger binding.
 * - routeInputSnapshot is deterministic and changes when the route's input shape drifts.
 * - snapshotDrifted: first-resolve (no prior) and unchanged never drift; a real change drifts.
 * - recordCacheInvalidation writes a cache_invalidated event to the IQ ledger ONLY on drift
 *   (the same table browsed via scripts/iq-ledger.mjs), fail-open, via a stub ledger.
 */
import { test, expect } from "bun:test";
import { routeInputSnapshot, snapshotDrifted, invalidationPointer } from "../src/values/route-snapshot.js";
import { recordCacheInvalidation } from "../src/values/cached-resolution.js";

test("routeInputSnapshot is deterministic + changes when the input shape drifts", () => {
  const a = { url_template: "https://x.com/api/{id}", method: "GET", holes: ["id"], response_cardinality: "one" };
  expect(routeInputSnapshot(a)).toBe(routeInputSnapshot({ ...a }));
  expect(routeInputSnapshot(a)).not.toBe(routeInputSnapshot({ ...a, response_cardinality: "many" }));
  expect(routeInputSnapshot(a)).not.toBe(routeInputSnapshot({ ...a, holes: ["id", "page"] }));
  expect(routeInputSnapshot(a)).not.toBe(routeInputSnapshot({ ...a, url_template: "https://x.com/v2/{id}" }));
});

test("snapshotDrifted: first-resolve never drifts; same never drifts; a real change drifts", () => {
  const s = routeInputSnapshot({ url_template: "u", holes: ["a"] });
  expect(snapshotDrifted(undefined, s)).toBe(false);
  expect(snapshotDrifted("", s)).toBe(false);
  expect(snapshotDrifted(s, s)).toBe(false);
  expect(snapshotDrifted("snap:stale", s)).toBe(true);
});

test("recordCacheInvalidation writes a cache_invalidated IQ event ONLY on drift", async () => {
  const appended: Array<{ intent: string; result: string }> = [];
  const stub = {
    find: async () => undefined,
    history: async () => [],
    append: async (intent: string, result: string) => {
      appended.push({ intent, result });
      return { seq: 1, intent, result, prev: "", hash: "h", ts: 0 } as never;
    },
  };
  const s1 = routeInputSnapshot({ url_template: "u", holes: ["a"], response_cardinality: "one" });
  const s2 = routeInputSnapshot({ url_template: "u", holes: ["a"], response_cardinality: "many" });

  const noDrift = await recordCacheInvalidation("route:x", s1, s1, "probe", { ledger: stub as never });
  expect(noDrift.invalidated).toBe(false);
  expect(appended.length).toBe(0);

  const drift = await recordCacheInvalidation("route:x", s1, s2, "shape-drift", { ledger: stub as never });
  expect(drift.invalidated).toBe(true);
  expect(appended.length).toBe(1);
  expect(appended[0].result).toBe(invalidationPointer(s2, "shape-drift"));
  expect(appended[0].result).toContain("invalidated");
});
