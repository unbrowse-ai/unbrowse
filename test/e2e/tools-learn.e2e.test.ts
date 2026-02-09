import { describe, it, expect } from "bun:test";

import { mkdtempSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { createTools } from "../../src/plugin/tools/index.js";

function makeTmpDir(prefix: string) {
  return mkdtempSync(join(tmpdir(), prefix));
}

describe("Plugin tools (learn e2e)", () => {
  it("unbrowse_learn generates a skill folder from a HAR fixture", { timeout: 60_000 }, async () => {
    const skillsDir = makeTmpDir("unbrowse-skills-");
    const fixtureHarPath = join(dirname(fileURLToPath(import.meta.url)), "../oct/fixtures/example.har");
    expect(existsSync(fixtureHarPath)).toBe(true);

    const toolsFn = createTools({
      logger: console,
      browserPort: 18791,
      defaultOutputDir: skillsDir,
      autoDiscoverEnabled: true,
      enableChromeCookies: false,
      enableOtpAutoFill: false,
      enableDesktopAutomation: false,
      skillIndexUrl: "http://127.0.0.1:0",
      indexClient: null,
      indexOpts: { indexUrl: "http://127.0.0.1:0" },
      walletState: {},
      creatorWallet: undefined,
      solanaPrivateKey: undefined,
      vaultDbPath: join(skillsDir, "vault.db"),
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

    const tools = toolsFn({} as any) as any[];
    const learnTool = tools.find((t) => t.name === "unbrowse_learn");
    expect(!!learnTool).toBe(true);

    const res = await learnTool.execute("t_learn", { harPath: fixtureHarPath, outputDir: skillsDir });
    const txt = res?.content?.[0]?.text ?? "";
    expect(typeof txt).toBe("string");
    expect(String(txt)).toContain("Skill generated:");
    expect(String(txt)).toContain("Installed:");

    const installed = (String(txt).match(/^Installed:\s*(.+)$/m)?.[1] ?? "").trim();
    expect(installed.length).toBeGreaterThan(0);
    expect(existsSync(join(installed, "SKILL.md"))).toBe(true);
    expect(existsSync(join(installed, "scripts", "api.ts"))).toBe(true);

    const md = readFileSync(join(installed, "SKILL.md"), "utf-8");
    expect(md.includes("---")).toBe(true);
  });
});

