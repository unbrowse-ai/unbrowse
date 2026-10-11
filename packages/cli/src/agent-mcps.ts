// The MCP servers this machine's agents already have, read from their own config files, for `unbrowse mcps` and
// the proxy's `unbrowse_local_mcps`. Secrets stay here: a server is reported with the NAMES of its headers and env
// vars, never their values, and what is sent to Unbrowse (`toImport`) carries no header, env or secret-looking arg.
// A header value leaves this machine only through `keyOf`, when the person asked for it (`--with-keys`).
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export type Found = {
  host: string;
  file: string;
  name: string;
  url?: string;
  transport?: "streamable-http" | "sse";
  command?: string;
  args?: string[];
  /** Header and env var names, never values. */
  headerNames: string[];
  envNames: string[];
  /** This is Unbrowse itself (its remote MCP, or `unbrowse mcp`). */
  self: boolean;
};

type Raw = Record<string, unknown>;
type Place = { host: string; file: string; read: (text: string) => Record<string, Raw> };

/** JSON with comments and trailing commas (Zed, VS Code). Strings are kept as they are. */
export function parseJsonc(text: string): unknown {
  let out = "";
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (c === '"') {
      let j = i + 1;
      while (j < text.length && text[j] !== '"') j += text[j] === "\\" ? 2 : 1;
      out += text.slice(i, j + 1);
      i = j;
    } else if (c === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") i++;
      out += "\n";
    } else if (c === "/" && text[i + 1] === "*") {
      i = text.indexOf("*/", i + 2);
      if (i < 0) break;
      i++;
    } else out += c;
  }
  return JSON.parse(out.replace(/,(\s*[}\]])/g, "$1"));
}

/** The `[mcp_servers.<name>]` tables of a Codex config.toml: strings, string arrays, booleans and inline tables. */
export function parseCodexToml(text: string): Record<string, Raw> {
  const servers: Record<string, Raw> = {};
  let current: Raw | undefined;
  let sub: string | undefined;
  const value = (v: string): unknown => {
    v = v.trim();
    if (/^".*"$/.test(v) || /^'.*'$/.test(v)) return v.slice(1, -1).replace(/\\"/g, '"');
    if (v.startsWith("[")) return [...v.matchAll(/"((?:[^"\\]|\\.)*)"|'([^']*)'/g)].map((m) => m[1] ?? m[2]);
    if (v.startsWith("{")) return Object.fromEntries([...v.matchAll(/([\w.-]+|"[^"]+")\s*=\s*("(?:[^"\\]|\\.)*"|'[^']*')/g)].map((m) => [m[1]!.replace(/"/g, ""), m[2]!.slice(1, -1)]));
    if (v === "true" || v === "false") return v === "true";
    return v;
  };
  for (const line of text.split(/\r?\n/)) {
    const t = line.replace(/\s+#.*$/, "").trim();
    if (!t || t.startsWith("#")) continue;
    const table = /^\[mcp_servers\.("?)([^\]".]+)\1(?:\.([\w-]+))?\]$/.exec(t);
    if (table) {
      current = servers[table[2]!] ??= {};
      sub = table[3];
      if (sub) current[sub] ??= {};
      continue;
    }
    if (t.startsWith("[")) { current = undefined; continue; }
    const kv = /^([\w.-]+|"[^"]+")\s*=\s*(.+)$/.exec(t);
    if (!kv || !current) continue;
    const key = kv[1]!.replace(/"/g, "");
    if (sub) (current[sub] as Raw)[key] = value(kv[2]!);
    else current[key] = value(kv[2]!);
  }
  return servers;
}

const asObj = (v: unknown): Record<string, Raw> => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, Raw>) : {});

/** Where each agent keeps its MCP servers, for this home directory and working directory. */
export function places(home = process.env.HOME || process.env.USERPROFILE || homedir(), cwd = process.cwd(), platform = process.platform, env = process.env): Place[] {
  const appData = env.APPDATA ?? join(home, "AppData", "Roaming");
  const desktop = platform === "darwin" ? join(home, "Library", "Application Support", "Claude") : platform === "win32" ? join(appData, "Claude") : join(env.XDG_CONFIG_HOME ?? join(home, ".config"), "Claude");
  const code = platform === "darwin" ? join(home, "Library", "Application Support", "Code", "User") : platform === "win32" ? join(appData, "Code", "User") : join(env.XDG_CONFIG_HOME ?? join(home, ".config"), "Code", "User");
  const zed = platform === "darwin" || platform === "linux" ? join(env.XDG_CONFIG_HOME ?? join(home, ".config"), "zed", "settings.json") : join(appData, "Zed", "settings.json");
  const mcpServers = (t: string) => asObj((parseJsonc(t) as Raw).mcpServers);
  return [
    // Claude Code: user servers at the top of ~/.claude.json, and each project's under projects[<dir>].
    { host: "claude-code", file: join(home, ".claude.json"), read: (t) => {
      const j = parseJsonc(t) as Raw;
      const projects = asObj(j.projects);
      return { ...asObj(projects[cwd]?.mcpServers), ...asObj(j.mcpServers) };
    } },
    { host: "claude-code", file: join(cwd, ".mcp.json"), read: mcpServers },
    { host: "claude-desktop", file: join(desktop, "claude_desktop_config.json"), read: mcpServers },
    { host: "cursor", file: join(home, ".cursor", "mcp.json"), read: mcpServers },
    { host: "cursor", file: join(cwd, ".cursor", "mcp.json"), read: mcpServers },
    { host: "codex", file: join(env.CODEX_HOME ?? join(home, ".codex"), "config.toml"), read: parseCodexToml },
    { host: "vscode", file: join(code, "mcp.json"), read: (t) => asObj((parseJsonc(t) as Raw).servers) },
    { host: "vscode", file: join(cwd, ".vscode", "mcp.json"), read: (t) => asObj((parseJsonc(t) as Raw).servers) },
    { host: "windsurf", file: join(home, ".codeium", "windsurf", "mcp_config.json"), read: mcpServers },
    { host: "gemini", file: join(home, ".gemini", "settings.json"), read: mcpServers },
    { host: "zed", file: zed, read: (t) => asObj((parseJsonc(t) as Raw).context_servers) },
  ];
}

const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : undefined);

/** Looks like a key, a token or a path to one: shown as ‹hidden› and never sent. */
const secretish = (a: string) => /[=]/.test(a) || /(token|secret|key|password|bearer)/i.test(a) || /[A-Za-z0-9_\-]{32,}/.test(a) || /^(sk|ghp|gho|xox[abp]|ub_live|AKIA)[-_A-Za-z0-9]/.test(a);
export const HIDDEN = "‹hidden›";

/** Unbrowse's own MCP (any of its hosts) and its per-site servers. Kata, Rooms and other products are importable. */
export const isUnbrowse = (url: string) => /^https?:\/\/((www|v3|stage|api)\.)?unbrowse\.ai(\/|$)/i.test(url) || /^https?:\/\/[a-z0-9-]+-mcp\.unbrowse\.ai(\/|$)/i.test(url);

/** One config entry, in every host's spelling (url / serverUrl / httpUrl; type; Zed's nested command). */
export function normalize(host: string, file: string, name: string, raw: Raw): Found {
  const zedCommand = asObj(raw.command) as unknown as { path?: string; args?: string[]; env?: Raw };
  const command = str(raw.command) ?? str(zedCommand.path);
  const args = (Array.isArray(raw.args) ? raw.args : Array.isArray(zedCommand.args) ? zedCommand.args : []).filter((a): a is string => typeof a === "string").map((a) => (secretish(a) && !/^https:\/\/[^\s?#=]+$/.test(a) ? HIDDEN : a));
  const url = str(raw.url) ?? str(raw.serverUrl) ?? str(raw.httpUrl);
  const type = String(raw.type ?? raw.transport ?? "").toLowerCase();
  const transport = url ? (type === "sse" || (!type && /\/sse\/?$/.test(url)) ? "sse" : "streamable-http") : undefined;
  const headers = { ...asObj(raw.headers), ...asObj(raw.http_headers) };
  const env = { ...asObj(raw.env), ...asObj(zedCommand.env) };
  const self = (!!url && isUnbrowse(url)) || (/unbrowse/.test(`${command ?? ""} ${args.join(" ")}`) && args.includes("mcp"));
  return { host, file, name, ...(url ? { url, transport } : {}), ...(command ? { command, args } : {}), headerNames: Object.keys(headers), envNames: Object.keys(env), self };
}

/** Every server in every agent config found. An unreadable or malformed file is skipped and named in `skipped`. */
export function scan(opts: { home?: string; cwd?: string; platform?: NodeJS.Platform; env?: NodeJS.ProcessEnv } = {}): { servers: Found[]; skipped: { file: string; why: string }[] } {
  const servers: Found[] = [];
  const skipped: { file: string; why: string }[] = [];
  const seenFiles = new Set<string>();
  for (const p of places(opts.home, opts.cwd, opts.platform, opts.env)) {
    if (seenFiles.has(p.file) || !existsSync(p.file)) continue;
    seenFiles.add(p.file);
    try {
      for (const [name, raw] of Object.entries(p.read(readFileSync(p.file, "utf8")))) {
        if (raw && typeof raw === "object" && (raw as Raw).disabled !== true && (raw as Raw).enabled !== false) servers.push(normalize(p.host, p.file, name, raw as Raw));
      }
    } catch (e) {
      skipped.push({ file: p.file, why: (e as Error).message.slice(0, 120) });
    }
  }
  return { servers, skipped };
}


/** What Unbrowse is told about a server: its name and address, or its command and package names. No secrets. */
export function toImport(f: Found): { name: string; url?: string; transport?: string; command?: string; args?: string[] } {
  if (f.url) return { name: f.name, url: f.url, ...(f.transport ? { transport: f.transport } : {}) };
  const args = (f.args ?? []).filter((a) => a !== HIDDEN && (/^https:\/\/[^\s?#]+$/.test(a) || (!a.startsWith("-") && !secretish(a) && /^[@\w][\w@./:-]*$/.test(a) && /mcp|server|remote|gateway/i.test(a))));
  return { name: f.name, ...(f.command ? { command: f.command.split(/[\\/]/).pop()! } : {}), ...(args.length ? { args } : {}) };
}

/** The key a remote server's config carries (Authorization or an api-key header), read only on `--with-keys`. */
export function keyOf(f: Found, raw: Raw): { header: string; key: string } | undefined {
  if (!f.url) return undefined;
  const headers = { ...asObj(raw.headers), ...asObj(raw.http_headers) } as Record<string, unknown>;
  for (const [h, v] of Object.entries(headers)) {
    if (typeof v !== "string" || !v.trim() || /\$\{|\$[A-Z_]/.test(v)) continue; // ${ENV} references are not values
    if (/^(authorization|x-api-key|api-key|x-auth-token)$/i.test(h)) return { header: h.toLowerCase(), key: v.trim() };
  }
  return undefined;
}

/** The raw config entry again, for `keyOf` (kept out of `Found` so a value is never printed by accident). */
export function rawEntry(f: Found, opts: { home?: string; cwd?: string; platform?: NodeJS.Platform; env?: NodeJS.ProcessEnv } = {}): Raw | undefined {
  const p = places(opts.home, opts.cwd, opts.platform, opts.env).find((x) => x.file === f.file && x.host === f.host);
  try {
    return p ? (p.read(readFileSync(f.file, "utf8"))[f.name] as Raw) : undefined;
  } catch {
    return undefined;
  }
}

/** One server per address or command: the same one configured in two agents is imported once. */
export function unique(servers: Found[]): Found[] {
  const seen = new Set<string>();
  return servers.filter((s) => {
    const k = s.url ? `u:${s.url.replace(/\/+$/, "")}` : `c:${s.command} ${(s.args ?? []).join(" ")}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}
