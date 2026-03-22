import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";

test("exports plugin metadata", async () => {
  const mod = await import("../index.ts");
  const plugin = mod.default as { id?: string; name?: string; register?: unknown };

  assert.equal(plugin.id, "unbrowse-openclaw");
  assert.equal(plugin.name, "Unbrowse Browser");
  assert.equal(typeof plugin.register, "function");
});

test("strict mode bootstrap guide forbids browser fallback", async () => {
  const mod = await import("../index.ts");
  const guide = mod.__test.buildBootstrapGuide(mod.__test.normalizeConfig({ routingMode: "strict" }));

  assert.match(guide, /strict mode/i);
  assert.match(guide, /Do not use `browser`/);
});

test("fallback mode config keeps browser available", async () => {
  const mod = await import("../index.ts");
  const snippet = mod.__test.buildSuggestedConfig("fallback");

  assert.match(snippet, /"unbrowse-openclaw"/);
  assert.doesNotMatch(snippet, /load:\s*\{/);
  assert.doesNotMatch(snippet, /deny: \["browser"\]/);
});

test("resolves the installed unbrowse bin from package metadata", async () => {
  const mod = await import("../index.ts");
  const binPath = mod.__test.resolveUnbrowseBin(mod.__test.normalizeConfig({}));

  assert.match(binPath, /dist\/cli\.js$/);
  assert.equal(existsSync(binPath), true);
});

test("resolve action maps to unbrowse CLI args", async () => {
  const mod = await import("../index.ts");
  const args = mod.__test.buildArgs({
    action: "resolve",
    intent: "get prices",
    url: "https://example.com",
    path: "data.items[]",
    extract: "title,price",
    limit: 5,
    dryRun: true,
  });

  assert.deepEqual(args, [
    "resolve",
    "--intent",
    "get prices",
    "--url",
    "https://example.com",
    "--path",
    "data.items[]",
    "--extract",
    "title,price",
    "--limit",
    "5",
    "--dry-run",
  ]);
});

test("prompt guidance makes unbrowse the default web path", async () => {
  const mod = await import("../index.ts");
  const guide = mod.__test.buildBootstrapGuide(mod.__test.normalizeConfig({ routingMode: "strict" }));
  const systemPrompt = mod.__test.buildPromptGuidance(
    mod.__test.normalizeConfig({ routingMode: "strict" }),
  );

  assert.match(guide, /Use `unbrowse` as the default web path/);
  assert.match(systemPrompt, /`unbrowse` tool is the preferred website path/);
  assert.match(systemPrompt, /Strict mode is on/);
});

test("strict mode block reason points agents back to the Unbrowse path", async () => {
  const mod = await import("../index.ts");
  const reason = mod.__test.buildBrowserFallbackBlockReason();

  assert.match(reason, /`browser` is disabled/);
  assert.match(reason, /Use `unbrowse`/);
});

test("strict mode registers a before_tool_call hook that blocks browser", async () => {
  const mod = await import("../index.ts");
  const hooks: Array<{ event: string; handler: (...args: any[]) => any; options?: Record<string, unknown> }> = [];
  const plugin = mod.default as unknown as { register: (api: Record<string, unknown>) => void };

  plugin.register({
    pluginConfig: { routingMode: "strict" },
    logger: { info() {}, warn() {} },
    registerTool() {},
    registerCli() {},
    registerService() {},
    registerHook(event: string, handler: (...args: any[]) => any, options?: Record<string, unknown>) {
      hooks.push({ event, handler, options });
    },
  });

  const hook = hooks.find((entry) => entry.event === "before_tool_call");
  assert.ok(hook, "expected before_tool_call hook in strict mode");

  const blocked = await hook!.handler({ toolName: "browser" });
  assert.equal(blocked?.block, true);
  assert.match(String(blocked?.blockReason ?? ""), /Use `unbrowse`/);

  const allowed = await hook!.handler({ toolName: "unbrowse" });
  assert.equal(allowed, undefined);
});

test("before_prompt_build injects unbrowse-first system prompt guidance", async () => {
  const mod = await import("../index.ts");
  const hooks: Array<{ event: string; handler: (...args: any[]) => any }> = [];
  const plugin = mod.default as unknown as { register: (api: Record<string, unknown>) => void };

  plugin.register({
    pluginConfig: { routingMode: "strict", preferInBootstrap: true, healthcheckOnStart: false },
    logger: { info() {}, warn() {} },
    registerTool() {},
    registerCli() {},
    registerService() {},
    registerHook(event: string, handler: (...args: any[]) => any) {
      hooks.push({ event, handler });
    },
  });

  const hook = hooks.find((entry) => entry.event === "before_prompt_build");
  assert.ok(hook, "expected before_prompt_build hook");

  const result = await hook!.handler({});
  assert.match(String(result?.systemPrompt ?? ""), /preferred website path/);
  assert.match(String(result?.systemPrompt ?? ""), /Use `unbrowse` first/);
});

test("plugin manifest ships the browser-routing skill", () => {
  const manifest = JSON.parse(
    readFileSync(new URL("../openclaw.plugin.json", import.meta.url), "utf8"),
  ) as { skills?: string[] };

  assert.deepEqual(manifest.skills, ["./skills"]);
  assert.match(
    readFileSync(new URL("../skills/unbrowse-browser/SKILL.md", import.meta.url), "utf8"),
    /Route website tasks through the Unbrowse-backed browser path/,
  );
});
