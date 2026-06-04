import { describe, expect, test } from "bun:test";
import { parseCmdRunArgs } from "../src/cli";

describe("parseCmdRunArgs", () => {
  test("positional both: url + intent fragments", () => {
    const result = parseCmdRunArgs(["https://x.com", "find", "shoes"], {});
    expect(result).toEqual({ url: "https://x.com", intent: "find shoes" });
  });

  test("flag url + positional intent (the regression)", () => {
    const result = parseCmdRunArgs(["find", "shoes"], { url: "https://x.com" });
    expect(result).toEqual({ url: "https://x.com", intent: "find shoes" });
  });

  test("all flags: url and intent both via flags", () => {
    const result = parseCmdRunArgs([], { url: "https://x.com", intent: "find shoes" });
    expect(result).toEqual({ url: "https://x.com", intent: "find shoes" });
  });

  test("missing intent: positional url alone", () => {
    const result = parseCmdRunArgs(["https://x.com"], {});
    expect("error" in result).toBe(true);
    if ("error" in result) {
      expect(result.error.startsWith("usage:")).toBe(true);
    }
  });

  test("flag url alone, no intent anywhere", () => {
    const result = parseCmdRunArgs([], { url: "https://x.com" });
    expect("error" in result).toBe(true);
    if ("error" in result) {
      expect(result.error.startsWith("usage:")).toBe(true);
    }
  });
});
