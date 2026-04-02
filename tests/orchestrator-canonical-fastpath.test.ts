import { describe, expect, it } from "bun:test";
import { shouldBypassLiveCaptureQueue } from "../src/orchestrator/index.js";

describe("canonical live-capture fast path", () => {
  it("bypasses queue for reddit canonical document routes", () => {
    expect(shouldBypassLiveCaptureQueue("https://www.reddit.com/r/programming/")).toBe(true);
    expect(shouldBypassLiveCaptureQueue("https://www.reddit.com/search/?q=openai")).toBe(true);
  });

  it("bypasses queue for package search and install-metadata pages with canonical replay", () => {
    expect(shouldBypassLiveCaptureQueue("https://www.npmjs.com/search?q=openai")).toBe(true);
    expect(shouldBypassLiveCaptureQueue("https://www.npmjs.com/package/openai")).toBe(true);
    expect(shouldBypassLiveCaptureQueue("https://pypi.org/project/openai/")).toBe(true);
  });

  it("keeps normal queueing for non-canonical routes", () => {
    expect(shouldBypassLiveCaptureQueue("https://x.com/OpenAI")).toBe(false);
    expect(shouldBypassLiveCaptureQueue("https://www.linkedin.com/search/results/people/?keywords=openai")).toBe(false);
  });
});
