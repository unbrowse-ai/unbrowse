/**
 * MCP-args <-> v7 ParsedV7Args adapter.
 *
 * Each kind-map row's MCP tool has a typed `inputSchema` that MCP
 * validates before dispatch. The matching v7 handler reads a
 * `ParsedV7Args` shape (verb / sub / positional / flags). This module
 * is the per-kind translator: given an MCP-args record, build the
 * ParsedV7Args the handler expects.
 *
 * The default rule is mechanical: every primitive arg becomes a flag
 * (`{[name]: String(value)}`), and a handful of well-known names
 * become positionals based on the v7 handler's documented usage. The
 * per-kind overrides below capture the small set of handlers whose
 * usage differs from the default rule (e.g. `breath fill <selector> <pointer>`
 * takes two positionals).
 */
import type { ParsedV7Args } from "../args.js";
import type { KindMapEntry, V7OpKind } from "../kind-map.js";

export interface DispatchContext {
  /** Pass --json (default true for MCP, default false for CLI). */
  json?: boolean;
  /** Pass --pretty (forces pretty JSON regardless of --json). */
  pretty?: boolean;
  /** Override for help; usually false from MCP path. */
  wantsHelp?: boolean;
}

/**
 * Adapter signature — takes the MCP args object + ctx, returns the
 * positional list + flag record the v7 handler expects.
 */
type ArgAdapter = (
  args: Record<string, unknown>,
  ctx: DispatchContext,
) => { positional: string[]; flags: Record<string, string | boolean> };

/**
 * Per-kind adapters. Only kinds whose v7 handler reads from
 * positionals (rather than flags) need an entry; the default adapter
 * handles the rest by flattening every arg into a flag.
 */
const ADAPTERS: Partial<Record<V7OpKind, ArgAdapter>> = {
  // breath go <url>
  "breath:navigate": (a) => {
    const positional: string[] = [];
    if (typeof a.url === "string") positional.push(a.url);
    const flags: Record<string, string | boolean> = {};
    if (typeof a.session === "string") flags.session = a.session;
    if (typeof a.proxy === "string") flags.proxy = a.proxy;
    if (typeof a.timeout === "number") flags.timeout = String(a.timeout);
    if (typeof a.ws === "string") flags.ws = a.ws;
    return { positional, flags };
  },

  // breath fill <selector> <pointer>
  "breath:fill": (a) => {
    const positional: string[] = [];
    if (typeof a.selector === "string") positional.push(a.selector);
    // MCP `unbrowse_fill` may pass either `pointer` (preferred) or `text`
    // (cleartext shortcut). Either becomes the second positional; the
    // handler's `looksLikePointer` check distinguishes them.
    if (typeof a.pointer === "string") positional.push(a.pointer);
    else if (typeof a.text === "string") positional.push(a.text);
    const flags: Record<string, string | boolean> = {};
    if (typeof a.session === "string") flags.session = a.session;
    if (typeof a.argScope === "string") flags.argScope = a.argScope;
    if (typeof a.arg === "string") flags.arg = a.arg;
    return { positional, flags };
  },

  // breath type <selector> <pointer> — same shape as fill
  "breath:type": (a) => {
    const positional: string[] = [];
    if (typeof a.selector === "string") positional.push(a.selector);
    if (typeof a.pointer === "string") positional.push(a.pointer);
    else if (typeof a.text === "string") positional.push(a.text);
    const flags: Record<string, string | boolean> = {};
    if (typeof a.session === "string") flags.session = a.session;
    if (typeof a.delay === "number") flags.delay = String(a.delay);
    return { positional, flags };
  },

  // breath click <selector>
  "breath:click": (a) => {
    const positional: string[] = [];
    if (typeof a.selector === "string") positional.push(a.selector);
    const flags: Record<string, string | boolean> = {};
    if (typeof a.session === "string") flags.session = a.session;
    if (typeof a.button === "string") flags.button = a.button;
    if (typeof a.click_count === "number") flags["click-count"] = String(a.click_count);
    if (typeof a.modifiers === "string") flags.modifiers = a.modifiers;
    return { positional, flags };
  },

  // breath press <key>
  "breath:press": (a) => {
    const positional: string[] = [];
    if (typeof a.key === "string") positional.push(a.key);
    const flags: Record<string, string | boolean> = {};
    if (typeof a.session === "string") flags.session = a.session;
    if (typeof a.modifiers === "string") flags.modifiers = a.modifiers;
    return { positional, flags };
  },

  // breath select <selector> <value>
  "breath:select": (a) => {
    const positional: string[] = [];
    if (typeof a.selector === "string") positional.push(a.selector);
    if (typeof a.value === "string") positional.push(a.value);
    else if (typeof a.pointer === "string") positional.push(a.pointer);
    const flags: Record<string, string | boolean> = {};
    if (typeof a.session === "string") flags.session = a.session;
    return { positional, flags };
  },

  // breath scroll [selector] [dx] [dy]
  "breath:scroll": (a) => {
    const positional: string[] = [];
    if (typeof a.selector === "string") positional.push(a.selector);
    if (typeof a.dx === "number") positional.push(String(a.dx));
    if (typeof a.dy === "number") positional.push(String(a.dy));
    const flags: Record<string, string | boolean> = {};
    if (typeof a.session === "string") flags.session = a.session;
    return { positional, flags };
  },

  // breath submit [selector]
  "breath:submit": (a) => {
    const positional: string[] = [];
    if (typeof a.selector === "string") positional.push(a.selector);
    const flags: Record<string, string | boolean> = {};
    if (typeof a.session === "string") flags.session = a.session;
    return { positional, flags };
  },

  // breath execute <skill> <endpoint>
  "breath:execute": (a) => {
    const positional: string[] = [];
    if (typeof a.skill === "string") positional.push(a.skill);
    if (typeof a.endpoint === "string") positional.push(a.endpoint);
    const flags: Record<string, string | boolean> = {};
    if (typeof a.url === "string") flags.url = a.url;
    if (typeof a.intent === "string") flags.intent = a.intent;
    if (a.params && typeof a.params === "object") flags.params = JSON.stringify(a.params);
    if (a.dry_run === true) flags["dry-run"] = true;
    if (a.raw === true) flags.raw = true;
    return { positional, flags };
  },

  // breath auth-capture <url>
  "breath:auth_capture": (a) => {
    const positional: string[] = [];
    if (typeof a.url === "string") positional.push(a.url);
    const flags: Record<string, string | boolean> = {};
    if (typeof a.domain === "string") flags.domain = a.domain;
    if (typeof a.timeout === "number") flags.timeout = String(a.timeout);
    return { positional, flags };
  },

  // breath close [--session id]
  "breath:close": (a) => {
    const flags: Record<string, string | boolean> = {};
    if (typeof a.session === "string") flags.session = a.session;
    if (typeof a.session_id === "string") flags.session = a.session_id;
    return { positional: [], flags };
  },

  // eval resolve <intent>
  "eval:resolve": (a) => {
    const positional: string[] = [];
    if (typeof a.intent === "string") positional.push(a.intent);
    const flags: Record<string, string | boolean> = {};
    if (typeof a.url === "string") flags.url = a.url;
    if (typeof a.domain === "string") flags.domain = a.domain;
    if (typeof a.limit === "number") flags.limit = String(a.limit);
    if (a.fresh === true || a.force_capture === true) flags.fresh = true;
    return { positional, flags };
  },

  // eval trace [session-id]
  "eval:trace": (a) => {
    const positional: string[] = [];
    const sid = a.session_id ?? a.session ?? a.host ?? a.domain;
    if (typeof sid === "string") positional.push(sid);
    return { positional, flags: {} };
  },

  // eval skill <skill-id>
  "eval:skill": (a) => {
    const positional: string[] = [];
    const sid = a.skill_id ?? a.skill ?? a.id;
    if (typeof sid === "string") positional.push(sid);
    return { positional, flags: {} };
  },

  // eval cookies <domain>
  "eval:cookies": (a) => {
    const positional: string[] = [];
    if (typeof a.domain === "string") positional.push(a.domain);
    return { positional, flags: {} };
  },

  // eval text [selector]
  "eval:text": (a) => {
    const positional: string[] = [];
    if (typeof a.selector === "string") positional.push(a.selector);
    const flags: Record<string, string | boolean> = {};
    if (typeof a.session === "string") flags.session = a.session;
    return { positional, flags };
  },

  // eval feedback <skill_id> <endpoint_id> <score>
  "eval:feedback": (a) => {
    const positional: string[] = [];
    if (typeof a.skill === "string") positional.push(a.skill);
    if (typeof a.endpoint === "string") positional.push(a.endpoint);
    if (typeof a.score === "number") positional.push(String(a.score));
    const flags: Record<string, string | boolean> = {};
    if (typeof a.note === "string") flags.note = a.note;
    if (typeof a.outcome === "string") flags.outcome = a.outcome;
    return { positional, flags };
  },

  // eval reflect <intent_status>
  "eval:reflect": (a) => {
    const positional: string[] = [];
    if (typeof a.outcome === "string") positional.push(a.outcome);
    else if (typeof a.intent_status === "string") positional.push(a.intent_status);
    return { positional, flags: {} };
  },

  // build skill <skill-id>
  "build:skill": (a) => {
    const positional: string[] = [];
    const sid = a.skill_id ?? a.skill ?? a.id;
    if (typeof sid === "string") positional.push(sid);
    const flags: Record<string, string | boolean> = {};
    if (typeof a.domain === "string") flags.domain = a.domain;
    if (a.public === true) flags.public = true;
    if (a.dry_run === true) flags["dry-run"] = true;
    return { positional, flags };
  },
};

/** Default adapter — flatten every arg into a flag. */
function defaultAdapter(args: Record<string, unknown>): {
  positional: string[];
  flags: Record<string, string | boolean>;
} {
  const flags: Record<string, string | boolean> = {};
  for (const [k, v] of Object.entries(args)) {
    if (v === undefined || v === null) continue;
    if (typeof v === "boolean") flags[k] = v;
    else if (typeof v === "string" || typeof v === "number") flags[k] = String(v);
    else flags[k] = JSON.stringify(v);
  }
  return { positional: [], flags };
}

export function buildParsedArgsForKind(
  entry: KindMapEntry,
  args: Record<string, unknown>,
  ctx: DispatchContext,
): ParsedV7Args {
  const adapter = ADAPTERS[entry.op_kind as V7OpKind] ?? defaultAdapter;
  const { positional, flags } = adapter(args, ctx);

  // Honor ctx flags for output mode.
  if (ctx.json === true) flags.json = true;
  if (ctx.pretty === true) flags.pretty = true;
  if (ctx.wantsHelp === true) flags.help = true;

  const [verb, sub] = entry.subcommand.split(" ", 2);
  return {
    verb,
    sub,
    positional,
    flags,
    wantsHelp: flags.help === true,
    wantsJson: flags.json === true,
  };
}
