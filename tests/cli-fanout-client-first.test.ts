/**
 * Bounded-concurrency, client-first fan-out — "fan agents out to do the rest."
 *
 * North star (this lever): the CLI already runs client-first and falls back to
 * the server proxy when blocked (tests/server-iproyal-fallback.test.ts). The
 * missing third tier is fanning the REST of the work out across parallel workers
 * — bounded so it never stampedes, isolated so one failure doesn't sink the
 * batch, order-preserving so callers can zip results back to inputs.
 *
 * The existing batch path (cmdSiteBatch) used an UNBOUNDED Promise.all — N tasks
 * meant N simultaneous hits. This primitive replaces that with a real cap.
 *
 * Witnesses (deterministic, no network):
 *   1. bounded — never more than `concurrency` workers in flight at once, AND
 *      genuinely runs more than one at once (real parallelism, not serial).
 *   2. complete + ordered — every item is processed; results map back by index.
 *   3. isolated — a worker that throws yields a settled error entry, the rest
 *      still complete (Promise.allSettled semantics, not all-or-nothing).
 *
 * Mutation gate: this file MUST fail under HEAD before the build lands —
 * src/execution/fan-out.ts does not exist yet.
 */
import { describe, expect, it } from "bun:test";
import { fanOut } from "../src/execution/fan-out.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("fanOut — bounded client-first fan-out primitive", () => {
  it("never exceeds the concurrency cap, but does run >1 in parallel", async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const items = Array.from({ length: 9 }, (_, i) => i);
    await fanOut(
      items,
      async (n) => {
        inFlight++;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await sleep(30);
        inFlight--;
        return n * 2;
      },
      { concurrency: 3 },
    );
    expect(maxInFlight).toBeLessThanOrEqual(3);
    expect(maxInFlight).toBeGreaterThan(1); // real fan-out, not serial
  });

  it("processes every item and preserves input order", async () => {
    const items = ["a", "b", "c", "d", "e"];
    const results = await fanOut(items, async (s, i) => `${i}:${s}`, { concurrency: 2 });
    expect(results).toHaveLength(5);
    expect(results.map((r) => r.value)).toEqual(["0:a", "1:b", "2:c", "3:d", "4:e"]);
    expect(results.every((r) => r.ok)).toBe(true);
  });

  it("isolates a failing worker — the rest still complete", async () => {
    const items = [1, 2, 3, 4];
    const results = await fanOut(
      items,
      async (n) => {
        if (n === 2) throw new Error("boom on 2");
        return n;
      },
      { concurrency: 2 },
    );
    expect(results).toHaveLength(4);
    expect(results[1].ok).toBe(false);
    expect(results[1].error).toContain("boom on 2");
    expect(results.filter((r) => r.ok).map((r) => r.value)).toEqual([1, 3, 4]);
  });

  it("defaults to a sane bounded concurrency when unspecified", async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const items = Array.from({ length: 40 }, (_, i) => i);
    await fanOut(items, async (n) => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await sleep(5);
      inFlight--;
      return n;
    });
    // unspecified must still be bounded — never an unbounded Promise.all stampede
    expect(maxInFlight).toBeLessThan(40);
    expect(maxInFlight).toBeGreaterThan(1);
  });
});
