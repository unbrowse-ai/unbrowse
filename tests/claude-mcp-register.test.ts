// Real-file test for the claude-mcp-register setup hook.
// Uses an injected ClaudeCliAdapter (deterministic available()/register())
// and a per-test scratch HOME so we never touch the user's real config and
// never depend on spawnSync PATH resolution.
//
// What this proves end-to-end against real fs + real JSON parsing:
// 1. mergeAllowList preserves existing entries, dedupes, sorts
// 2. registerWithClaudeCode is idempotent (second run adds 0)
// 3. Pre-existing settings keys (defaultMode, other permissions) survive
// 4. Adapter-reports-unavailable → skip with structured reason, no fs write
// 5. explicit skip flag → no fs write
// 6. Fresh ~/(internal) dir + missing settings.json → created cleanly

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  mergeAllowList,
  applyAllowList,
  registerWithClaudeCode,
  UNBROWSE_MCP_TOOL_NAMES,
  type ClaudeCliAdapter,
} from "../src/setup/claude-mcp-register.ts";

let scratch = "";

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), "unbrowse-claude-register-"));
});

afterEach(() => {
  try { rmSync(scratch, { recursive: true, force: true }); } catch { /* ignore */ }
});

function presentAdapter(opts: { alreadyRegistered?: boolean; registerOk?: boolean } = {}): ClaudeCliAdapter {
  return {
    available: () => true,
    serverAlreadyRegistered: () => opts.alreadyRegistered ?? false,
    registerServer: () => opts.registerOk ?? true,
  };
}

function absentAdapter(): ClaudeCliAdapter {
  return {
    available: () => false,
    serverAlreadyRegistered: () => false,
    registerServer: () => false,
  };
}

describe("mergeAllowList", () => {
  it("dedupes additions against existing", () => {
    const r = mergeAllowList(["a", "b"], ["b", "c"]);
    expect(r.merged).toEqual(["a", "b", "c"]);
    expect(r.added).toBe(1);
    expect(r.already).toBe(1);
  });

  it("treats non-array existing as empty", () => {
    const r = mergeAllowList(undefined, ["x", "y"]);
    expect(r.merged).toEqual(["x", "y"]);
    expect(r.added).toBe(2);
    expect(r.already).toBe(0);
  });

  it("sorts the merged result for diff readability", () => {
    const r = mergeAllowList(["z", "a"], ["m"]);
    expect(r.merged).toEqual(["a", "m", "z"]);
  });
});

describe("applyAllowList", () => {
  it("preserves unrelated top-level keys", () => {
    const { settings } = applyAllowList({ defaultMode: "auto", env: { FOO: "1" } }, ["x"]);
    expect((settings as { defaultMode: string }).defaultMode).toBe("auto");
    expect((settings as { env: { FOO: string } }).env.FOO).toBe("1");
  });

  it("preserves other permissions keys (deny, ask) when present", () => {
    const { settings } = applyAllowList(
      { permissions: { deny: ["Bash(rm *)"], ask: ["Edit"], allow: ["existing"] } },
      ["new"],
    );
    const perms = (settings as { permissions: Record<string, unknown> }).permissions;
    expect(perms.deny).toEqual(["Bash(rm *)"]);
    expect(perms.ask).toEqual(["Edit"]);
    expect(perms.allow).toContain("existing");
    expect(perms.allow).toContain("new");
  });
});

describe("registerWithClaudeCode", () => {
  it("skips with claude_cli_not_found when adapter says unavailable", async () => {
    const r = await registerWithClaudeCode({
      serverCommand: "bun",
      serverArgs: ["run", "/tmp/mcp.ts"],
      homeDir: scratch,
      adapter: absentAdapter(),
    });
    expect(r.skipped).toBe(true);
    expect(r.skip_reason).toBe("claude_cli_not_found");
    expect(r.allowlist_entries_added).toBe(0);
    expect(existsSync(join(scratch, "(internal)", "settings.json"))).toBe(false);
  });

  it("skips cleanly when explicit skip flag is passed", async () => {
    const r = await registerWithClaudeCode({
      serverCommand: "bun",
      serverArgs: ["run", "/tmp/mcp.ts"],
      homeDir: scratch,
      skip: true,
      adapter: presentAdapter(),
    });
    expect(r.skipped).toBe(true);
    expect(r.skip_reason).toBe("explicit_skip_flag");
    expect(existsSync(join(scratch, "(internal)", "settings.json"))).toBe(false);
  });

  it("preserves existing allow entries and is idempotent on second run", async () => {
    const settingsDir = join(scratch, "(internal)");
    mkdirSync(settingsDir, { recursive: true });
    const settingsPath = join(settingsDir, "settings.json");
    writeFileSync(settingsPath, JSON.stringify({
      permissions: { allow: ["Bash(ls *)", "mcp__muonry__read"] },
      defaultMode: "auto",
    }, null, 2));

    const r1 = await registerWithClaudeCode({
      serverCommand: "bun",
      serverArgs: ["run", "/tmp/mcp.ts"],
      homeDir: scratch,
      adapter: presentAdapter(),
    });
    expect(r1.skipped).toBe(false);
    expect(r1.allowlist_entries_added).toBe(UNBROWSE_MCP_TOOL_NAMES.length);
    expect(r1.allowlist_entries_already_present).toBe(0);

    const after1 = JSON.parse(readFileSync(settingsPath, "utf-8"));
    expect(after1.permissions.allow).toContain("Bash(ls *)");
    expect(after1.permissions.allow).toContain("mcp__muonry__read");
    expect(after1.permissions.allow).toContain("mcp__unbrowse__unbrowse_close");
    expect(after1.defaultMode).toBe("auto");

    const r2 = await registerWithClaudeCode({
      serverCommand: "bun",
      serverArgs: ["run", "/tmp/mcp.ts"],
      homeDir: scratch,
      adapter: presentAdapter({ alreadyRegistered: true }),
    });
    expect(r2.allowlist_entries_added).toBe(0);
    expect(r2.allowlist_entries_already_present).toBe(UNBROWSE_MCP_TOOL_NAMES.length);

    const after2 = readFileSync(settingsPath, "utf-8");
    const after1Str = readFileSync(settingsPath, "utf-8");
    expect(after2).toBe(after1Str);
  });

  it("creates settings.json fresh when it does not exist", async () => {
    const r = await registerWithClaudeCode({
      serverCommand: "bun",
      serverArgs: ["run", "/tmp/mcp.ts"],
      homeDir: scratch,
      adapter: presentAdapter(),
    });
    expect(r.skipped).toBe(false);
    expect(r.allowlist_entries_added).toBe(UNBROWSE_MCP_TOOL_NAMES.length);

    const settingsPath = join(scratch, "(internal)", "settings.json");
    expect(existsSync(settingsPath)).toBe(true);
    const data = JSON.parse(readFileSync(settingsPath, "utf-8"));
    expect(Array.isArray(data.permissions.allow)).toBe(true);
    expect(data.permissions.allow).toContain("mcp__unbrowse__unbrowse_close");
    expect(data.permissions.allow).toContain("mcp__unbrowse__unbrowse_go");
  });

  it("reports server already registered when adapter says so (no duplicate register)", async () => {
    let registerCalls = 0;
    const adapter: ClaudeCliAdapter = {
      available: () => true,
      serverAlreadyRegistered: () => true,
      registerServer: () => { registerCalls += 1; return true; },
    };
    const r = await registerWithClaudeCode({
      serverCommand: "bun",
      serverArgs: ["run", "/tmp/mcp.ts"],
      homeDir: scratch,
      adapter,
    });
    expect(r.mcp_server_registered).toBe(true);
    expect(registerCalls).toBe(0);
  });

  it("short-circuits with already_configured when server + all 41 allow entries are already present (no fs.write)", async () => {
    const settingsDir = join(scratch, "(internal)");
    mkdirSync(settingsDir, { recursive: true });
    const settingsPath = join(settingsDir, "settings.json");

    // First-install run populates settings.json with all 41 entries
    const first = await registerWithClaudeCode({
      serverCommand: "bun",
      serverArgs: ["run", "/tmp/mcp.ts"],
      homeDir: scratch,
      adapter: presentAdapter({ alreadyRegistered: true }),
    });
    expect(first.already_configured).toBe(false);
    expect(first.allowlist_entries_added).toBeGreaterThan(0);

    const beforeStat = require("node:fs").statSync(settingsPath);
    const beforeContent = readFileSync(settingsPath, "utf-8");

    // Wait so any second write would shift mtime
    await new Promise((r) => setTimeout(r, 10));

    // Second run: server registered AND all entries present → short-circuit
    const second = await registerWithClaudeCode({
      serverCommand: "bun",
      serverArgs: ["run", "/tmp/mcp.ts"],
      homeDir: scratch,
      adapter: presentAdapter({ alreadyRegistered: true }),
    });
    expect(second.already_configured).toBe(true);
    expect(second.allowlist_entries_added).toBe(0);
    expect(second.allowlist_entries_already_present).toBeGreaterThan(0);

    // File is unchanged byte-for-byte AND mtime did not move (proves no write)
    const afterStat = require("node:fs").statSync(settingsPath);
    expect(readFileSync(settingsPath, "utf-8")).toBe(beforeContent);
    expect(afterStat.mtimeMs).toBe(beforeStat.mtimeMs);
  });
});
