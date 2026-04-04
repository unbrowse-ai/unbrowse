import { beforeEach, describe, expect, it, mock } from "bun:test";

const calls = {
  start: 0,
  stop: 0,
  newTab: 0,
  harStart: 0,
  harStop: 0,
  navigate: 0,
  getCurrentUrl: 0,
  getPageHtml: 0,
  closeTab: 0,
};

let resolveMode: "hit" | "miss" = "hit";
let nextTabId = "tab-1";

mock.module("../src/kuri/client.js", () => ({
  start: async () => {
    calls.start += 1;
  },
  stop: async () => {
    calls.stop += 1;
  },
  newTab: async () => {
    calls.newTab += 1;
    return nextTabId;
  },
  harStart: async () => {
    calls.harStart += 1;
  },
  harStop: async () => {
    calls.harStop += 1;
    return { entries: [], raw: {} };
  },
  navigate: async () => {
    calls.navigate += 1;
  },
  getCurrentUrl: async () => {
    calls.getCurrentUrl += 1;
    return "https://example.com/live";
  },
  getPageHtml: async () => {
    calls.getPageHtml += 1;
    return "<html><body>live</body></html>";
  },
  closeTab: async () => {
    calls.closeTab += 1;
  },
}));

mock.module("../src/orchestrator/index.js", () => ({
  resolveAndExecute: async () => {
    if (resolveMode === "miss") throw new Error("cache miss");
    return {
      result: { ok: true },
      trace: { success: true },
      source: "marketplace",
      skill: undefined,
    };
  },
  generateLocalDescription: () => "",
}));

mock.module("../src/auth/index.js", () => ({
  importBrowserCookiesIntoTab: async () => 0,
  loadAuthProfileBestEffort: async () => false,
  saveAuthProfileBestEffort: async () => false,
}));

mock.module("../src/reverse-engineer/index.js", () => ({
  extractEndpoints: () => [],
  extractAuthHeaders: () => ({}),
}));

mock.module("../src/indexer/index.js", () => ({
  queueBackgroundIndex: () => {},
}));

mock.module("../src/marketplace/index.js", () => ({
  mergeEndpoints: (_existing: unknown, incoming: unknown) => incoming,
}));

mock.module("../src/graph/index.js", () => ({
  buildSkillOperationGraph: () => ({ nodes: [], edges: [] }),
}));

mock.module("../src/graph/agent-augment.js", () => ({
  augmentEndpointsWithAgent: async (endpoints: unknown) => endpoints,
}));

mock.module("../src/client/index.js", () => ({
  findExistingSkillForDomain: () => null,
  cachePublishedSkill: () => {},
}));

mock.module("../src/vault/index.js", () => ({
  storeCredential: async () => {},
}));

mock.module("nanoid", () => ({
  nanoid: () => "test-nanoid",
}));

const { Browser } = await import("../src/browser/index.js");

describe("Browser lazy Kuri tabs", () => {
  beforeEach(() => {
    resolveMode = "hit";
    nextTabId = "tab-1";
    for (const key of Object.keys(calls) as Array<keyof typeof calls>) {
      calls[key] = 0;
    }
  });

  it("does not open a blank Kuri tab for cache-hit goto", async () => {
    const browser = await Browser.launch();
    const page = await browser.newPage();

    expect(page.hasTab).toBe(false);

    const response = await page.goto("https://example.com/search?q=lazy");

    expect(response.headers()["x-unbrowse-source"]).toBe("marketplace");
    expect(page.hasTab).toBe(false);
    expect(page.tabId).toBeNull();
    expect(calls.newTab).toBe(0);
    expect(calls.navigate).toBe(0);

    await browser.close();
  });

  it("creates a tab only when browser fallback is actually needed", async () => {
    resolveMode = "miss";

    const browser = await Browser.launch();
    const page = await browser.newPage();

    expect(page.hasTab).toBe(false);

    const response = await page.goto("https://example.com/fallback");

    expect(response.headers()["x-unbrowse-source"]).toBe("browser");
    expect(page.hasTab).toBe(true);
    expect(page.tabId).toBe("tab-1");
    expect(calls.newTab).toBe(1);
    expect(calls.harStart).toBe(1);
    expect(calls.navigate).toBe(1);
    expect(calls.getCurrentUrl).toBe(1);
    expect(calls.getPageHtml).toBe(1);

    await browser.close();
    expect(calls.closeTab).toBe(1);
  });
});
