// Register the unbrowse MCP server with Claude Code so new users don't have
// to wire it manually, and append the unbrowse tool allow-list to the user's
// ~/.claude/settings.json so the parallel MCP flow doesn't trigger 41
// permission prompts on first call.
//
// Idempotent: re-running is safe. If claude CLI isn't installed we skip
// cleanly (no install gates on Claude Code presence). Existing entries in
// allow[] are preserved; we never overwrite, never reorder, never trim.
//
// Truthful: the substrate-enables principle says we surface what's declared
// without lying. The user's allow-list represents their explicit consent for
// these tools to run unprompted, so the setup command asks before writing
// (callable opt-out via --no-claude-register).

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { spawnSync } from "node:child_process";

// The mcp__unbrowse__* tool names the MCP server exposes. Kept in sync
// with src/mcp.ts tools[]. Update both when adding a tool.
export const UNBROWSE_MCP_TOOL_NAMES: readonly string[] = [
  "unbrowse_resolve",
  "unbrowse_execute",
  "unbrowse_fetch",
  "unbrowse_feedback",
  "unbrowse_reflect",
  "unbrowse_review",
  "unbrowse_publish",
  "unbrowse_publish_suggestions",
  "unbrowse_health",
  "unbrowse_go",
  "unbrowse_snap",
  "unbrowse_close",
  "unbrowse_sync",
  "unbrowse_click",
  "unbrowse_fill",
  "unbrowse_type",
  "unbrowse_press",
  "unbrowse_select",
  "unbrowse_scroll",
  "unbrowse_submit",
  "unbrowse_screenshot",
  "unbrowse_text",
  "unbrowse_markdown",
  "unbrowse_cookies",
  "unbrowse_eval",
  "unbrowse_index",
  "unbrowse_settings",
  "unbrowse_auth_capture",
  "unbrowse_sessions",
  "unbrowse_skill",
  "unbrowse_skills",
  "unbrowse_diagnose",
  "unbrowse_validate",
  "unbrowse_run",
  "unbrowse_trace",
  "unbrowse_stats",
  "unbrowse_earnings",
  "unbrowse_annotate",
  "billing_portal_url",
  "billing_status",
  "billing_subscribe_url",
] as const;
export interface RegisterClaudeMcpResult {
  claude_cli_present: boolean;
  mcp_server_registered: boolean;
  mcp_server_command: string;
  allowlist_entries_added: number;
  allowlist_entries_already_present: number;
  settings_path: string;
  skipped: boolean;
  skip_reason?: string;
  // True when this run was a no-op short-circuit: the MCP server was already
  // registered at user scope AND all unbrowse tool allow entries were already
  // present in settings.json. Caller can use this to avoid noisy reporting
  // and to skip the file write entirely (saves an fs.writeFileSync per setup
  // call after first-install).
  already_configured: boolean;
}

// Pure helper: merges new allow entries into an existing allow array,
// preserving everything that was there, deduplicating, and sorting for diff
// readability. Returns the merged list plus counts so callers can report.
export function mergeAllowList(
  currentAllow: unknown,
  additions: readonly string[],
): { merged: string[]; added: number; already: number } {
  const existing = new Set<string>(
    Array.isArray(currentAllow)
      ? (currentAllow.filter((x) => typeof x === "string") as string[])
      : [],
  );
  let added = 0;
  let already = 0;
  for (const a of additions) {
    if (existing.has(a)) already += 1;
    else { existing.add(a); added += 1; }
  }
  return { merged: [...existing].sort(), added, already };
}

// Pure helper: applies a merged allow list to a settings.json shape and
// returns the new settings object. Preserves all other keys (defaultMode,
// other permissions, etc.) and the existing permissions structure.
export function applyAllowList(
  currentSettings: Record<string, unknown>,
  additions: readonly string[],
): { settings: Record<string, unknown>; added: number; already: number } {
  const settings: Record<string, unknown> = { ...currentSettings };
  if (!settings.permissions || typeof settings.permissions !== "object") {
    settings.permissions = {};
  }
  const perms = settings.permissions as Record<string, unknown>;
  const { merged, added, already } = mergeAllowList(perms.allow, additions);
  perms.allow = merged;
  return { settings, added, already };
}

// Injection point for tests: lets unit tests substitute a deterministic
// claude-CLI presence + register behavior without touching spawnSync.
export interface ClaudeCliAdapter {
  available(): boolean;
  /**
   * Whether an MCP server with the given entryName is already registered at
   * user scope in ~/.claude.json. The entryName argument was added when the
   * registrar was extended to register more than just `unbrowse` (e.g. the
   * /contract bridge). Existing callers that omit it default to `unbrowse`
   * for backward compatibility.
   */
  serverAlreadyRegistered(homeDir: string, entryName?: string): boolean;
  /**
   * Register an MCP server at user scope. entryName is the key under which
   * it appears in ~/.claude.json's mcpServers map. Defaults to `unbrowse`.
   */
  registerServer(
    serverCommand: string,
    serverArgs: string[],
    env: Record<string, string>,
    entryName?: string,
  ): boolean;
}

export function realClaudeCliAdapter(): ClaudeCliAdapter {
  return {
    available(): boolean {
      const r = spawnSync("claude", ["--version"], { stdio: "ignore", timeout: 5000 });
      return r.status === 0;
    },
    serverAlreadyRegistered(homeDir: string, entryName = "unbrowse"): boolean {
      const claudeJson = join(homeDir, ".claude.json");
      if (!existsSync(claudeJson)) return false;
      try {
        const data = JSON.parse(readFileSync(claudeJson, "utf-8"));
        return !!data?.mcpServers?.[entryName];
      } catch {
        return false;
      }
    },
    registerServer(serverCommand, serverArgs, env, entryName = "unbrowse"): boolean {
      const envArgs = Object.entries(env).flatMap(([k, v]) => ["-e", `${k}=${v}`]);
      const args = [
        "mcp", "add", entryName,
        "--scope", "user",
        ...envArgs,
        "--", serverCommand, ...serverArgs,
      ];
      const r = spawnSync("claude", args, { stdio: "pipe", timeout: 15000 });
      return r.status === 0;
    },
  };
}

/**
 * Register a sibling MCP server entry with Claude Code WITHOUT touching the
 * unbrowse-specific allow-list. Used by the /contract bridge registration so
 * we don't mis-attribute mcp__contract__* tools to the unbrowse consent surface
 * (those tools get permission-prompted by Claude Code's normal flow the first
 * time they're called, which is the right semantics — consent for /contract
 * belongs to the user, not to unbrowse setup).
 */
export async function registerSiblingMcpServer(opts: {
  entryName: string;
  serverCommand: string;
  serverArgs: string[];
  env?: Record<string, string>;
  skip?: boolean;
  homeDir?: string;
  adapter?: ClaudeCliAdapter;
}): Promise<{
  claude_cli_present: boolean;
  mcp_server_registered: boolean;
  already_present: boolean;
  skipped: boolean;
  skip_reason?: string;
  entry_name: string;
}> {
  const adapter = opts.adapter ?? realClaudeCliAdapter();
  const home = opts.homeDir ?? homedir();
  if (opts.skip) {
    return {
      claude_cli_present: false,
      mcp_server_registered: false,
      already_present: false,
      skipped: true,
      skip_reason: "explicit_skip_flag",
      entry_name: opts.entryName,
    };
  }
  if (!adapter.available()) {
    return {
      claude_cli_present: false,
      mcp_server_registered: false,
      already_present: false,
      skipped: true,
      skip_reason: "claude_cli_not_found",
      entry_name: opts.entryName,
    };
  }
  const already = adapter.serverAlreadyRegistered(home, opts.entryName);
  if (already) {
    return {
      claude_cli_present: true,
      mcp_server_registered: true,
      already_present: true,
      skipped: false,
      entry_name: opts.entryName,
    };
  }
  const registered = adapter.registerServer(
    opts.serverCommand,
    opts.serverArgs,
    opts.env ?? {},
    opts.entryName,
  );
  return {
    claude_cli_present: true,
    mcp_server_registered: registered,
    already_present: false,
    skipped: false,
    entry_name: opts.entryName,
  };
}

export async function registerWithClaudeCode(opts: {
  serverCommand: string;
  serverArgs: string[];
  env?: Record<string, string>;
  skip?: boolean;
  homeDir?: string;          // override for tests
  adapter?: ClaudeCliAdapter; // override for tests
} = { serverCommand: "", serverArgs: [] }): Promise<RegisterClaudeMcpResult> {
  const env = opts.env ?? {
    UNBROWSE_PER_SESSION_KURI: "1",
    KURI_CLEAN_ROOM: "1",
    HEADLESS: "true",
  };
  const home = opts.homeDir ?? homedir();
  const settingsPath = join(home, ".claude", "settings.json");
  const allowEntries = UNBROWSE_MCP_TOOL_NAMES.map((name) => `mcp__unbrowse__${name}`);
  const adapter = opts.adapter ?? realClaudeCliAdapter();

  if (opts.skip) {
    return {
      claude_cli_present: false,
      mcp_server_registered: false,
      mcp_server_command: `${opts.serverCommand} ${opts.serverArgs.join(" ")}`.trim(),
      allowlist_entries_added: 0,
      allowlist_entries_already_present: 0,
      settings_path: settingsPath,
      skipped: true,
      skip_reason: "explicit_skip_flag",
      already_configured: false,
    };
  }

  if (!adapter.available()) {
    return {
      claude_cli_present: false,
      mcp_server_registered: false,
      mcp_server_command: `${opts.serverCommand} ${opts.serverArgs.join(" ")}`.trim(),
      allowlist_entries_added: 0,
      allowlist_entries_already_present: 0,
      settings_path: settingsPath,
      skipped: true,
      skip_reason: "claude_cli_not_found",
      already_configured: false,
    };
  }

  // Short-circuit: if the MCP server is already at user scope AND every
  // unbrowse tool is already in the allow list, do not touch the file.
  // First-install writes once; subsequent `unbrowse setup` calls are no-ops.
  // Same logic any caller would do — moved into the substrate so callers
  // can't accidentally re-write a settled file.
  const serverAlreadyRegistered = adapter.serverAlreadyRegistered(home);
  if (serverAlreadyRegistered && existsSync(settingsPath)) {
    try {
      const existing = JSON.parse(readFileSync(settingsPath, "utf-8")) as Record<string, unknown>;
      const existingAllow = (existing?.permissions as { allow?: unknown })?.allow;
      const { added } = mergeAllowList(existingAllow, allowEntries);
      if (added === 0) {
        return {
          claude_cli_present: true,
          mcp_server_registered: true,
          mcp_server_command: `${opts.serverCommand} ${opts.serverArgs.join(" ")}`.trim(),
          allowlist_entries_added: 0,
          allowlist_entries_already_present: allowEntries.length,
          settings_path: settingsPath,
          skipped: false,
          already_configured: true,
        };
      }
    } catch {
      // Fall through to the merge/write path below.
    }
  }

  // Register the MCP server at user scope if it isn't already there.
  let serverRegistered = serverAlreadyRegistered;
  if (!serverRegistered) {
    serverRegistered = adapter.registerServer(opts.serverCommand, opts.serverArgs, env);
  }

  // Merge the allow-list entries into the settings.json under
  // permissions.allow (the schema Claude Code reads at session start).
  const settingsDir = dirname(settingsPath);
  if (!existsSync(settingsDir)) mkdirSync(settingsDir, { recursive: true });

  let current: Record<string, unknown> = {};
  if (existsSync(settingsPath)) {
    try {
      current = JSON.parse(readFileSync(settingsPath, "utf-8")) as Record<string, unknown>;
    } catch {
      writeFileSync(`${settingsPath}.backup-${Date.now()}`, readFileSync(settingsPath, "utf-8"));
      current = {};
    }
  }
  const { settings, added, already } = applyAllowList(current, allowEntries);
  writeFileSync(settingsPath, `${JSON.stringify(settings, null, 2)}\n`);

  return {
    claude_cli_present: true,
    mcp_server_registered: serverRegistered,
    mcp_server_command: `${opts.serverCommand} ${opts.serverArgs.join(" ")}`.trim(),
    allowlist_entries_added: added,
    allowlist_entries_already_present: already,
    settings_path: settingsPath,
    skipped: false,
    already_configured: false,
  };
}
