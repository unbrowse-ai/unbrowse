import { describe, expect, test } from "bun:test";
import { parseCmdFillArgs, parseCmdRunArgs, shouldFillIntent } from "../src/cli";

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

  test("usage text can name the caller verb", () => {
    const result = parseCmdRunArgs(["https://x.com"], {}, "fill");
    expect("error" in result).toBe(true);
    if ("error" in result) {
      expect(result.error).toBe('usage: unbrowse fill <url> "task"');
    }
  });
});

describe("shouldFillIntent", () => {
  test("URL positional uses the one-hole fill path", () => {
    expect(shouldFillIntent(["https://news.ycombinator.com", "top", "stories"], {})).toBe(true);
  });

  test("natural language alone uses the one-hole fill path", () => {
    expect(shouldFillIntent(["top", "Hacker", "News", "stories"], {})).toBe(true);
  });

  test("--url/--intent uses the one-hole fill path", () => {
    expect(shouldFillIntent([], { url: "https://x.com", intent: "find shoes" })).toBe(true);
  });

  test("browse ref/value keeps the DOM fill path", () => {
    expect(shouldFillIntent(["e5", "hello"], {})).toBe(false);
  });
});

describe("parseCmdFillArgs", () => {
  test("natural language only becomes an intent", () => {
    expect(parseCmdFillArgs(["top", "HN", "stories"], {})).toEqual({ intent: "top HN stories" });
  });

  test("URL positional scopes the intent", () => {
    expect(parseCmdFillArgs(["https://news.ycombinator.com", "top", "stories"], {})).toEqual({
      url: "https://news.ycombinator.com",
      intent: "top stories",
    });
  });

  test("--url scopes positional natural language", () => {
    expect(parseCmdFillArgs(["top", "stories"], { url: "https://news.ycombinator.com" })).toEqual({
      url: "https://news.ycombinator.com",
      intent: "top stories",
    });
  });
});
