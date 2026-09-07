/**
 * GATE: resolveAndExecute actually CONSULTS the browser fallback.
 *
 * `browser-fallback.test.ts` pins the decision. This pins the wiring — that the
 * shipped orchestrator entry point calls it and acts on it. The two are
 * genuinely separate failure modes: a perfect decision function nobody invokes
 * is exactly the bug this change was made to fix (`escalate-on-miss.ts` has
 * implemented this policy for a while, wired only into the v7 dev surface).
 *
 * The fixture is a concrete detail URL answered by a collection — the shape
 * `enforceIntentResultTruth` rejects as response_shape_mismatch. Measured
 * before/after on this exact fixture:
 *
 *   before: trace.success=false  error=response_shape_mismatch  browser_opened=false
 *   after:  trace.success=true   source=live-capture            browser_opened=true
 *           decision_trace=[{step:"browser_fallback_rescued"}]
 *           result: 4 discovered endpoints, indexed for the next call
 *
 * The assertion is that the fallback RAN, not that it rescued — a rescue needs a
 * working browser, but the wiring claim holds whether the retry succeeded, came
 * back exhausted, or errored. That keeps this deterministic without pretending a
 * browser is always present.
 */

import { test, expect, describe, afterAll } from "bun:test";
import { resolveAndExecute } from "../src/orchestrator/index.js";

const server = Bun.serve({
  port: 0,
  fetch(req) {
    if (new URL(req.url).pathname.startsWith("/product/")) {
      // A concrete detail path answered by a collection.
      return Response.json([{ id: 1, name: "a" }, { id: 2, name: "b" }, { id: 3, name: "c" }]);
    }
    return new Response("<html><body>nothing here</body></html>", {
      headers: { "content-type": "text/html" },
    });
  },
});

afterAll(() => server.stop(true));

const fallbackSteps = (out: { trace?: { decision_trace?: Array<{ step: string }> } }) =>
  (out.trace?.decision_trace ?? []).filter((s) => s.step.startsWith("browser_fallback_"));

describe("resolveAndExecute consults the browser fallback", () => {
  test("a shape-mismatched miss triggers the fallback instead of returning terminally", async () => {
    const out = await resolveAndExecute(
      "get the product details",
      {},
      { url: `http://127.0.0.1:${server.port}/product/12345`, domain: "127.0.0.1" },
      undefined,
      { local_skills_only: true },
    );

    const steps = fallbackSteps(out);
    expect(
      steps.length,
      "no browser_fallback_* step on the trace — the orchestrator never consulted the fallback",
    ).toBe(1);
    expect(steps[0].reason).toContain("response_shape_mismatch");

    // Whatever the retry produced, the old terminal shape must not survive
    // untouched: either it was rescued, or the attempt is recorded on the trace.
    if (out.trace?.success === true) {
      expect(steps[0].step).toBe("browser_fallback_rescued");
      expect(out.browser_opened).toBe(true);
    } else {
      expect(["browser_fallback_exhausted", "browser_fallback_error"]).toContain(steps[0].step);
      // A failed rescue keeps the ORIGINAL diagnosis rather than a vaguer one.
      expect(out.trace?.error).toBe("response_shape_mismatch");
    }
  }, 60_000);

  test("a request with no URL never escalates (nothing to descend into)", async () => {
    // Depending on which rung answers first, the no-URL path either RETURNS a
    // no-cached-match or THROWS "Pass context.url to trigger live capture" —
    // the earlier version of this test assumed the first and failed whenever
    // the second happened, which is an ambient-network coin flip. The invariant
    // is the same either way and is what actually matters: no URL, no browser.
    try {
      const out = await resolveAndExecute("some intent with no url", {}, undefined, undefined, {
        local_skills_only: true,
      });
      expect(fallbackSteps(out)).toEqual([]);
      expect(out.browser_opened).not.toBe(true);
    } catch (err) {
      // Throwing before any fallback is reachable satisfies the invariant too.
      expect(err).toBeInstanceOf(Error);
      expect((err as Error).message).toContain("context.url");
    }
  }, 60_000);
});
