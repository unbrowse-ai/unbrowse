// `unbrowse tools` and `unbrowse tool <name>`: every tool of the hosted MCP from the shell, through the same
// proxy `unbrowse mcp` serves. Nothing is ported by hand, so a tool added to the MCP is a CLI command the day it ships.
import type { McpTool } from "@unbrowse/sdk";
import { safeToolName } from "./mcp-proxy.ts";

export type ToolResult = { content?: Array<{ type: string; text?: string; mimeType?: string }>; structuredContent?: unknown; isError?: boolean };

/**
 * The listed name a typed one means: exact, else with `unbrowse_` in front, after dots and dashes become `_`.
 * `browse_open`, `browse-open`, `unbrowse.browse.open` and `unbrowse_browse_open` all name the same tool.
 */
export function resolveTool(tools: McpTool[], typed: string): McpTool | undefined {
  const names = new Map(tools.map((t) => [t.name, t]));
  const safe = safeToolName(typed);
  const underscored = safe.replace(/-/g, "_");
  for (const n of [typed, safe, underscored, `unbrowse_${safe}`, `unbrowse_${underscored}`]) if (names.has(n)) return names.get(n);
  return undefined;
}

/** The name to type: without the `unbrowse_` every core tool shares. */
export function shortName(name: string): string {
  return name.replace(/^unbrowse_/, "");
}

/** `name(a, b?)`: inputs from the schema, required first, optional ones marked `?`; a long list ends in `…`. */
export function signature(t: McpTool, max = 60): string {
  const schema = (t.inputSchema ?? {}) as { properties?: Record<string, unknown>; required?: string[] };
  const required = new Set(schema.required ?? []);
  const keys = Object.keys(schema.properties ?? {});
  const props = [...keys.filter((k) => required.has(k)), ...keys.filter((k) => !required.has(k)).map((k) => `${k}?`)];
  let shown = "";
  for (const [i, p] of props.entries()) {
    const next = shown ? `${shown}, ${p}` : p;
    if (`${shortName(t.name)}(${next})`.length > max && i > 0) return `${shortName(t.name)}(${shown}, …)`;
    shown = next;
  }
  return `${shortName(t.name)}(${shown})`;
}

/** The first sentence of a description, for one line of a listing. */
export function summary(description = "", max = 110): string {
  const first = description.split(/(?<=[.!?])\s|\n/)[0]!.trim();
  return first.length > max ? `${first.slice(0, max - 1)}…` : first;
}

/**
 * Tools whose name has a word starting with each word of the query (`browse` is not in `unbrowse`);
 * when no name matches, the same test on name and description.
 */
export function filterTools(tools: McpTool[], query: string): McpTool[] {
  const split = (s: string) => s.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  const words = split(query);
  const matches = (text: string) => {
    const tokens = split(text);
    return words.every((w) => tokens.some((k) => k.startsWith(w)));
  };
  const byName = tools.filter((t) => matches(shortName(t.name)));
  return byName.length ? byName : tools.filter((t) => matches(`${shortName(t.name)} ${t.description ?? ""}`));
}

/**
 * CLI commands for the MCP tools the REST API has no route for: one command per tool, its inputs in order as
 * positional arguments (a trailing `?` marks an optional one), the rest as `--flags`. `rest: true` joins the remaining words into the last one
 * (a query, a question, the text to type). `lists` are comma-separated on the command line.
 */
export type McpCommand = { cmd: string; sub?: string; tool: string; args: string[]; rest?: boolean; lists?: string[]; usage: string; does: string };
export const MCP_COMMANDS: McpCommand[] = [
  { cmd: "map", tool: "unbrowse_map", args: ["url"], usage: "map <url> [--search TEXT] [--limit N]", does: "A site's URLs from its sitemaps and the page's links" },
  { cmd: "browse", sub: "open", tool: "unbrowse_browse_open", args: ["url"], usage: "browse open <url> [--task TEXT] [--country XX]", does: "Open a recorded cloud browser on a page; prints its text and @refs" },
  { cmd: "browse", sub: "snapshot", tool: "unbrowse_browse_snapshot", args: ["sessionId"], usage: "browse snapshot <sessionId> [--text-offset N]", does: "The page's current text and @refs" },
  { cmd: "browse", sub: "act", tool: "unbrowse_browse_act", args: ["sessionId", "action", "ref?", "value?"], rest: true, usage: "browse act <sessionId> <click|fill|select|check|press|wait|autofill> [ref] [value…] [--name N] [--vault FIELD] [--key K]", does: "One action on a @ref" },
  { cmd: "browse", sub: "finish", tool: "unbrowse_browse_finish", args: ["sessionId"], usage: "browse finish <sessionId> [--title T] [--goal G]", does: "End the session and learn the site's routes from it" },
  { cmd: "browse", sub: "close", tool: "unbrowse_browse_close", args: ["sessionId"], usage: "browse close <sessionId> [--discard]", does: "End the session (it still indexes unless --discard)" },
  { cmd: "sites", tool: "unbrowse_sites", args: ["site?"], usage: "sites [site]", does: "What your workspace knows about each site: access, saved login, session" },
  { cmd: "forget", tool: "unbrowse_forget", args: ["capability"], usage: "forget <capability>", does: "Delete one of your learned capabilities" },
  { cmd: "credentials", sub: "list", tool: "unbrowse_credentials_list", args: ["origin?"], usage: "credentials list [origin] [--query TEXT] [--limit N]", does: "Saved logins as masked hints, filtered by site" },
  { cmd: "credentials", sub: "request", tool: "unbrowse_credentials_request", args: ["origin"], lists: ["fields"], usage: "credentials request <origin> [--fields username,password,totp] [--reason TEXT]", does: "A one-time link for the person to save a login you need" },
  { cmd: "credentials", sub: "status", tool: "unbrowse_credentials_status", args: ["requestId"], usage: "credentials status <requestId> [--wait-seconds N]", does: "Whether that request was answered" },
  { cmd: "connect", tool: "unbrowse_connect", args: ["app?"], usage: "connect [app] [--url URL --name N] [--search TEXT] [--disconnect]", does: "Connect an app's own MCP server (Linear, Notion, GitHub…) so its tools run as you" },
  { cmd: "credits", tool: "unbrowse_credits", args: [], usage: "credits [--pack p10|p50|p200]", does: "Credits left; --pack gets a checkout link" },
  { cmd: "replay", sub: "list", tool: "unbrowse_replay_list", args: [], usage: "replay list [--site S] [--outcome O] [--has-error] [--from D] [--to D] [--limit N]", does: "Recorded sessions, newest first" },
  { cmd: "replay", sub: "search", tool: "unbrowse_replay_search", args: ["query"], rest: true, usage: "replay search <query…> [same filters]", does: "Search what happened in recorded sessions" },
  { cmd: "replay", sub: "get", tool: "unbrowse_replay_get", args: ["sid"], usage: "replay get <sid>", does: "One session's details, signals and summary" },
  { cmd: "replay", sub: "timeline", tool: "unbrowse_replay_timeline", args: ["sid"], lists: ["kinds"], usage: "replay timeline <sid> [--from MS] [--to MS] [--kinds a,b]", does: "A session as text, one line per event" },
  { cmd: "replay", sub: "ask", tool: "unbrowse_replay_ask", args: ["question"], rest: true, usage: "replay ask <question…> [same filters]", does: "Ask a question across recorded sessions" },
];

/**
 * Where every MCP tool lives in the CLI: the REST-backed commands, then MCP_COMMANDS.
 * The parity test fails when a core MCP tool has no entry here.
 */
export const CLI_FOR_TOOL: Record<string, string> = {
  unbrowse_discover: "discover",
  search: "discover",
  unbrowse_run: "run",
  unbrowse_inspect: "inspect",
  unbrowse_resume: "resume",
  unbrowse_cancel: "cancel",
  unbrowse_learn: "learn",
  unbrowse_scrape: "scrape",
  fetch: "scrape",
  unbrowse_usage: "usage",
  unbrowse_index: "index",
  unbrowse_index_status: "index status",
  unbrowse_import_mcps: "mcps import",
  unbrowse_local_mcps: "mcps",
  ...Object.fromEntries(MCP_COMMANDS.map((c) => [c.tool, c.sub ? `${c.cmd} ${c.sub}` : c.cmd])),
};

/** The command a typed `cmd [sub]` names, or the usage of its subcommands when the sub is missing or unknown. */
export function findCommand(cmd: string, sub: string | undefined): { command?: McpCommand; usage?: string } {
  const all = MCP_COMMANDS.filter((c) => c.cmd === cmd);
  const command = all.find((c) => !c.sub || c.sub === sub);
  return command ? { command } : { usage: all.map((c) => `unbrowse ${c.usage}`).join("\n") };
}

/** A command's tool arguments: positionals by name in order, then every other `--flag` (kebab to camel), typed. */
export function commandInput(c: McpCommand, words: string[], flags: Record<string, string | boolean>, sets: Record<string, unknown>, coerce: (v: string) => unknown): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  c.args.forEach((name, i) => {
    const v = c.rest && i === c.args.length - 1 ? words.slice(i).join(" ") : words[i];
    if (v) out[name.replace(/\?$/, "")] = v;
  });
  for (const [k, v] of Object.entries(flags)) if (!CLI_FLAGS.has(k)) out[k.replace(/-([a-z])/g, (_, ch: string) => ch.toUpperCase())] = typeof v === "string" ? coerce(v) : v;
  Object.assign(out, sets);
  for (const k of c.lists ?? []) if (typeof out[k] === "string") out[k] = (out[k] as string).split(",").map((s) => s.trim()).filter(Boolean);
  return out;
}

/** Flags the CLI itself reads; every other `--key value` on `unbrowse tool` is an input of the tool. */
export const CLI_FLAGS = new Set(["json", "base-url", "account", "no-open", "input", "from-here", "help", "version"]);

/**
 * A tool's arguments: a JSON object (positional or --input), then each `--key value` and `--set key=value`.
 * `--session-id` becomes `sessionId` when the schema has that and not the kebab name.
 */
export function toolInput(t: McpTool, json: string | undefined, flags: Record<string, string | boolean>, sets: Record<string, unknown>, coerce: (v: string) => unknown): Record<string, unknown> {
  const props = new Set(Object.keys(((t.inputSchema ?? {}) as { properties?: Record<string, unknown> }).properties ?? {}));
  const key = (k: string) => (props.has(k) ? k : k.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase()));
  const base = json ? (JSON.parse(json) as unknown) : {};
  if (!base || typeof base !== "object" || Array.isArray(base)) throw new SyntaxError("the tool's input must be a JSON object");
  const out: Record<string, unknown> = { ...(base as Record<string, unknown>) };
  for (const [k, v] of Object.entries(flags)) if (!CLI_FLAGS.has(k)) out[key(k)] = typeof v === "string" ? coerce(v) : v;
  for (const [k, v] of Object.entries(sets)) out[key(k)] = v;
  return out;
}

/** What a tool call prints: its structured result, else its text (as JSON when it is JSON), else a note per non-text part. */
export function resultValue(r: ToolResult): unknown {
  if (r.structuredContent !== undefined) return r.structuredContent;
  const parts = (r.content ?? []).map((c) => (c.type === "text" ? c.text ?? "" : `[${c.type}${c.mimeType ? ` ${c.mimeType}` : ""}]`));
  const text = parts.join("\n");
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/** The exit code a tool result maps to, the same as the CLI's own commands: 2 input required, 1 error, else 0. */
export function resultCode(r: ToolResult, value: unknown): number {
  if (r.isError) return 1;
  const status = (value as { status?: unknown } | null)?.status;
  return status === "input_required" ? 2 : 0;
}
