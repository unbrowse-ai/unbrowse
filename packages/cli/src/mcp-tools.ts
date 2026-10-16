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
