/**
 * Agent-surface contract.
 *
 * KIND_MAP is the CLI's executable public vocabulary.  It also declares the
 * intended MCP counterpart for each capability.  This gate compares that
 * declaration with the tools actually registered by src/mcp.ts; it deliberately
 * does not infer parity from legacy flat names (resolve -> unbrowse_resolve),
 * because v7 tool names include their agency class
 * (eval resolve -> unbrowse_eval_resolve).
 */
import { describe, expect, it } from "bun:test";


// Protocol/operator tests need the full MCP catalog (agent surface is default).
process.env.UNBROWSE_MCP_SURFACE = "full";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { KIND_MAP, flatCommandVerb } from "../src/cli-v7/kind-map.js";
import { parseV7Args } from "../src/cli-v7/args.js";
import { buildParsedArgsForKind } from "../src/cli-v7/dispatch/mcp-args.js";
import { TOOL_SCHEMAS } from "../src/mcp-tool-schemas.js";

const ROOT = join(__dirname, "..");
const MCP_SOURCE = readFileSync(join(ROOT, "src/mcp.ts"), "utf8");

// Protocol/harness conveniences have no CLI operation.  Each exception is a
// capability classification, not a spelling workaround.
const MCP_ONLY_CAPABILITIES = new Map<string, "protocol" | "diagnostic" | "compatibility" | "billing">([
  ["unbrowse_diagnose", "diagnostic"],
  ["unbrowse_validate", "diagnostic"],
  ["unbrowse_test_crash", "diagnostic"],
  ["unbrowse_type_audit", "diagnostic"],
  ["unbrowse_publish_suggestions", "protocol"],
  ["unbrowse_search_endpoints", "protocol"],
  // Account/commerce conveniences with no CLI operation. They were INVISIBLE to
  // this gate until the tool schemas became readable as data: the old source
  // scrape matched `^    name: "(unbrowse_[a-z_]+)"`, and these three do not
  // carry the `unbrowse_` prefix, so a contract that claims to classify every
  // MCP-only capability silently skipped them.
  ["billing_status", "billing"],
  ["billing_portal_url", "billing"],
  ["billing_subscribe_url", "billing"],
]);

// These operations are intentionally bound to the user's machine and must not
// be advertised to a remote MCP caller.  Null is itself a reviewed declaration:
// adding a null row requires classifying its capability here.
const LOCAL_ONLY_OPS = new Set([
  "build:value-source",
  "build:setup",
  "build:register",
  "build:contribute",
  "breath:serve",
  "breath:connect_chrome",
  "breath:dashboard",
  "breath:mcp",
  "breath:upgrade",
  "eval:account",
  "eval:config",
  "eval:contract",
  // Declared in kind-map (usage: "unbrowse schema <command>", mcp_tool: null)
  // but unclassified here, so this gate was already red before the schema verb
  // was implemented. Introspection reads local declarations; there is nothing
  // for a remote MCP caller to invoke.
  "eval:schema",
]);

type RegisteredTool = { name: string; properties: Set<string>; required: Set<string> };

/**
 * The registered tool surface.
 *
 * Reads TOOL_SCHEMAS as typed DATA rather than regex-parsing src/mcp.ts. The
 * scrape was fragile by construction — it matched `^    name: "..."` and the
 * exact indentation of `properties:` / `required:` — and it broke the moment the
 * schemas were split into their own module, reporting 62 registered tools as
 * "missing" when every one of them was still registered.
 *
 * The two dev/test-only tools (unbrowse_type_audit, unbrowse_test_crash) are
 * still object literals inside mcp.ts because they are conditionally registered,
 * so they are unioned in from source. Anything that later moves out of mcp.ts is
 * picked up automatically by the TOOL_SCHEMAS half.
 */
function readRegisteredMcpTools(): Map<string, RegisteredTool> {
  const result = new Map<string, RegisteredTool>();
  for (const t of TOOL_SCHEMAS) {
    result.set(t.name, {
      name: t.name,
      properties: new Set(Object.keys(t.inputSchema?.properties ?? {})),
      required: new Set(t.inputSchema?.required ?? []),
    });
  }
  // Conditional tools that remain literal in mcp.ts.
  const starts = [...MCP_SOURCE.matchAll(/^    name: "(unbrowse_[a-z_]+)",/gm)];
  for (let i = 0; i < starts.length; i++) {
    const match = starts[i]!;
    const name = match[1]!;
    if (result.has(name)) continue;
    const block = MCP_SOURCE.slice(match.index!, starts[i + 1]?.index ?? MCP_SOURCE.length);
    const schema = block.match(/inputSchema:\s*\{([\s\S]*?)\n    \},/m)?.[1] ?? "";
    const propertiesBody = schema.match(/properties:\s*\{([\s\S]*?)\n      \},/m)?.[1] ?? "";
    const requiredBody = schema.match(/required:\s*\[([^\]]*)\]/m)?.[1] ?? "";
    result.set(name, {
      name,
      properties: new Set([...propertiesBody.matchAll(/^        ([a-zA-Z_][\w]*):\s*\{/gm)].map((m) => m[1]!)),
      required: new Set([...requiredBody.matchAll(/["\']([a-zA-Z_][\w]*)["\']/g)].map((m) => m[1]!)),
    });
  }
  return result;
}

function readSdkMethods(): Set<string> {
  const source = readFileSync(join(ROOT, "packages/sdk/src/client.ts"), "utf8");
  return new Set([...source.matchAll(/^\s{2}(?:async )?([a-z][a-zA-Z]+)\(/gm)].map((m) => m[1]!).filter((n) => n !== "function"));
}

const tools = readRegisteredMcpTools();

describe("CLI v7 / MCP behavioral surface contract", () => {
  it("has unique executable identities on every CLI row", () => {
    expect(new Set(KIND_MAP.map((row) => row.subcommand)).size).toBe(KIND_MAP.length);
    expect(new Set(KIND_MAP.map((row) => row.op_kind)).size).toBe(KIND_MAP.length);
    for (const row of KIND_MAP) {
      expect(row.op_kind).toBe(`${row.verb}:${row.action}`);
      expect(row.subcommand.startsWith(`${row.verb} `)).toBe(true);
      expect(row.summary.trim().length).toBeGreaterThan(15);
    }
  });

  it("exposes every MCP-mapped CLI capability in the actual MCP registry", () => {
    const missing = KIND_MAP
      .filter((row) => row.mcp_tool !== null && !tools.has(row.mcp_tool))
      .map((row) => `${row.subcommand} -> ${row.mcp_tool}`);
    expect(missing).toEqual([]);
  });

  it("classifies every local-only CLI capability explicitly", () => {
    const declared = new Set(KIND_MAP.filter((row) => row.mcp_tool === null).map((row) => row.op_kind));
    expect([...declared].sort()).toEqual([...LOCAL_ONLY_OPS].sort());
  });

  it("classifies every MCP-only capability explicitly", () => {
    const mapped = new Set(KIND_MAP.flatMap((row) => row.mcp_tool ? [row.mcp_tool] : []));
    const extras = [...tools.keys()].filter((name) => !mapped.has(name)).sort();
    expect(extras).toEqual([...MCP_ONLY_CAPABILITIES.keys()].sort());
  });

  it("preserves agency class in MCP names instead of collapsing to aliases", () => {
    for (const row of KIND_MAP) {
      if (!row.mcp_tool) continue;
      const expectedAction = row.action.replace(/-/g, "_");
      expect(row.mcp_tool).toBe(`unbrowse_${row.verb}_${expectedAction}`);
      expect(flatCommandVerb(row.subcommand.split(" ")[1]!)).toBe(row.action === "skill" && row.verb === "build" ? "eval" : row.verb);
    }
  });

  it("gives browser and auth tools schemas with the inputs needed to act", () => {
    const agency: Record<string, { properties: string[]; required: string[] }> = {
      unbrowse_breath_navigate: { properties: ["url"], required: ["url"] },
      unbrowse_breath_auth_capture: { properties: ["url"], required: ["url"] },
      unbrowse_breath_click: { properties: ["ref"], required: ["ref"] },
      unbrowse_breath_fill: { properties: ["ref", "value"], required: ["ref", "value"] },
      unbrowse_breath_type: { properties: ["text"], required: ["text"] },
      unbrowse_breath_press: { properties: ["key"], required: ["key"] },
      unbrowse_breath_select: { properties: ["ref", "value"], required: ["ref", "value"] },
      // endpoint is optional: the skill may have a default/sole endpoint.
      unbrowse_breath_execute: { properties: ["skill", "endpoint"], required: ["skill"] },
      unbrowse_eval_resolve: { properties: ["intent"], required: ["intent"] },
      unbrowse_breath_get: { properties: ["intent", "url", "header", "bearer_token", "fresh"], required: [] },
    };
    for (const [name, contract] of Object.entries(agency)) {
      const tool = tools.get(name);
      expect(tool, `${name} must be registered`).toBeDefined();
      for (const property of contract.properties) expect(tool!.properties.has(property), `${name} must accept ${property}`).toBe(true);
      for (const property of contract.required) expect(tool!.required.has(property), `${name} must require ${property}`).toBe(true);
    }
  });

  it("preserves auth and freshness from CLI and MCP onto the same get flags without exposing values", () => {
    const cli = parseV7Args(["breath", "get", "read profile", "--url", "https://example.test/me", "--header", "X-Api-Key: cli-secret", "--fresh"]);
    expect(cli.positional).toEqual(["read profile"]);
    expect(cli.flags).toMatchObject({ url: "https://example.test/me", header: "X-Api-Key: cli-secret", fresh: true });

    const entry = KIND_MAP.find((row) => row.op_kind === "breath:get")!;
    const mcp = buildParsedArgsForKind(entry, {
      intent: "read profile",
      url: "https://example.test/me",
      bearer_token: "mcp-secret",
      fresh: true,
    }, { json: true });
    expect(mcp.positional).toEqual(["read profile"]);
    expect(mcp.flags).toMatchObject({ url: "https://example.test/me", "bearer-token": "mcp-secret", fresh: true, json: true });
    expect(JSON.stringify({ cli: cli.positional, mcp: mcp.positional })).not.toContain("cli-secret");
    expect(JSON.stringify({ cli: cli.positional, mcp: mcp.positional })).not.toContain("mcp-secret");
  });
});

describe("SDK anchors remain behaviorally reachable", () => {
  const sdk = readSdkMethods();
  const anchors = new Map([
    ["resolve", "unbrowse_eval_resolve"],
    ["execute", "unbrowse_breath_execute"],
    ["feedback", "unbrowse_eval_feedback"],
    ["stats", "unbrowse_eval_stats"],
    // SDK `health` and the v7 surfaces' `status` are the same read-only capability.
    ["health", "unbrowse_eval_status"],
  ]);

  for (const [method, tool] of anchors) {
    it(`${method} has a registered MCP agency equivalent`, () => {
      expect(sdk.has(method)).toBe(true);
      expect(tools.has(tool)).toBe(true);
      expect(KIND_MAP.some((row) => row.mcp_tool === tool)).toBe(true);
    });
  }
});
