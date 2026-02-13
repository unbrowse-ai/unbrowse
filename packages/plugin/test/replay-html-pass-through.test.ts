import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { makeUnbrowseReplayTool } from "../src/plugin/tools/unbrowse_replay.js";

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

  it("passes through text/html responses in node mode (does not mark as failed)", async () => {
    const service = "svc";
    const skillDir = join(root, service);
    mkdirSync(skillDir, { recursive: true });

    writeFileSync(join(skillDir, "SKILL.md"), "# Skill\n\n- `GET /ssr`\n", "utf-8");
    writeFileSync(join(skillDir, "auth.json"), JSON.stringify({ baseUrl: "https://example.com" }, null, 2), "utf-8");

    globalThis.fetch = (async () => {
      return new Response("<html><body>ok</body></html>", {
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

    const tool = makeUnbrowseReplayTool(deps);
    const res = await tool.execute("toolcall", {
      service,
      skillsDir: root,
      endpoint: "GET /ssr",
      executionMode: "node",
    });

    const text = res?.content?.[0]?.text ?? "";
    expect(text).toContain("Results: 1 passed, 0 failed");
    expect(text).toContain("OK (Node.js) (HTML)");
  });
});

