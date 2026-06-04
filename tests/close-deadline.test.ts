// withDeadline bounds the broker-dependent work in unbrowse_close so a wedged
// kuri broker (un-timed closeTab/harStop IPC) can never hang the close forever.
import { test, expect } from "bun:test";
import { withDeadline, withDeadlineResult } from "../src/lib/deadline.js";

const slow = <T>(v: T, ms: number) => new Promise<T>((r) => setTimeout(() => r(v), ms));

test("returns the value when the promise settles before the deadline", async () => {
  const out = await withDeadline(slow("indexed", 5), 200, "TIMEOUT");
  expect(out).toBe("indexed");
});

test("returns the fallback (does NOT hang) when the promise exceeds the deadline", async () => {
  const start = Date.now();
  const out = await withDeadline(slow("never-in-time", 10_000), 50, "TIMEOUT");
  const elapsed = Date.now() - start;
  expect(out).toBe("TIMEOUT");
  expect(elapsed).toBeLessThan(500); // bounded — did not wait 10s
});

test("a rejecting promise resolves to the fallback (close still returns)", async () => {
  const out = await withDeadline(Promise.reject(new Error("broker wedged")), 200, "FALLBACK");
  expect(out).toBe("FALLBACK");
});

test("withDeadlineResult reports whether the deadline fired", async () => {
  expect((await withDeadlineResult(slow(1, 5), 200, 0)).timedOut).toBe(false);
  expect((await withDeadlineResult(slow(1, 10_000), 30, 0)).timedOut).toBe(true);
});
