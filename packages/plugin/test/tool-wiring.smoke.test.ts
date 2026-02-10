import { describe, it, expect } from "bun:test";

import { createTools } from "../src/plugin/tools/index.js";

describe("tool wiring", () => {
  it("tool names are unique and non-empty", () => {
    const toolsFn = createTools({
      logger: console,
      browserPort: 18791,
      defaultOutputDir: "/tmp/unbrowse-skills",
      autoDiscoverEnabled: true,
      enableChromeCookies: false,
      enableOtpAutoFill: false,
      enableDesktopAutomation: false,
      skillIndexUrl: "http://localhost",
      indexClient: {} as any,
      indexOpts: { indexUrl: "http://localhost" },
      walletState: {},
      creatorWallet: undefined,
      solanaPrivateKey: undefined,
      vaultDbPath: "/tmp/unbrowse-vault.db",
      credentialProvider: null,
      discovery: { markLearned() {}, onBrowserToolCall: async () => [] },
      autoPublishSkill: async () => null,
      detectAndSaveRefreshConfig: () => {},
      getOrCreateBrowserSession: async () => ({}),
      startPersistentOtpWatcher: async () => {},
      isOtpWatcherActive: () => false,
      getSharedBrowser: () => null,
      closeChrome: async () => {},
      browserSessions: new Map(),
    } as any);

    const tools = toolsFn({} as any);
    const names = tools.map((t: any) => t?.name).filter(Boolean);

    expect(names.length).toBe(tools.length);
    expect(names.every((n: any) => typeof n === "string" && n.length > 0)).toBe(true);

    const uniq = new Set(names);
    expect(uniq.size).toBe(names.length);
  });
});

