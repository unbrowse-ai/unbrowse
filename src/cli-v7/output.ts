/**
 * v7 CLI output helpers. Honors --json for machine-readable mode;
 * falls back to pretty-stringified JSON on TTY. Matches v6's posture
 * (always-JSON stdout — never freeform prose) but strips v6's
 * TTY-auto-pretty heuristic in favor of explicit --json / --pretty.
 *
 * Exit-code convention:
 *   0   success
 *   64  EX_USAGE          — user gave bad args, or --help was the request
 *   70  EX_SOFTWARE       — handler not yet implemented (v7 stub state)
 *   1   generic failure
 */
import { contractVerdictFromEnvelope } from "../values/contract-shape.js";

export const EX_OK = 0;
export const EX_USAGE = 64;
export const EX_SOFTWARE = 70;
export const EX_GENERIC = 1;

export interface OutputOptions {
  /** Emit single-line JSON instead of pretty 2-space. */
  json?: boolean;
  /** Force pretty regardless of TTY/json. */
  pretty?: boolean;
}

export function emit(data: unknown, opts: OutputOptions = {}): void {
  // /contract shaped all the way through: EVERY primitive's envelope carries the three-shape
  // verdict (interpret→verify→adjudicate), attached here at the ONE shared boundary from the
  // envelope's universal shape — zero per-primitive wiring. resolve/execute attach a richer
  // bible-anchor-enriched `_contract` themselves; this fills it for every other primitive and
  // NEVER overwrites an existing one. Fail-open: a verdict error can never break an emit.
  if (data && typeof data === "object" && !Array.isArray(data) && !("_contract" in (data as object))) {
    try {
      (data as Record<string, unknown>)._contract = contractVerdictFromEnvelope(data as Record<string, unknown>);
    } catch {
      /* fail-open — output is never blocked by the verdict */
    }
  }
  const usePretty = opts.pretty === true || (opts.json !== true && !!process.stdout.isTTY);
  const out = usePretty ? JSON.stringify(data, null, 2) : JSON.stringify(data);
  process.stdout.write(out + "\n");
}

export function emitErr(err: unknown, opts: OutputOptions = {}): void {
  const usePretty = opts.pretty === true || (opts.json !== true && !!process.stderr.isTTY);
  const payload = err instanceof Error
    ? { error: err.message, name: err.name }
    : { error: typeof err === "string" ? err : JSON.stringify(err) };
  const out = usePretty ? JSON.stringify(payload, null, 2) : JSON.stringify(payload);
  process.stderr.write(out + "\n");
}

/**
 * Render a help block for a subcommand and exit EX_USAGE.
 * Always machine-readable; the agent reading stdout gets a typed JSON
 * description of the surface, not human prose.
 */
export function helpExit(
  subcommand: string,
  spec: {
    summary: string;
    usage: string;
    positional?: Array<{ name: string; description: string; required?: boolean }>;
    flags?: Array<{ name: string; description: string; value_expected?: boolean }>;
    op_kind: string;
    mcp_tool: string | null;
    verb: "build" | "breath" | "eval";
    not_implemented_yet?: true;
  },
  opts: OutputOptions = {},
): never {
  emit(
    {
      help: true,
      subcommand,
      ...spec,
      stub: spec.not_implemented_yet === true,
    },
    opts,
  );
  process.exit(EX_USAGE);
}

/**
 * Stub action — handler isn't wired to its real impl yet.
 * Exits EX_SOFTWARE so a calling script can distinguish "you asked for
 * --help" (64) from "I haven't built this yet" (70).
 */
export function notImplementedExit(
  subcommand: string,
  detail: {
    op_kind: string;
    mcp_tool: string | null;
    verb: "build" | "breath" | "eval";
    /** Owning wave / sibling subagent that will land the real impl. */
    pending_in?: string;
  },
  opts: OutputOptions = {},
): never {
  emit(
    {
      ok: false,
      subcommand,
      error: "not_implemented_yet",
      ...detail,
      next_step: `track v7 build wave; this scaffold landed by W3 and the real handler lands in ${detail.pending_in ?? "a later wave"}`,
    },
    opts,
  );
  process.exit(EX_SOFTWARE);
}

/**
 * Secret-redaction invariant: any handler that ever holds a resolved
 * value (from src/values/ in a later wave) MUST print this token
 * instead of the value itself. Pointer is fine to surface.
 *
 * Use as `[pointer:<uri>]` when printing — the literal word "pointer"
 * appears, never "value".
 */
export function redactedPointer(pointer: string): string {
  return `[pointer:${pointer}]`;
}
