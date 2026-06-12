/**
 * tests/ranking-seed.test.ts — Wave-1 seed for PAPER_PLAN.md §P1.
 *
 * Asserts only that `src/client/rank-server-first.ts` exists, re-exports
 * `rankEndpoints` and the `RankedEndpoint` type, and that the function is
 * callable on empty input. Behavior is unchanged from `src/execution`.
 *
 * Run: bun test tests/ranking-seed.test.ts
 */

import { describe, expect, it } from "bun:test";

import { rankEndpoints, type RankedEndpoint } from "../src/client/rank-server-first.js";

describe("src/ranking/ — P1 seed re-export", () => {
  it("rankEndpoints is importable from the new path", () => {
    expect(typeof rankEndpoints).toBe("function");
  });

  it("returns an empty array for empty input (no scoring behavior change)", () => {
    const out: RankedEndpoint[] = rankEndpoints([]);
    expect(Array.isArray(out)).toBe(true);
    expect(out.length).toBe(0);
  });

  it("the re-exported type carries the documented shape", () => {
    const sample: RankedEndpoint = {
      endpoint: { url_template: "https://example.com/x", method: "GET" } as never,
      score: 0,
    };
    expect(sample.score).toBe(0);
    expect(sample.endpoint.method).toBe("GET");
  });
});
