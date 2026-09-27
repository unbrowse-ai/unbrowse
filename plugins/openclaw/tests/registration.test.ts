import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import entry from "../src/index.ts";
import { CORE_TOOLS, readConfig, register, safeToolName } from "../src/plugin.ts";
import { fakeApi } from "./helpers.ts";

const root = join(import.meta.dir, "..");
const manifest = JSON.parse(readFileSync(join(root, "openclaw.plugin.json"), "utf8"));
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const upstream = JSON.parse(readFileSync(join(root, "../../skill/references/tools.json"), "utf8")).tools as { name: string; inputSchema: unknown }[];
const RESERVED = ["status", "ok", "success", "error", "timedOut", "exitCode"];

describe("registration", () => {
  const { api, tools, providers, hooks } = fakeApi();
  register(api);

  test("one tool per core Unbrowse tool, host-safe names", () => {
    expect(tools.length).toBe(upstream.length);
    expect(tools.map((t) => t.name)).toEqual(upstream.map((t) => safeToolName(t.name)));
    for (const t of tools) expect(t.name).toMatch(/^[A-Za-z0-9_-]{1,64}$/);
    expect(new Set(tools.map((t) => t.name)).size).toBe(tools.length);
    expect(tools.map((t) => t.name)).toContain("unbrowse_scrape");
    expect(tools.map((t) => t.name)).toContain("unbrowse_browse_open");
  });

  test("contracts.tools lists exactly the registered tools", () => {
    expect([...manifest.contracts.tools].sort()).toEqual(tools.map((t) => t.name).sort());
  });

  test("schemas are the core JSON Schemas, object-typed; every tool has label + description", () => {
    for (const t of tools) {
      const src = upstream.find((u) => safeToolName(u.name) === t.name)!;
      expect(t.parameters).toEqual(src.inputSchema as never);
      expect(t.parameters.type).toBe("object");
      expect(t.label.length).toBeGreaterThan(0);
      expect(t.description.length).toBeGreaterThan(0);
      expect(t.resultContentSource).toBe("network");
    }
  });

  test("web_fetch provider id is declared in contracts.webFetchProviders", () => {
    expect(providers.map((p) => p.id)).toEqual(manifest.contracts.webFetchProviders);
  });

  test("registers a typed before_tool_call hook", () => {
    expect(hooks.before_tool_call?.length).toBe(1);
  });

  test("no registerWebFetchProvider on an older host: tools and hook still register", () => {
    const f = fakeApi();
    delete (f.api as { registerWebFetchProvider?: unknown }).registerWebFetchProvider;
    register(f.api);
    expect(f.tools.length).toBe(upstream.length);
    expect(f.hooks.before_tool_call?.length).toBe(1);
  });

  test("the entry is a definition object whose register delegates", () => {
    expect(entry.id).toBe(manifest.id);
    const f = fakeApi();
    entry.register(f.api);
    expect(f.tools.length).toBe(CORE_TOOLS.length);
  });

  test("reserved outcome keys never appear in the details wrapper keys", () => {
    for (const k of ["unbrowseTool", "structured"]) expect(RESERVED).not.toContain(k);
  });
});

describe("manifest + package", () => {
  test("required manifest fields", () => {
    expect(manifest.id).toBe("unbrowse");
    expect(manifest.configSchema.type).toBe("object");
    expect(manifest.configSchema.additionalProperties).toBe(false);
    expect(manifest.skills).toEqual(["./skills"]);
    expect(manifest.activation.onStartup).toBe(true);
    expect(manifest.version).toBe(pkg.version);
  });

  test("configSchema properties are exactly what readConfig reads", () => {
    expect(Object.keys(manifest.configSchema.properties).sort()).toEqual(Object.keys(readConfig({})).sort());
    expect(readConfig({})).toEqual({ apiKey: undefined, mcpUrl: undefined, endUser: undefined, replaceBrowser: true, blockWebFetch: false });
    expect(readConfig({ replaceBrowser: false, blockWebFetch: true, apiKey: "  " })).toMatchObject({ replaceBrowser: false, blockWebFetch: true, apiKey: undefined });
  });

  test("package.json: ESM, extension entry, no runtime dependencies, openclaw peer", () => {
    expect(pkg.type).toBe("module");
    expect(pkg.openclaw.extensions).toEqual(["./dist/index.js"]);
    expect(pkg.dependencies).toBeUndefined();
    expect(pkg.peerDependencies.openclaw).toBeDefined();
    for (const f of ["dist", "skills", "openclaw.plugin.json", "README.md"]) expect(pkg.files).toContain(f);
  });

  test("ships the synced skill (byte-identical to skill/)", () => {
    for (const f of ["SKILL.md", "references/tools.json"]) {
      expect(readFileSync(join(root, "skills/unbrowse", f)).equals(readFileSync(join(root, "../../skill", f)))).toBe(true);
    }
  });

  test("build --check: manifest is current", () => {
    expect(execFileSync("node", ["scripts/build.mjs", "--check"], { cwd: root, encoding: "utf8" })).toContain("OPENCLAW_MANIFEST_OK");
  });

  test("README exists and names every config key", () => {
    const readme = readFileSync(join(root, "README.md"), "utf8");
    for (const k of Object.keys(manifest.configSchema.properties)) expect(readme).toContain(k);
  });
});

describe("built dist/index.js", () => {
  const dist = join(root, "dist/index.js");
  test.skipIf(!existsSync(dist))("bundles the SDK: no bare imports, registers every tool", async () => {
    const code = readFileSync(dist, "utf8");
    expect(code).not.toMatch(/^import .* from ["'](?!node:)[^./]/m);
    expect(code).not.toContain("@unbrowse/sdk");
    const mod = await import(dist);
    const f = fakeApi();
    mod.default.register(f.api);
    expect(f.tools.map((t) => t.name).sort()).toEqual([...manifest.contracts.tools].sort());
    expect(f.providers.length).toBe(1);
  });
});
