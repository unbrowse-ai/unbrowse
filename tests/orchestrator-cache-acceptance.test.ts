import { describe, expect, it } from "bun:test";
import { assessIntentResult } from "../src/intent-match.js";

describe("cache-hit intent acceptance", () => {
  it("rejects empty linkedin retrieve payloads", () => {
    expect(assessIntentResult("", "search people").verdict).toBe("fail");
    expect(assessIntentResult({ elements: [] }, "search people").verdict).toBe("fail");
  });
});
