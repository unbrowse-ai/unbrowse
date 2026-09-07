/**
 * Unit tests for `stormSafe`, the wrapper used by GET /v1/stats/deep to fan
 * out to many sub-calls inside Promise.all without letting one flaky
 * dependency 500 the whole envelope.
 *
 * Pure unit tests on the helper, so the suite has no mock.module() side
 * effects that would leak into other test files in the same bun:test run.
 */
import { describe, expect, it } from "bun:test";
import { stormSafe, type Block } from "../src/services/storm-safe.js";

describe("stormSafe", () => {
  it("returns { ok: true, value } when the fn resolves", async () => {
    const result: Block<number> = await stormSafe(async () => 42);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toBe(42);
    }
  });

  it("captures a synchronous throw inside the fn body", async () => {
    const result = await stormSafe<number>(async () => {
      throw new Error("sync boom");
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe("sync boom");
    }
  });

  it("captures an async rejection", async () => {
    const result = await stormSafe<number>(
      () => Promise.reject(new Error("async boom")),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe("async boom");
    }
  });

  it("stringifies non-Error rejections that have no message prop", async () => {
    const result = await stormSafe<number>(() => Promise.reject("plain string failure"));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe("plain string failure");
    }
  });
});
