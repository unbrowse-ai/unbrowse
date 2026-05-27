/**
 * v7 covenant-kind dispatcher — the 1:1:1 translation layer.
 *
 *   Acts 2:6 — "every man heard them speak in his own language"
 *
 * The KIND_MAP (src/cli-v7/kind-map.ts) declares one row per primitive:
 *   subcommand <-> covenant_kind <-> mcp_tool
 *
 * This module is the translator. It accepts a covenant_kind plus a
 * record of typed args (the shape MCP already validates against
 * `inputSchema`), looks up the matching v7 handler, builds the
 * `ParsedV7Args` the handler expects (via mcp-args.ts adapters),
 * invokes the handler in an emit/exit shim, and returns a structured
 * `DispatchResult` the caller can decide what to do with.
 *
 * Three callers consume this:
 *   1. The MCP server (src/mcp.ts) — translates MCP tool calls to
 *      covenant_kinds, then to v7 handlers. Falls back to the legacy
 *      v6 backend path when dispatch reports the v7 handler is not
 *      ready (not_implemented_yet) or its response shape diverges.
 *   2. The covenant substrate (~/Projects/covenant) — every KindSpec
 *      whose effect is "run an unbrowse primitive" lands here so the
 *      receipt body IS the dispatch result.
 *   3. The CLI itself (src/cli-v7/index.ts) — unchanged: it parses
 *      argv into ParsedV7Args, runs the same `handler` function this
 *      module wraps, then exits with the handler's exit code.
 *
 * In-process — does NOT shell out to `unbrowse`. The cost of a
 * dispatch is the cost of the handler logic itself, plus a tiny
 * per-call shim install/restore.
 */
import { KIND_MAP, type V7CovenantKind, type KindMapEntry } from "../kind-map.js";
import type { ParsedV7Args } from "../args.js";
import type { OutputOptions } from "../output.js";
import { buildParsedArgsForKind, type DispatchContext } from "./mcp-args.js";

export type { DispatchContext } from "./mcp-args.js";

export interface DispatchResult {
  readonly ok: boolean;
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
  /** Parsed JSON from stdout (when stdout was a single JSON document). */
  readonly jsonResult?: unknown;
  readonly covenant_kind: V7CovenantKind | string;
  readonly subcommand: string;
  readonly mcp_tool: string | null;
  /**
   * Fallback hint — set when the dispatched handler returned a
   * `not_implemented_yet` envelope (EX_SOFTWARE / 70). MCP callers
   * should fall through to the legacy v6 backend path; the v6 wire
   * is the contract until the v7 handler is wired (W3.1+ waves).
   */
  readonly fallback_to_v6?: true;
  /**
   * Set when no handler exists for the kind (drift between kind-map
   * and the verb routers). Not the same as `fallback_to_v6` — this
   * is a substrate error the caller should surface, not a v6 fall-through.
   */
  readonly dispatch_error?: string;
}

/** Look up the kind-map row for a covenant_kind. O(N) — N=32 — fine. */
export function findKindEntry(kind: string): KindMapEntry | undefined {
  return KIND_MAP.find((e) => e.covenant_kind === kind);
}

/** All registered MCP tool names from the kind-map (non-null). */
export function listMcpTools(): readonly string[] {
  const tools: string[] = [];
  for (const e of KIND_MAP) {
    if (typeof e.mcp_tool === "string") tools.push(e.mcp_tool);
  }
  return tools;
}

/** All registered covenant kinds. */
export function listCovenantKinds(): readonly V7CovenantKind[] {
  return KIND_MAP.map((e) => e.covenant_kind);
}

/**
 * Mutex — `process.stdout.write` / `process.exit` are global state, so
 * we serialize dispatch calls within a process. JSON-RPC over stdio is
 * already serial per session; covenant fire-and-await is serial per
 * receipt. The mutex is a backstop against accidental parallelism.
 */
let dispatchLock: Promise<unknown> = Promise.resolve();

/**
 * Run a v7 handler with stdout/stderr/exit shimmed, capture output,
 * return a structured DispatchResult. Restores the global hooks
 * before returning, even on throw.
 */
async function runHandlerCaptured(
  entry: KindMapEntry,
  parsed: ParsedV7Args,
  opts: OutputOptions,
): Promise<DispatchResult> {
  // Load the verb router lazily — matches src/cli-v7/router.ts's pattern.
  const verbModule = await loadVerb(entry.verb);
  const handler = verbModule[entry.subcommand.split(" ")[1]];
  if (typeof handler !== "function") {
    return {
      ok: false,
      exitCode: 70,
      stdout: "",
      stderr: "",
      covenant_kind: entry.covenant_kind,
      subcommand: entry.subcommand,
      mcp_tool: entry.mcp_tool,
      dispatch_error: `no_handler_for_kind:${entry.covenant_kind}`,
    };
  }

  // Per-call shim: capture writes to process.stdout / process.stderr,
  // catch process.exit(N) via a sentinel-throwing replacement. Restore
  // all three in finally.
  const origStdoutWrite = process.stdout.write.bind(process.stdout);
  const origStderrWrite = process.stderr.write.bind(process.stderr);
  const origExit = process.exit.bind(process);

  let stdout = "";
  let stderr = "";
  let exitCode = 0;

  type ShimWrite = typeof process.stdout.write;
  const shimWrite = (target: "stdout" | "stderr"): ShimWrite => {
    const fn = ((chunk: string | Uint8Array, encodingOrCb?: unknown, cb?: unknown): boolean => {
      const text = typeof chunk === "string"
        ? chunk
        : (chunk instanceof Uint8Array ? new TextDecoder("utf-8").decode(chunk) : String(chunk));
      if (target === "stdout") stdout += text;
      else stderr += text;
      // Honor the .write(chunk, cb) signature so callbacks fire.
      const maybeCb = typeof encodingOrCb === "function" ? encodingOrCb : cb;
      if (typeof maybeCb === "function") (maybeCb as () => void)();
      return true;
    }) as ShimWrite;
    return fn;
  };

  // Sentinel symbol for our exit signal. Using a Symbol-tagged object
  // (not an Error subclass) means user `catch (err) { emitErr(err); ... }`
  // chains serialize it harmlessly (no leaked stack trace, no fake
  // "error" message) — and we can detect it by tag in our outer catch.
  const EXIT_TAG = Symbol.for("__v7_dispatch_exit_signal__");
  type ExitSignal = { [EXIT_TAG]: true; code: number; toString(): string };
  const isExitSignal = (v: unknown): v is ExitSignal =>
    typeof v === "object" && v !== null && (v as Record<symbol, unknown>)[EXIT_TAG] === true;

  // Track the FIRST exit code we see. Subsequent process.exit() calls
  // (e.g. from a user catch block that calls emitErr+exit on our signal)
  // are no-ops — they would otherwise mask the real exit shape.
  let firstExitSeen = false;

  process.stdout.write = shimWrite("stdout");
  process.stderr.write = shimWrite("stderr");
  process.exit = ((code?: number) => {
    const c = typeof code === "number" ? code : 0;
    if (!firstExitSeen) {
      firstExitSeen = true;
      exitCode = c;
    }
    // Throw a plain object so user-level `catch (err)` receives
    // something inert (toString => "[v7 dispatch exit]"), and our
    // outer catch can detect by symbol tag.
    const sig: ExitSignal = {
      [EXIT_TAG]: true,
      code: c,
      toString: () => "[v7 dispatch exit]",
    };
    throw sig;
  }) as typeof process.exit;

  try {
    await (handler as (p: ParsedV7Args, o: OutputOptions) => Promise<void>)(parsed, opts);
  } catch (err) {
    if (isExitSignal(err)) {
      // exitCode already captured on first signal.
    } else {
      // Real failure — surface as exit=1 + stderr.
      if (!firstExitSeen) exitCode = 1;
      const msg = err instanceof Error ? err.stack ?? err.message : String(err);
      stderr += msg + "\n";
    }
  } finally {
    process.stdout.write = origStdoutWrite;
    process.stderr.write = origStderrWrite;
    process.exit = origExit;
  }

  // Scrub our sentinel from stderr if a user catch serialized it.
  if (stderr) {
    stderr = stderr.replace(/\{"error":"\[v7 dispatch exit\][^}]*\}\n?/g, "");
  }

  // Try to parse stdout as a single JSON document (handlers use --json
  // shape; the MCP path always passes opts.json=true).
  let jsonResult: unknown;
  const trimmed = stdout.trim();
  if (trimmed.length > 0) {
    try {
      jsonResult = JSON.parse(trimmed);
    } catch {
      // stdout was not JSON (e.g. `eval snap` writes the tree as text
      // when opts.json=false). Leave jsonResult undefined; caller falls
      // back to stdout.
    }
  }

  // EX_SOFTWARE (70) + `not_implemented_yet` envelope = v6 fall-through.
  const fallback =
    exitCode === 70 &&
    isPlainObject(jsonResult) &&
    (jsonResult as Record<string, unknown>).error === "not_implemented_yet";

  return {
    ok: exitCode === 0,
    exitCode,
    stdout,
    stderr,
    jsonResult,
    covenant_kind: entry.covenant_kind,
    subcommand: entry.subcommand,
    mcp_tool: entry.mcp_tool,
    ...(fallback ? { fallback_to_v6: true as const } : {}),
  };
}

/** Lazy-load the verb router module and return its TABLE-equivalent. */
async function loadVerb(verb: string): Promise<Record<string, unknown>> {
  switch (verb) {
    case "build": {
      const { handler: skill } = await import("../build/skill.js");
      const { handler: template } = await import("../build/template.js");
      const { handler: valueSource } = await import("../build/value-source.js");
      return { skill, template, "value-source": valueSource };
    }
    case "breath": {
      const [go, fill, type, click, press, select, scroll, submit, execute, authCapture, proxyRotate, close] = await Promise.all([
        import("../breath/go.js"),
        import("../breath/fill.js"),
        import("../breath/type.js"),
        import("../breath/click.js"),
        import("../breath/press.js"),
        import("../breath/select.js"),
        import("../breath/scroll.js"),
        import("../breath/submit.js"),
        import("../breath/execute.js"),
        import("../breath/auth-capture.js"),
        import("../breath/proxy-rotate.js"),
        import("../breath/close.js"),
      ]);
      return {
        go: go.handler,
        fill: fill.handler,
        type: type.handler,
        click: click.handler,
        press: press.handler,
        select: select.handler,
        scroll: scroll.handler,
        submit: submit.handler,
        execute: execute.handler,
        "auth-capture": authCapture.handler,
        "proxy-rotate": proxyRotate.handler,
        close: close.handler,
      };
    }
    case "eval": {
      const [snap, resolve, status, version, trace, markdown, screenshot, text, cookies, stats, skills, skill, sessions, earnings, settings, feedback, reflect] = await Promise.all([
        import("../eval/snap.js"),
        import("../eval/resolve.js"),
        import("../eval/status.js"),
        import("../eval/version.js"),
        import("../eval/trace.js"),
        import("../eval/markdown.js"),
        import("../eval/screenshot.js"),
        import("../eval/text.js"),
        import("../eval/cookies.js"),
        import("../eval/stats.js"),
        import("../eval/skills.js"),
        import("../eval/skill.js"),
        import("../eval/sessions.js"),
        import("../eval/earnings.js"),
        import("../eval/settings.js"),
        import("../eval/feedback.js"),
        import("../eval/reflect.js"),
      ]);
      return {
        snap: snap.handler,
        resolve: resolve.handler,
        status: status.handler,
        version: version.handler,
        trace: trace.handler,
        markdown: markdown.handler,
        screenshot: screenshot.handler,
        text: text.handler,
        cookies: cookies.handler,
        stats: stats.handler,
        skills: skills.handler,
        skill: skill.handler,
        sessions: sessions.handler,
        earnings: earnings.handler,
        settings: settings.handler,
        feedback: feedback.handler,
        reflect: reflect.handler,
      };
    }
    default:
      return {};
  }
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * Main entry. Look up the kind, translate args -> ParsedV7Args via the
 * mcp-args adapter, invoke the handler with stdout/exit shimmed, return
 * a structured result.
 *
 * `ctx` carries cross-cutting hints (e.g. preferred output mode) and is
 * forwarded to the per-kind arg adapter so it can synthesize default
 * flags (e.g. always pass --json for MCP callers).
 */
export async function dispatchByKind(
  kind: string,
  args: Record<string, unknown>,
  ctx: DispatchContext = {},
): Promise<DispatchResult> {
  const entry = findKindEntry(kind);
  if (!entry) {
    return {
      ok: false,
      exitCode: 70,
      stdout: "",
      stderr: "",
      covenant_kind: kind as V7CovenantKind,
      subcommand: "",
      mcp_tool: null,
      dispatch_error: `unknown_kind:${kind}`,
    };
  }

  let parsed: ParsedV7Args;
  try {
    parsed = buildParsedArgsForKind(entry, args, ctx);
  } catch (err) {
    return {
      ok: false,
      exitCode: 64,
      stdout: "",
      stderr: err instanceof Error ? err.message : String(err),
      covenant_kind: entry.covenant_kind,
      subcommand: entry.subcommand,
      mcp_tool: entry.mcp_tool,
      dispatch_error: "bad_args",
    };
  }

  const opts: OutputOptions = {
    json: ctx.json !== false, // MCP defaults to JSON; CLI uses TTY heuristic.
    pretty: ctx.pretty === true,
  };

  // Serialize through the dispatch mutex to avoid global stdout/exit races.
  const next = dispatchLock.then(() => runHandlerCaptured(entry, parsed, opts));
  dispatchLock = next.catch(() => undefined);
  return next;
}
