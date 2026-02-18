import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createToolList } from "@getfoundry/unbrowse-core";

describe("unbrowse_replay", () => {
  let root: string;
  let prevFetch: typeof globalThis.fetch;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "unbrowse-replay-"));
    prevFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = prevFetch;
    rmSync(root, { recursive: true, force: true });
  });

  it("passes through text/html responses in node mode (does not mark as failed) and can save full body", async () => {
    const service = "svc";
    const skillDir = join(root, service);
    mkdirSync(skillDir, { recursive: true });

    writeFileSync(join(skillDir, "SKILL.md"), "# Skill\n\n- `GET /ssr`\n", "utf-8");
    writeFileSync(join(skillDir, "auth.json"), JSON.stringify({ baseUrl: "https://example.com" }, null, 2), "utf-8");
    mkdirSync(join(skillDir, "references"), { recursive: true });
    writeFileSync(
      join(skillDir, "references", "TRANSFORMS.json"),
      JSON.stringify([
        { method: "GET", normalizedPath: "/ssr", transformCode: "(html) => ({ size: html.length })" },
      ], null, 2),
      "utf-8",
    );

    const html = `<html><body>${"x".repeat(9000)}</body></html>`;

    globalThis.fetch = (async () => {
      return new Response(html, {
        status: 200,
        headers: { "content-type": "text/html; charset=utf-8" },
      });
    }) as any;

    const deps: any = {
      logger: { info() { }, warn() { }, error() { }, debug() { } },
      browserPort: 0,
      allowLegacyPlaywrightFallback: false,
      defaultOutputDir: root,
      autoDiscoverEnabled: false,
      enableChromeCookies: false,
      enableDesktopAutomation: false,
      publishValidationWithAuth: false,
      skillIndexUrl: "http://localhost",
      indexClient: {},
      indexOpts: { indexUrl: "http://localhost" },
      walletState: {},
      vaultDbPath: join(root, "vault.sqlite"),
      credentialProvider: null,
      discovery: null,
      autoPublishSkill: async () => null,
      detectAndSaveRefreshConfig: () => { },
      getOrCreateBrowserSession: async () => null,
      getSharedBrowser: () => null,
      closeChrome: async () => { },
      browserSessions: new Map(),
    };

    const tool = createToolList(deps).find((t: any) => t?.name === "unbrowse_replay");
    if (!tool) throw new Error("unbrowse_replay tool not found");
    const res = await tool.execute("toolcall", {
      service,
      skillsDir: root,
      endpoint: "GET /ssr",
      executionMode: "node",
      storeRaw: true,
      maxResponseChars: 2000,
    });

    const text = res?.content?.[0]?.text ?? "";
    expect(text).toContain("Results: 1 passed, 0 failed");
    expect(text).toContain("OK (Node.js) (HTML)");
    expect(text).toContain("\"size\":");

    const replayDir = join(skillDir, "replays");
    const files = readdirSync(replayDir).filter((name) => name.endsWith(".html"));
    expect(files.length).toBe(1);
    const saved = readFileSync(join(replayDir, files[0]), "utf-8");
    expect(saved.length).toBe(html.length);
  });

  it("applies TRANSFORMS.json in backend mode using canonical rawPath (proxy endpoint -> upstream)", async () => {
    const service = "svc-backend";
    const skillDir = join(root, service);
    mkdirSync(join(skillDir, "references"), { recursive: true });

    const endpointId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    writeFileSync(join(skillDir, "SKILL.md"), `# Skill\n\n- \`GET /__endpoint/${endpointId}\`\n`, "utf-8");
    writeFileSync(join(skillDir, "auth.json"), JSON.stringify({ baseUrl: "https://example.com" }, null, 2), "utf-8");
    writeFileSync(join(skillDir, "marketplace.json"), JSON.stringify({ skillId: "sk_test_1" }, null, 2), "utf-8");
    writeFileSync(
      join(skillDir, "references", "ENDPOINTS.json"),
      JSON.stringify([{ endpointId, method: "GET", normalizedPath: `/__endpoint/${endpointId}` }], null, 2),
      "utf-8",
    );
    writeFileSync(
      join(skillDir, "references", "TRANSFORMS.json"),
      JSON.stringify([{ method: "GET", normalizedPath: "/ssr", transformCode: "(html) => ({ htmlLen: html.length })" }], null, 2),
      "utf-8",
    );

    let sawRawMode = false;
    const html = "<!doctype html><html><body>hello</body></html>";

    const deps: any = {
      logger: { info() { }, warn() { }, error() { }, debug() { } },
      browserPort: 0,
      allowLegacyPlaywrightFallback: false,
      defaultOutputDir: root,
      autoDiscoverEnabled: false,
      enableChromeCookies: false,
      enableDesktopAutomation: false,
      publishValidationWithAuth: false,
      skillIndexUrl: "http://localhost",
      indexClient: {
        getSkillEndpoints: async () => ([
          {
            endpointId,
            method: "GET",
            normalizedPath: `/__endpoint/${endpointId}`,
            rawPath: "/ssr",
          },
        ]),
        executeEndpoint: async (_id: string, req: any) => {
          if (req?.context?.responseMode === "raw") sawRawMode = true;
          return { ok: true, statusCode: 200, data: html };
        },
      },
      indexOpts: { indexUrl: "http://localhost" },
      walletState: { creatorWallet: "x", solanaPrivateKey: "y" },
      vaultDbPath: join(root, "vault.sqlite"),
      credentialProvider: null,
      discovery: null,
      autoPublishSkill: async () => null,
      detectAndSaveRefreshConfig: () => { },
      getOrCreateBrowserSession: async () => null,
      getSharedBrowser: () => null,
      closeChrome: async () => { },
      browserSessions: new Map(),
    };

    const tool = createToolList(deps).find((t: any) => t?.name === "unbrowse_replay");
    if (!tool) throw new Error("unbrowse_replay tool not found");
    const res = await tool.execute("toolcall", {
      service,
      skillsDir: root,
      endpoint: `GET /__endpoint/${endpointId}`,
      executionMode: "backend",
    });

    const text = res?.content?.[0]?.text ?? "";
    expect(sawRawMode).toBe(true);
    expect(text).toContain("Results: 1 passed, 0 failed");
    expect(text).toContain("\"htmlLen\":");
  });
});
