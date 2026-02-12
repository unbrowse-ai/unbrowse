import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTools } from "../src/plugin/tools/index.js";

function makeTmpDir(prefix: string) {
  return mkdtempSync(join(tmpdir(), prefix));
}

function makePublishDeps(opts: {
  skillsDir: string;
  publishValidationWithAuth: boolean;
  onPublish: (payload: any) => void;
}) {
  const { skillsDir, publishValidationWithAuth, onPublish } = opts;
  return {
    logger: console,
    browserPort: 18791,
    defaultOutputDir: skillsDir,
    autoDiscoverEnabled: true,
    enableChromeCookies: false,
    enableDesktopAutomation: false,
    publishValidationWithAuth,
    skillIndexUrl: "http://127.0.0.1:0",
    indexClient: {
      publish: async (payload: any) => {
        onPublish(payload);
        return {
          success: true,
          skill: { skillId: "sk_test_1", name: payload.name },
        };
      },
    },
    indexOpts: { indexUrl: "http://127.0.0.1:0" },
    walletState: { creatorWallet: "CreatorWallet111", solanaPrivateKey: "PrivateKey111" },
    creatorWallet: "CreatorWallet111",
    solanaPrivateKey: "PrivateKey111",
    vaultDbPath: join(skillsDir, "vault.db"),
    credentialProvider: null,
    discovery: { markLearned() {}, onBrowserToolCall: async () => [] },
    autoPublishSkill: async () => null,
    detectAndSaveRefreshConfig: () => {},
    getOrCreateBrowserSession: async () => ({}),
    getSharedBrowser: () => null,
    closeChrome: async () => {},
    browserSessions: new Map(),
  } as any;
}

describe("unbrowse_publish validation auth passthrough", () => {
  let skillsDir: string;
  const service = "svc-auth-test";

  beforeEach(() => {
    skillsDir = makeTmpDir("unbrowse-publish-auth-");
    const skillDir = join(skillsDir, service);
    mkdirSync(join(skillDir, "scripts"), { recursive: true });
    writeFileSync(
      join(skillDir, "SKILL.md"),
      [
        "---",
        `name: ${service}`,
        "description: test skill",
        "---",
        "",
        `# ${service}`,
        "",
        "- `GET /api/me`",
      ].join("\n"),
      "utf-8",
    );
    writeFileSync(join(skillDir, "scripts", "api.ts"), "export const x = 1;\n", "utf-8");
    writeFileSync(
      join(skillDir, "auth.json"),
      JSON.stringify(
        {
          baseUrl: "https://example.com",
          authMethod: "cookie",
          headers: {
            Authorization: "Bearer abc123",
            "X-CSRF-Token": "csrf123",
          },
          cookies: {
            session: "sess123",
            auth: "cookie456",
          },
        },
        null,
        2,
      ),
      "utf-8",
    );
  });

  afterEach(() => {
    rmSync(skillsDir, { recursive: true, force: true });
  });

  it("sends validationAuth when publishValidationWithAuth=true", async () => {
    let captured: any = null;
    const toolsFn = createTools(makePublishDeps({
      skillsDir,
      publishValidationWithAuth: true,
      onPublish: (p) => { captured = p; },
    }));
    const tools = toolsFn({} as any) as any[];
    const publishTool = tools.find((t) => t.name === "unbrowse_publish");

    const result = await publishTool.execute("t1", { service, skillsDir });
    const text = result?.content?.[0]?.text ?? "";

    expect(captured).toBeTruthy();
    expect(captured.validationAuth).toBeTruthy();
    expect(captured.validationAuth.headers.Authorization).toBe("Bearer abc123");
    expect(captured.validationAuth.cookies).toContain("session=sess123");
    expect(text).toContain("Validation auth: sent (opt-in)");
  });

  it("does not send validationAuth when publishValidationWithAuth=false", async () => {
    let captured: any = null;
    const toolsFn = createTools(makePublishDeps({
      skillsDir,
      publishValidationWithAuth: false,
      onPublish: (p) => { captured = p; },
    }));
    const tools = toolsFn({} as any) as any[];
    const publishTool = tools.find((t) => t.name === "unbrowse_publish");

    await publishTool.execute("t2", { service, skillsDir });

    expect(captured).toBeTruthy();
    expect(captured.validationAuth).toBeUndefined();
  });
});
