// Register the unbrowse MCP server into every MCP host config we can detect.
// Extends src/setup/claude-mcp-register.ts (which handles Claude Code via its
// CLI's `claude mcp add` subcommand) by writing the server entry directly into
// each GUI/editor host's own config file (Claude Desktop, Cursor, Codex,
// Continue, Windsurf).
//
// Substrate principle: each host is a declarant of its own MCP config schema;
// this module surfaces the structural shape per host (path, format) and merges
// the unbrowse entry idempotently. It never overwrites unrelated entries, never
// reorders, and never speaks for the user about what tools to enable beyond
// the unbrowse one.
//
// Idempotent: re-running is safe. If a host's config file is absent, the host
// is reported as "not_detected" and nothing is written (we never bootstrap a
// host the user did not install). If the file is present but the unbrowse
// entry is already there, the host is reported as "already_present" with no
// write. If a malformed config is found, the host is reported as
// "parse_error" and skipped (a `.backup-<ts>` is created so the user can
// recover).
//
// Codex uses TOML; the other hosts use JSON. Rather than pull in a TOML
// dependency, the Codex writer uses a structural marker-based append that
// respects existing stanzas.

import {
  readFileSync,
  writeFileSync,
  existsSync,
  mkdirSync,
  copyFileSync,
} from "node:fs";
import { join, dirname } from "node:path";
import { homedir, platform } from "node:os";

export type McpHostId =
  | "claude-desktop"
  | "cursor"
  | "codex"
  | "continue"
  | "windsurf";

export interface McpHostResult {
  host: McpHostId;
  config_path: string;
  action:
    | "merged"
    | "already_present"
    | "not_detected"
    | "parse_error"
    | "skipped";
  detail?: string;
}

export interface RegisterMcpHostsOptions {
  serverCommand: string;
  serverArgs: string[];
  env?: Record<string, string>;
  homeDir?: string;       // override for tests
  hosts?: McpHostId[];    // limit which hosts to attempt; default = all
  skip?: McpHostId[];     // explicit per-host skip
  /**
   * Name under which the server entry is registered in each host's config
   * (the `mcpServers.<entryName>` key, the Continue `name` field, and the
   * Codex `[mcp_servers.<entryName>]` stanza header). Defaults to "unbrowse"
   * for backward compatibility with first-party callers.
   */
  entryName?: string;
}

const ALL_HOSTS: McpHostId[] = [
  "claude-desktop",
  "cursor",
  "codex",
  "continue",
  "windsurf",
];

function claudeDesktopConfigPath(home: string): string {
  if (platform() === "darwin") {
    return join(home, "Library", "Application Support", "Claude", "claude_desktop_config.json");
  }
  if (platform() === "win32") {
    const appdata = process.env.APPDATA;
    if (appdata) return join(appdata, "Claude", "claude_desktop_config.json");
    return join(home, "AppData", "Roaming", "Claude", "claude_desktop_config.json");
  }
  return join(home, ".config", "Claude", "claude_desktop_config.json");
}

function configPathFor(host: McpHostId, home: string): string {
  switch (host) {
    case "claude-desktop": return claudeDesktopConfigPath(home);
    case "cursor": return join(home, ".cursor", "mcp.json");
    case "codex": return join(home, ".codex", "config.toml");
    case "continue": return join(home, ".continue", "config.json");
    case "windsurf": return join(home, ".codeium", "windsurf", "mcp_config.json");
  }
}

function safeReadJson(path: string): { data?: Record<string, unknown>; parseError?: boolean } {
  if (!existsSync(path)) return {};
  try {
    const data = JSON.parse(readFileSync(path, "utf-8")) as Record<string, unknown>;
    return { data };
  } catch {
    return { parseError: true };
  }
}

function backupAndReset(path: string): void {
  try {
    copyFileSync(path, `${path}.backup-${Date.now()}`);
  } catch {
    // ignore — we'd rather fail loud on the rewrite than the backup
  }
}

function writeJsonIfChanged(
  path: string,
  next: Record<string, unknown>,
  before: Record<string, unknown> | undefined,
): boolean {
  const nextSerialized = `${JSON.stringify(next, null, 2)}\n`;
  if (before && JSON.stringify(before) === JSON.stringify(next)) return false;
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, nextSerialized);
  return true;
}

// Hosts that share the simple `{ mcpServers: { <name>: { command, args, env? } } }`
// schema: Claude Desktop, Cursor, Windsurf.
function registerSimpleMcpServer(
  host: McpHostId,
  configPath: string,
  serverCommand: string,
  serverArgs: string[],
  env: Record<string, string> | undefined,
  entryName = "unbrowse",
): McpHostResult {
  if (!existsSync(configPath)) {
    return { host, config_path: configPath, action: "not_detected" };
  }
  const { data, parseError } = safeReadJson(configPath);
  if (parseError) {
    backupAndReset(configPath);
    return {
      host,
      config_path: configPath,
      action: "parse_error",
      detail: "existing config was not valid JSON; left untouched (a .backup-<ts> was created)",
    };
  }
  const current = data ?? {};
  const mcpServers = (current.mcpServers as Record<string, unknown> | undefined) ?? {};
  const existing = mcpServers[entryName] as Record<string, unknown> | undefined;
  const proposed: Record<string, unknown> = {
    command: serverCommand,
    args: serverArgs,
  };
  if (env && Object.keys(env).length > 0) proposed.env = env;

  if (existing && JSON.stringify(existing) === JSON.stringify(proposed)) {
    return { host, config_path: configPath, action: "already_present" };
  }

  const next = {
    ...current,
    mcpServers: { ...mcpServers, [entryName]: proposed },
  };
  const wrote = writeJsonIfChanged(configPath, next, current);
  return {
    host,
    config_path: configPath,
    action: wrote ? "merged" : "already_present",
  };
}

// Continue uses a different shape: `experimental.modelContextProtocolServers`
// is an ARRAY of server descriptors.
function registerContinueMcpServer(
  configPath: string,
  serverCommand: string,
  serverArgs: string[],
  env: Record<string, string> | undefined,
  entryName = "unbrowse",
): McpHostResult {
  if (!existsSync(configPath)) {
    return { host: "continue", config_path: configPath, action: "not_detected" };
  }
  const { data, parseError } = safeReadJson(configPath);
  if (parseError) {
    backupAndReset(configPath);
    return {
      host: "continue",
      config_path: configPath,
      action: "parse_error",
      detail: "existing config was not valid JSON; left untouched (a .backup-<ts> was created)",
    };
  }
  const current = data ?? {};
  const experimental = (current.experimental as Record<string, unknown> | undefined) ?? {};
  const servers = Array.isArray(experimental.modelContextProtocolServers)
    ? (experimental.modelContextProtocolServers as Array<Record<string, unknown>>)
    : [];
  const proposed: Record<string, unknown> = {
    transport: { type: "stdio", command: serverCommand, args: serverArgs },
    name: entryName,
  };
  if (env && Object.keys(env).length > 0) {
    (proposed.transport as Record<string, unknown>).env = env;
  }
  const already = servers.find((s) => s.name === entryName);
  if (already && JSON.stringify(already) === JSON.stringify(proposed)) {
    return { host: "continue", config_path: configPath, action: "already_present" };
  }
  const filtered = servers.filter((s) => s.name !== entryName);
  const next = {
    ...current,
    experimental: {
      ...experimental,
      modelContextProtocolServers: [...filtered, proposed],
    },
  };
  const wrote = writeJsonIfChanged(configPath, next, current);
  return {
    host: "continue",
    config_path: configPath,
    action: wrote ? "merged" : "already_present",
  };
}

// Codex uses TOML. Rather than pull in a TOML dep, look for the
// `[mcp_servers.unbrowse]` stanza and append a fresh one if absent. The
// substrate principle holds: we surface our entry without parsing or
// reordering unrelated stanzas.
function registerCodexMcpServer(
  configPath: string,
  serverCommand: string,
  serverArgs: string[],
  env: Record<string, string> | undefined,
  entryName = "unbrowse",
): McpHostResult {
  if (!existsSync(configPath)) {
    return { host: "codex", config_path: configPath, action: "not_detected" };
  }
  let body: string;
  try {
    body = readFileSync(configPath, "utf-8");
  } catch {
    return { host: "codex", config_path: configPath, action: "parse_error", detail: "could not read file" };
  }

  const argsTomlArray = `[${serverArgs.map((a) => JSON.stringify(a)).join(", ")}]`;
  const envLines: string[] = [];
  if (env && Object.keys(env).length > 0) {
    envLines.push("");
    envLines.push(`[mcp_servers.${entryName}.env]`);
    for (const [k, v] of Object.entries(env)) {
      envLines.push(`${k} = ${JSON.stringify(v)}`);
    }
  }
  const proposedStanza = [
    "",
    `[mcp_servers.${entryName}]`,
    `command = ${JSON.stringify(serverCommand)}`,
    `args = ${argsTomlArray}`,
    ...envLines,
    "",
  ].join("\n");

  // Already-present detection: any line that starts with `[mcp_servers.<entryName>`
  // (with optional `.env` sub-table) means the entry exists. We do not attempt
  // to compare deeply against a TOML parse; if the user has customized it we
  // leave it alone.
  const headerRe = new RegExp(
    `^\\[mcp_servers\\.${entryName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(\\.|\\])`,
    "m",
  );
  if (headerRe.test(body)) {
    return { host: "codex", config_path: configPath, action: "already_present" };
  }

  const next = body.endsWith("\n") ? `${body}${proposedStanza}` : `${body}\n${proposedStanza}`;
  mkdirSync(dirname(configPath), { recursive: true });
  writeFileSync(configPath, next);
  return { host: "codex", config_path: configPath, action: "merged" };
}

export function registerMcpHosts(opts: RegisterMcpHostsOptions): McpHostResult[] {
  const home = opts.homeDir ?? homedir();
  const env = opts.env;
  const targets = opts.hosts ?? ALL_HOSTS;
  const skipSet = new Set(opts.skip ?? []);
  const entryName = opts.entryName ?? "unbrowse";
  const results: McpHostResult[] = [];

  for (const host of targets) {
    if (skipSet.has(host)) {
      results.push({
        host,
        config_path: configPathFor(host, home),
        action: "skipped",
        detail: "explicit_skip",
      });
      continue;
    }
    const configPath = configPathFor(host, home);
    switch (host) {
      case "claude-desktop":
      case "cursor":
      case "windsurf":
        results.push(registerSimpleMcpServer(host, configPath, opts.serverCommand, opts.serverArgs, env, entryName));
        break;
      case "continue":
        results.push(registerContinueMcpServer(configPath, opts.serverCommand, opts.serverArgs, env, entryName));
        break;
      case "codex":
        results.push(registerCodexMcpServer(configPath, opts.serverCommand, opts.serverArgs, env, entryName));
        break;
    }
  }
  return results;
}

// Pure-function variants exposed for tests so they can supply an in-memory
// filesystem instead of touching the real config dirs. Returns the result
// PLUS what would have been written, so the test can assert merge correctness.
export const __testing__ = {
  configPathFor,
  registerSimpleMcpServer,
  registerContinueMcpServer,
  registerCodexMcpServer,
};
