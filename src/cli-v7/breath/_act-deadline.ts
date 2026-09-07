/**
 * `_act-deadline` — the ONE wall-clock bound shared by the breath act verbs.
 *
 * ISSUE-4: `breath go` documents `--timeout` (default 30000) but `run-js`,
 * `select` and `click` had NO wall-clock bound at all. Against a session whose
 * lease/target has gone stale the CDP round-trip (`conn.call` -> CRI
 * `client.send`) simply never settles — Chrome accepts the frame and answers
 * nothing — so the process sat until an external `timeout` killed it at 90s.
 * `go`/`fill`/`eval snap` answered on the same session, so the hang is a dead
 * target, not a bad command.
 *
 * Two refusals live here, and they are the point:
 *
 *   1. Refuse to wait forever. Every bounded act is raced against a timer.
 *   2. Refuse to lie about the outcome. When the timer wins we do NOT return a
 *      partial/empty success — that would swap a visible hang for an invisible
 *      truncation, which is strictly worse. We emit a `target_lost` envelope
 *      that NAMES what was being waited on and exit non-zero.
 *
 * ONE helper, not three copies. ISSUE-1 in this same review is the cost of the
 * other choice: browser-profile discovery duplicated four times, so the Flatpak
 * fix had to land four times. A verb opts in by wrapping its body in
 * `guardAct`; it does not re-implement the race, the flag parse, or the error
 * envelope.
 */
import { emit, type OutputOptions } from "../output.js";

/**
 * Inherited from `breath go`'s documented default. Kept as one constant so the
 * three verbs cannot drift apart from `go` (or from each other) by edit.
 */
export const DEFAULT_ACT_TIMEOUT_MS = 30_000;

/**
 * sysexits EX_UNAVAILABLE. Deliberately NOT the generic 65/1 these verbs use
 * for a CDP error or a bad selector: "the target stopped answering" is a
 * different verdict from "the selector does not match", and a caller deciding
 * whether to re-open a session needs to tell them apart.
 */
export const EX_TARGET_LOST = 69;

/**
 * The `--timeout` help row, verbatim from `breath go`'s help block. Shared so
 * the flag documents itself identically wherever it is offered.
 */
export const TIMEOUT_FLAG_HELP: { name: string; description: string; value_expected: boolean } = {
  name: "--timeout",
  description: "Wall-clock timeout in ms (default: 30000).",
  value_expected: true,
};

/**
 * `--timeout <ms>` parse, matching the existing convention in
 * `breath auth-capture` (the only verb that had actually implemented the flag):
 * a string flag through `parseInt`, otherwise the default.
 *
 * A non-numeric or non-positive value falls back to the default rather than
 * becoming `NaN` — `setTimeout(NaN)` fires immediately, which would turn a
 * typo'd flag into an instant unexplained `target_lost`.
 */
export function parseActTimeoutMs(
  flags: Record<string, string | boolean>,
  fallbackMs: number = DEFAULT_ACT_TIMEOUT_MS,
): number {
  const raw = flags.timeout;
  if (typeof raw !== "string") return fallbackMs;
  const n = parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0) return fallbackMs;
  return n;
}

/**
 * The deadline fired. `waitingOn` names the specific step, so the failure is
 * readable without a debugger: "breath click: CDP attach+click on target
 * ABC123" beats "timeout".
 */
export class TargetLostError extends Error {
  readonly waitingOn: string;
  readonly timeoutMs: number;

  constructor(waitingOn: string, timeoutMs: number) {
    super(`target_lost: timed out after ${timeoutMs}ms waiting on ${waitingOn}`);
    // `emitErr` renders `{error: message, name}` — `target_lost` in the name
    // field keeps the machine-readable discriminator even on that path.
    this.name = "target_lost";
    this.waitingOn = waitingOn;
    this.timeoutMs = timeoutMs;
  }
}

/**
 * Race `work` against a wall clock. Resolves with the work's value, rejects
 * with the work's own error, or rejects with `TargetLostError` when the clock
 * wins — it never resolves with a substitute value, because a caller that
 * cannot tell "done" from "gave up" is the bug this exists to close.
 *
 * The timer is cleared on settle so a fast act does not hold the event loop
 * open, and it is deliberately NOT `unref`'d: an unref'd timer would let the
 * process exit 0 while the real work hung — a silent success, the worst
 * outcome available.
 */
export function withActDeadline<T>(
  work: Promise<T> | (() => Promise<T>),
  timeoutMs: number,
  waitingOn: string,
): Promise<T> {
  const p = typeof work === "function" ? work() : work;
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new TargetLostError(waitingOn, timeoutMs));
    }, timeoutMs);
    p.then(
      (value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(err);
      },
    );
    // The abandoned work may still reject later; swallow it so a lost target
    // cannot become an unhandled rejection after we have already reported.
    void p.catch(() => {});
  });
}

export interface ActDeadlineSpec {
  /** e.g. "breath click" — echoed into the envelope. */
  subcommand: string;
  /** kind-map op_kind row for the verb. */
  opKind: string;
  /** Human/machine description of the awaited step. */
  waitingOn: string;
  timeoutMs: number;
  opts: OutputOptions;
  /** Session the act was bound to, when one was resolved. */
  sessionId?: string;
}

/**
 * Emit the `target_lost` envelope. Exported for the (rare) caller that has
 * already caught the error itself; `guardAct` is the normal entry point.
 */
export function emitTargetLost(spec: ActDeadlineSpec, err: TargetLostError): void {
  emit(
    {
      ok: false,
      subcommand: spec.subcommand,
      op_kind: spec.opKind,
      error: "target_lost",
      // NAME what we were waiting on — a bare "timeout" sends the caller
      // back to a repro they already ran.
      waiting_on: err.waitingOn,
      timeout_ms: err.timeoutMs,
      ...(spec.sessionId ? { session_id: spec.sessionId } : {}),
      message: err.message,
      next_step:
        "the browse target stopped answering CDP (stale lease/target). Re-open with `unbrowse act go <url>` and retry, or raise --timeout <ms>.",
    },
    spec.opts,
  );
}

/**
 * Run `work` under the bound. On timeout: emit `target_lost` and exit
 * EX_TARGET_LOST. Any other rejection is re-thrown untouched so the verb's own
 * error handling (selector_not_found, EX_CDP, value-store failures) is
 * unchanged — this adds a bound, it does not take over failure reporting.
 */
export async function guardAct<T>(spec: ActDeadlineSpec, work: () => Promise<T>): Promise<T> {
  try {
    return await withActDeadline(work, spec.timeoutMs, spec.waitingOn);
  } catch (err) {
    if (err instanceof TargetLostError) {
      emitTargetLost(spec, err);
      process.exit(EX_TARGET_LOST);
    }
    throw err;
  }
}
