/**
 * error-envelope — ONE shape for every CLI failure.
 *
 * There were two, and each was superior in a different half:
 *
 *   src/cli-v7/output.ts emitErr   {ok, error:"<msg>", code, retryable, name, report_bugs}
 *     79 call sites, 65 test assertions. Richer FIELDS — it is the only one that
 *     carries `retryable`, which is the field an agent's recovery loop reads to
 *     decide retry-vs-escalate. But it writes the machine JSON to STDERR.
 *
 *   src/cli.ts (hand-built, 3 sites)  {ok, error:{code, message, field}}
 *     Correct STREAM — machine payload on stdout, human line on stderr — and it
 *     carries `field` context naming which input was wrong. But it drops
 *     `retryable` entirely and reinvents the nesting.
 *
 * An agent parsing failures therefore needed two parsers and got `retryable` from
 * only one of them. This module is the single source of truth for the SHAPE, so
 * neither caller hand-rolls it again.
 *
 * The shape keeps the flat top-level fields the existing 65 assertions pin
 * (`error` as the human message string, `code`, `retryable`) and ADDS structured
 * context beside them rather than nesting and breaking them. Additive on purpose:
 * unifying a contract by breaking every existing reader is not unification, it is
 * a second migration.
 *
 * Pure — no I/O, no stream choice. The caller decides where it goes, which is
 * exactly the decision that is still inconsistent and is recorded as such in
 * CLAUDE.md rather than silently papered over here.
 */

export interface ErrorEnvelopeInput {
  /** Machine-routable snake_case token. Agents route on this, never on prose. */
  code: string;
  /** Human-readable sentence. */
  message: string;
  /**
   * Can the SAME call succeed if repeated, unchanged?
   *
   * Not "was this an error" — "is retrying pointless". A usage error, a refused
   * scheme, an unknown command: false. A transient network failure or a wall the
   * ladder may clear: true. Defaulting to false is the safe direction — a wrong
   * `true` sends an agent into a loop that cannot terminate.
   */
  retryable?: boolean;
  /** Which input was at fault, e.g. "--url". Omitted when not input-attributable. */
  field?: string;
  /** Extra machine-readable context: candidates, limits, vendor, etc. */
  context?: Record<string, unknown>;
  /** Error class name, when the failure came from a thrown Error. */
  name?: string;
}

export interface ErrorEnvelope {
  ok: false;
  /** The human message. Kept a STRING at the top level — 65 assertions pin it. */
  error: string;
  code: string;
  retryable: boolean;
  field?: string;
  name?: string;
  report_bugs: string;
  [k: string]: unknown;
}

/** Where persistent failures belong: upstream, not in a retry loop. */
export const REPORT_BUGS =
  "gh issue create --repo unbrowse-ai/unbrowse (see SKILL.md 'Reporting issues')";

/**
 * Leading snake_case token of a message, e.g. "intent_required: usage …".
 *
 * Handlers conventionally lead with one, so an agent can route on a stable field
 * instead of parsing prose. Exported so the convention has one definition rather
 * than a regex copied per call site.
 */
export function codeFromMessage(message: string): string {
  const m = /^([a-z][a-z0-9_]{2,40}):/.exec(message ?? "");
  return m ? m[1] : "error";
}

export function buildErrorEnvelope(input: ErrorEnvelopeInput): ErrorEnvelope {
  const { code, message, retryable = false, field, context, name } = input;
  return {
    ok: false,
    error: message,
    code,
    retryable,
    ...(field ? { field } : {}),
    ...(name ? { name } : {}),
    ...(context ?? {}),
    report_bugs: REPORT_BUGS,
  };
}
