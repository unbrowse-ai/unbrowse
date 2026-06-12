/**
 * Surface-parity audit gate.
 *
 * Enumerates the three agent-facing surfaces (CLI commands, MCP tools,
 * @unbrowse/sdk methods) by parsing their declaration sites, then asserts:
 *
 *   1. The CORE_VERBS (resolve, execute, health, feedback, stats) exist in
 *      all three surfaces. These are the contract agents depend on; any
 *      regression breaks every downstream caller.
 *
 *   2. Every CLI command either has an MCP counterpart (same shape, hyphen
 *      to underscore allowed) or is on the LOCAL_ONLY allowlist (local-
 *      machine ops like `setup`, `mode`, `upgrade` that aren't agent-facing
 *      and never need an MCP tool wrapper).
 *
 *   3. Every MCP tool either has a CLI counterpart or is on the
 *      MCP_ONLY allowlist (agent-protocol additions like `reflect`,
 *      `diagnose`, `validate`, `trace`, `test_crash`).
 *
 *   4. Every SDK method either has a CLI/MCP counterpart, or is on the
 *      SDK_INFRASTRUCTURE allowlist (constructor/close/auth plumbing).
 *
 * Per CLAUDE.md "Never mock in tests" — these read the actual files on
 * disk and parse their declaration syntax. No mocks. A new CLI command
 * without an MCP counterpart immediately fails this test, surfacing the
 * regression at PR time instead of post-release.
 *
 * Substrate-faithful: the allowlists are EVIDENCE the agent (Lewis +
 * future maintainers) judges in PR review. They do NOT bake a verdict;
 * they document the current honest gap so a new gap is loud.
 */
import { describe, it, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const PROJECT_ROOT = join(__dirname, "..");

// Core verbs that MUST exist in all three surfaces. Adding to this list
// tightens the contract; removing weakens it.
const CORE_VERBS = ["resolve", "execute", "health", "feedback", "stats"] as const;

// CLI verbs that are intentionally local-only (no agent-facing surface).
// Setup / config / dashboard / upgrade are user-machine operations the
// agent does not need to call via MCP.
const LOCAL_ONLY_CLI = new Set([
  "setup", "mode", "payment-provider", "dashboard", "mcp", "upgrade",
  "account", "back", "forward", "cleanup-stale", "note", "publish-bundle",
  "capture",  // capture is the explicit "do a fresh browse + capture" verb;
              // MCP agents call go + close + sync instead (orchestration).
  "explain",  // CLI-only `unbrowse explain` (debug helper for ranking).
  "inspect",  // CLI-only `unbrowse inspect` (local skill cache walker).
  "skill-package",  // CLI-only local package/export helper; no agent MCP wrapper.
  "auth",     // Hyphen-collapsed CLI `auth-capture` is exposed as MCP `auth_capture`.
]);

// MCP tools that are intentionally agent-protocol-only (no CLI verb).
// reflect, diagnose, validate, trace, test_crash are MCP-only ergonomics
// for the agent runtime — there's no human-shaped CLI equivalent.
const MCP_PROTOCOL_ONLY = new Set([
  "reflect", "diagnose", "validate", "trace", "test_crash",
  "type_audit",  // Dev/harness tool, registered ONLY when running from source
                 // (backend/src/types.ts present). Audits type parity across
                 // backend/SDK/CLI for verify scripts — not a user-facing verb,
                 // same class as test_crash. No CLI command by design.
  "publish_suggestions", "earnings",
  "auth_capture",  // MCP normalises hyphens — CLI side is `auth-capture` or
                   // `auth --capture`; allowlisted as matched-cousin.
  "search_endpoints",  // discovery surface for agents that want a flat
                       // ranked endpoint list across the whole marketplace.
                       // CLI users get the same data via `unbrowse search`
                       // (which calls /v1/search/domain or /v1/search/resolve)
                       // shaped for human triage; the flat-endpoints route
                       // is an MCP/SDK ergonomic.
]);

// SDK methods that are infrastructure (not user-facing verbs).
const SDK_INFRASTRUCTURE = new Set([
  "constructor", "close",  // lifecycle
  "login", "stealAuth", "importAuth",  // auth plumbing
  "fundEscrow", "registerSessionKey",  // x402 wallet plumbing
  "creatorTransactions", "indexerAttribution",  // payments analytics
  "dashboardByWallet",  // alternate dashboard lookup
  "searchDomain",  // alternate search dispatch
  "search",  // backend /v1/search; agent surface uses resolve()
  "getSkill",  // sibling to MCP `skill` / CLI `skill`
]);

function readCliCommands(): Set<string> {
  // CLI commands are declared as `{ name: "<verb>", usage: ..., desc: ... }`
  // rows in the commands table in src/cli.ts.
  const cli = readFileSync(join(PROJECT_ROOT, "src/cli.ts"), "utf-8");
  const matches = cli.matchAll(/\{ name: "([a-z-]+)", usage:/g);
  return new Set(Array.from(matches, (m) => m[1]!));
}

function readMcpTools(): Set<string> {
  // MCP tools are declared as `name: "unbrowse_<verb>"` rows in
  // src/mcp.ts. Strip the `unbrowse_` prefix to compare with CLI verbs.
  const mcp = readFileSync(join(PROJECT_ROOT, "src/mcp.ts"), "utf-8");
  const matches = mcp.matchAll(/name: "unbrowse_([a-z_]+)"/g);
  return new Set(Array.from(matches, (m) => m[1]!));
}

function readSdkMethods(): Set<string> {
  // SDK methods are `async <name>(...): Promise<...>` declarations on the
  // Unbrowse class in packages/sdk/src/client.ts.
  const sdk = readFileSync(join(PROJECT_ROOT, "packages/sdk/src/client.ts"), "utf-8");
  const matches = sdk.matchAll(/^\s{2}(?:async )?([a-z][a-zA-Z]+)\(/gm);
  return new Set(Array.from(matches, (m) => m[1]!).filter((n) => n !== "function"));
}

// Hyphen ↔ underscore normalisation for cross-surface name comparison.
function normalize(name: string): string {
  return name.replace(/-/g, "_").replace(/([a-z])([A-Z])/g, "$1_$2").toLowerCase();
}

describe("CLI / MCP / SDK surface parity", () => {
  const cli = readCliCommands();
  const mcp = readMcpTools();
  const sdk = readSdkMethods();

  it("reads at least 30 CLI commands, 30 MCP tools, 15 SDK methods (sanity)", () => {
    expect(cli.size).toBeGreaterThanOrEqual(30);
    expect(mcp.size).toBeGreaterThanOrEqual(30);
    expect(sdk.size).toBeGreaterThanOrEqual(15);
  });

  describe("core verbs exist in all three surfaces", () => {
    for (const verb of CORE_VERBS) {
      it(`CLI exposes \`${verb}\``, () => {
        expect(cli.has(verb)).toBe(true);
      });
      it(`MCP exposes \`unbrowse_${verb}\``, () => {
        expect(mcp.has(verb)).toBe(true);
      });
      it(`SDK exposes \`${verb}\` method`, () => {
        expect(sdk.has(verb)).toBe(true);
      });
    }
  });

  it("every CLI command has an MCP counterpart or is on the LOCAL_ONLY allowlist", () => {
    const orphans: string[] = [];
    for (const cmd of cli) {
      if (LOCAL_ONLY_CLI.has(cmd)) continue;
      const normalized = normalize(cmd);
      if (!mcp.has(normalized)) orphans.push(cmd);
    }
    if (orphans.length > 0) {
      throw new Error(
        `CLI commands without MCP counterpart (add to LOCAL_ONLY_CLI allowlist or wire MCP tool):\n  ${orphans.join("\n  ")}`,
      );
    }
  });

  it("every MCP tool has a CLI counterpart or is on the MCP_PROTOCOL_ONLY allowlist", () => {
    const orphans: string[] = [];
    for (const tool of mcp) {
      if (MCP_PROTOCOL_ONLY.has(tool)) continue;
      // MCP underscored names may match CLI hyphenated names (e.g.
      // mcp `auth_capture` ↔ cli `auth-capture`).
      const dashed = tool.replace(/_/g, "-");
      if (!cli.has(tool) && !cli.has(dashed)) orphans.push(tool);
    }
    if (orphans.length > 0) {
      throw new Error(
        `MCP tools without CLI counterpart (add to MCP_PROTOCOL_ONLY allowlist or wire CLI command):\n  ${orphans.join("\n  ")}`,
      );
    }
  });

  it("every SDK method either has a CLI/MCP counterpart or is on the SDK_INFRASTRUCTURE allowlist", () => {
    // Build normalized index sets so camelCase SDK names match
    // hyphen/underscore CLI/MCP names symmetrically (paymentProvider <->
    // payment-provider <-> payment_provider).
    const cliNormalized = new Set([...cli].map(normalize));
    const mcpNormalized = new Set([...mcp].map(normalize));
    const orphans: string[] = [];
    for (const method of sdk) {
      if (SDK_INFRASTRUCTURE.has(method)) continue;
      const normalized = normalize(method);
      if (!cliNormalized.has(normalized) && !mcpNormalized.has(normalized)) orphans.push(method);
    }
    if (orphans.length > 0) {
      throw new Error(
        `SDK methods without CLI/MCP counterpart (add to SDK_INFRASTRUCTURE allowlist or wire elsewhere):\n  ${orphans.join("\n  ")}`,
      );
    }
  });

  it("documents the current SDK gap (CLI+MCP verbs not yet in SDK)", () => {
    // This is evidence, not a hard fail. Surface the gap so PR review
    // can decide whether to ship the missing methods now or later.
    const inBoth = new Set([...cli].filter((c) => mcp.has(normalize(c))));
    const missing = [...inBoth].filter(
      (verb) => !sdk.has(verb) && !LOCAL_ONLY_CLI.has(verb) && !SDK_INFRASTRUCTURE.has(verb),
    );
    // Allow up to a documented gap floor; tightens over time as the SDK
    // fills in. Update SDK_GAP_FLOOR downward as methods ship.
    const SDK_GAP_FLOOR = 30;
    expect(missing.length).toBeLessThanOrEqual(SDK_GAP_FLOOR);
  });
});
