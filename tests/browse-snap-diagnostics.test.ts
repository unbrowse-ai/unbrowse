// Regression: snap returned `{snapshot: ""}` with zero context for the agent
// when the a11y tree was unavailable (page still hydrating, captcha, broker
// misconfig). The agent had no actionable signal. diagnoseSnapshot wraps the
// empty case with a structured warning + concrete next_step.

import { describe, expect, it } from "bun:test";
import { diagnoseSnapshot } from "../src/api/browse-snap-diagnostics.js";

describe("diagnoseSnapshot", () => {
  it("returns empty object for a non-empty snapshot", () => {
    const result = diagnoseSnapshot("[e0] RootWebArea \"page title\"", "https://example.com");
    expect(result).toEqual({});
  });

  it("returns warning + next_step for an empty snapshot with a URL", () => {
    const result = diagnoseSnapshot("", "https://www.reddit.com/r/programming");
    expect(result.warning).toBe("empty_snapshot");
    expect(typeof result.next_step).toBe("string");
    expect(result.next_step).toContain("https://www.reddit.com/r/programming");
    expect(result.next_step).toContain("unbrowse_snap again");
    expect(result.next_step).toContain("unbrowse_screenshot");
  });

  it("returns warning + next_step when URL is null (no URL context)", () => {
    const result = diagnoseSnapshot("", null);
    expect(result.warning).toBe("empty_snapshot");
    expect(result.next_step).toContain("the current page");
  });

  it("returns warning + next_step when URL is undefined", () => {
    const result = diagnoseSnapshot("", undefined);
    expect(result.warning).toBe("empty_snapshot");
    expect(result.next_step).toContain("the current page");
  });

  it("treats a non-string snapshot as not-empty (safe default)", () => {
    // The handler should only call this when it has a string snapshot from
    // the broker. We defensively treat non-strings as "do not warn" so we
    // don't false-positive on malformed broker responses.
    const result = diagnoseSnapshot(null as unknown as string, "https://example.com");
    expect(result).toEqual({});
  });
});
