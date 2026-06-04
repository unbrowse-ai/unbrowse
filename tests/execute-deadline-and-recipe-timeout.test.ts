import { afterEach, describe, expect, test } from "bun:test";
import { withExecuteDeadline, replayRecipe } from "../src/execution/index.js";

// Execute must never hang indefinitely. replayRecipe, serverFetch, and the
// browser fallback can each stall on a server that holds the connection open
// without completing the body (observed live: a public GET geojson hung >90s
// across the replay + server paths while curl returned in ~1.2s). These cover
// the two bounded-fetch guarantees: the replayRecipe per-fetch timeout and the
// route-level overall deadline backstop.

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

describe("withExecuteDeadline — overall execute backstop", () => {
  test("returns the timeout fallback when the work never settles (no hang)", async () => {
    const fallback = { timedOut: true };
    const result = await withExecuteDeadline(new Promise<typeof fallback>(() => {}), 40, () => fallback);
    expect(result).toBe(fallback);
  });

  test("returns the real work result when it settles in time", async () => {
    const result = await withExecuteDeadline(Promise.resolve("data"), 1000, () => ({ timedOut: true }));
    expect(result).toBe("data");
  });

  test("does not fire the fallback for fast work even with a tiny budget headroom", async () => {
    const result = await withExecuteDeadline(
      new Promise<string>((r) => setTimeout(() => r("ok"), 5)),
      500,
      () => "TIMEOUT",
    );
    expect(result).toBe("ok");
  });
});

describe("replayRecipe — bounded fetch", () => {
  test("times out instead of hanging when the server never completes the body", async () => {
    // Mock fetch that respects the abort signal (as real fetch does) but never
    // resolves on its own — simulates a server holding the connection open.
    globalThis.fetch = ((_url: RequestInfo | URL, init?: RequestInit) =>
      new Promise((_resolve, reject) => {
        const signal = init?.signal;
        if (signal) {
          signal.addEventListener("abort", () =>
            reject(new DOMException("The operation timed out.", "TimeoutError")),
          );
        }
      })) as typeof fetch;

    const recipe = { method: "GET", headers: {} } as unknown as Parameters<typeof replayRecipe>[0];
    const result = await replayRecipe(recipe, "https://hang.test/feed", [], {}, {}, 50);
    // catch path returns status 0 → matchResponseSignal fails → caller falls
    // through to the timed serverFetch path. A bounded, honest failure.
    expect(result.status).toBe(0);
  });
});
