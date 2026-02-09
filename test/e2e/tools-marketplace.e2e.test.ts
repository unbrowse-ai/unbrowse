import { describe, it, expect } from "bun:test";

import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createTools } from "../../src/plugin/tools/index.js";
import { SkillIndexClient } from "../../src/skill-index.js";
import { generateBase58Keypair } from "../../src/solana/solana-helpers.js";
import { withBackend } from "./backend-harness.js";

function makeTmpDir(prefix: string) {
  return mkdtempSync(join(tmpdir(), prefix));
}

describe("Plugin tools (marketplace e2e)", () => {
  it("unbrowse_publish publishes a local skill directory", { timeout: 180_000 }, async () => {
    await withBackend(async (backend) => {
      const skillsDir = makeTmpDir("unbrowse-skills-");
      const { publicKey, privateKeyB58 } = await generateBase58Keypair();

      // Minimal local skill package.
      const suffix = Math.random().toString(16).slice(2, 10);
      const service = `demo-service-${suffix}`;
      const skillDir = join(skillsDir, service);
      mkdirSync(join(skillDir, "scripts"), { recursive: true });
      writeFileSync(
        join(skillDir, "SKILL.md"),
        [
          "---",
          `name: ${service}`,
          "description: >-",
          "  End-to-end test skill published from a local folder to validate unbrowse_publish against a real backend.",
          "---",
          `# ${service}`,
          "",
          "This skill is intentionally verbose so it passes backend validation rules (min lengths).",
          "It is published during automated integration tests and should be deleted afterwards.",
          "",
        ].join("\n"),
        "utf-8",
      );
      writeFileSync(
        join(skillDir, "auth.json"),
        JSON.stringify({ baseUrl: `https://${service}.example.com`, authMethod: "cookie" }, null, 2),
        "utf-8",
      );
      writeFileSync(join(skillDir, "scripts", "api.ts"), `export class DemoClient {}\n`, "utf-8");

      const walletState = { creatorWallet: publicKey, solanaPrivateKey: privateKeyB58 };
      const indexOpts = { indexUrl: backend.baseUrl, creatorWallet: publicKey, solanaPrivateKey: privateKeyB58 };
      const indexClient = new SkillIndexClient(indexOpts);

      const toolsFn = createTools({
        logger: console,
        browserPort: 18791,
        defaultOutputDir: skillsDir,
        autoDiscoverEnabled: true,
        enableChromeCookies: false,
        enableOtpAutoFill: false,
        enableDesktopAutomation: false,
        skillIndexUrl: backend.baseUrl,
        indexClient,
        indexOpts,
        walletState,
        creatorWallet: publicKey,
        solanaPrivateKey: privateKeyB58,
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
      const publishTool = tools.find((t) => t.name === "unbrowse_publish");
      expect(!!publishTool).toBe(true);

      const res = await publishTool.execute("t1", { service, skillsDir });
      const txt = res?.content?.[0]?.text ?? "";
      expect(typeof txt).toBe("string");

      const id = (String(txt).match(/^ID:\s*(.+)$/m)?.[1] ?? "").trim();
      expect(id.length).toBeGreaterThan(5);

      // Verify the published skill is fetchable from the marketplace.
      const fetched = await indexClient.getSkillSummary(id);
      expect(fetched.skillId).toBe(id);
    });
  });

  it("unbrowse_search install writes SKILL.md/scripts/references locally", { timeout: 180_000 }, async () => {
    await withBackend(async (backend) => {
      const skillsDir = makeTmpDir("unbrowse-skills-");
      const indexClient = new SkillIndexClient({ indexUrl: backend.baseUrl });

      const { publicKey, privateKeyB58 } = await generateBase58Keypair();
      const authed = new SkillIndexClient({
        indexUrl: backend.baseUrl,
        creatorWallet: publicKey,
        solanaPrivateKey: privateKeyB58,
      });

      const suffix = Math.random().toString(16).slice(2, 10);
      const name = `e2e-install-${suffix}`;
      const published = await authed.publish({
        name,
        description:
          "End-to-end test skill used by unbrowse-openclaw to validate unbrowse_search install against a real backend.",
        skillMd: [
          "---",
          `name: ${name}`,
          "description: >-",
          "  End-to-end test skill used by unbrowse-openclaw to validate install behavior against a real backend.",
          "---",
          `# ${name}`,
          "",
          "This skill is published during tests and deleted afterwards.",
          "It is intentionally verbose so it passes backend validation rules (min lengths).",
          "Safe to delete.",
          "",
        ].join("\n"),
        priceUsdc: "0",
        scripts: { "api.ts": "export class E2EInstallClient {}\n" },
        references: { "README.md": "hello\n" },
      });
      const installId = published.skill.skillId;

      const toolsFn = createTools({
        logger: console,
        browserPort: 18791,
        defaultOutputDir: skillsDir,
        autoDiscoverEnabled: true,
        enableChromeCookies: false,
        enableOtpAutoFill: false,
        enableDesktopAutomation: false,
        skillIndexUrl: backend.baseUrl,
        indexClient,
        indexOpts: { indexUrl: backend.baseUrl },
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
      const searchTool = tools.find((t) => t.name === "unbrowse_search");
      expect(!!searchTool).toBe(true);

      await searchTool.execute("t2", { install: installId, skillsDir });

      const installedDir = join(skillsDir, name);
      expect(existsSync(join(installedDir, "SKILL.md"))).toBe(true);
      expect(existsSync(join(installedDir, "scripts", "api.ts"))).toBe(true);
      expect(existsSync(join(installedDir, "references", "README.md"))).toBe(true);

      const md = readFileSync(join(installedDir, "SKILL.md"), "utf-8");
      expect(md.includes(name)).toBe(true);
    });
  });
});
