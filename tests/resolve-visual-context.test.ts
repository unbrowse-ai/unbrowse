import { describe, expect, it } from "bun:test";
import { captureResolveVisualContext, type VisualContextBrowser } from "../src/browser/resolve-visual-context.js";

function fake(overrides: Partial<VisualContextBrowser> = {}) {
  const calls: string[] = [];
  const browser: VisualContextBrowser = {
    newTab: async (url) => { calls.push(`open:${url}`); return "tab-1"; },
    screenshot: async (id) => { calls.push(`shot:${id}`); return "cG5n"; },
    closeTab: async (id) => { calls.push(`close:${id}`); },
    ...overrides,
  };
  return { browser, calls };
}

describe("resolve visual_context primitive", () => {
  it("returns screenshot bytes and closes its temporary tab", async () => {
    const { browser, calls } = fake();
    const result = await captureResolveVisualContext("https://fixture.invalid/feed", browser, { settleMs: 0 });
    expect(result).toEqual({ screenshot: "cG5n" });
    expect(calls).toEqual([
      "open:https://fixture.invalid/feed",
      "shot:tab-1",
      "close:tab-1",
    ]);
  });

  it("returns null, not empty visual success, and still closes on screenshot failure", async () => {
    const { browser, calls } = fake({ screenshot: async () => { throw new Error("target_lost"); } });
    expect(await captureResolveVisualContext("https://fixture.invalid", browser, { settleMs: 0 })).toBeNull();
    expect(calls.at(-1)).toBe("close:tab-1");
  });

  it("bounds a browser that never answers", async () => {
    const { browser } = fake({ screenshot: async () => new Promise<string>(() => {}) });
    const started = Date.now();
    expect(await captureResolveVisualContext("https://fixture.invalid", browser, { settleMs: 0, timeoutMs: 30 })).toBeNull();
    expect(Date.now() - started).toBeLessThan(500);
  });
});
