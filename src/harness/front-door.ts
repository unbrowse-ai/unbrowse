import { createHash } from "node:crypto";
import { createPermissionContext, type PermissionContext, type PermissionDecision, type PermissionEffect } from "../runtime/permission-gate.js";
import {
  compactAgentFrontDoorResult,
  convergeAgentFrontDoorResult,
  recordHarnessLastRun,
} from "../agent-path.js";

export type HarnessInvocationState = "running" | "completed" | "blocked" | "failed";

export interface HarnessInvocationEvent {
  readonly state: HarnessInvocationState;
  readonly at: string;
  readonly duration_ms?: number;
  readonly reason?: string;
}

export interface HarnessInvocationInput {
  intent: string;
  url: string;
  effect?: PermissionEffect;
  workspace_trusted?: boolean;
  approval_token?: string;
}

export interface HarnessInvocationOptions {
  permission?: PermissionContext;
  timeout_ms?: number;
  signal?: AbortSignal;
  now?: () => number;
  onEvent?: (event: HarnessInvocationEvent) => void | Promise<void>;
  /** foreground-only means the injected transport cannot cancel already-started work. */
  cancellation_mode?: "cooperative" | "foreground-only";
}

export type HarnessInvocationResult<T> =
  | { state: "completed"; value: T; permission: PermissionDecision; events: readonly HarnessInvocationEvent[]; observer_errors: readonly string[] }
  | { state: "blocked"; gate: PermissionDecision; events: readonly HarnessInvocationEvent[]; observer_errors: readonly string[] }
  | { state: "failed"; error: Error; permission: PermissionDecision; events: readonly HarnessInvocationEvent[]; observer_errors: readonly string[]; execution_may_continue: boolean };

export function harnessOperationFingerprint(input: HarnessInvocationInput): string {
  const normalized = `${input.effect ?? "read"}
${input.url.trim()}
${input.intent.trim()}`;
  return createHash("sha256").update(normalized).digest("hex");
}

function abortError(reason: string): Error {
  const error = new Error(reason);
  error.name = "AbortError";
  return error;
}

/**
 * Production front-door membrane. It gates each invocation before transport,
 * owns cancellation/deadline state, and emits an immutable lifecycle trace.
 * The resolver/capture implementation remains injected so this module cannot
 * become a second orchestrator.
 */
export async function runHarnessInvocation<T>(
  input: HarnessInvocationInput,
  invoke: (signal: AbortSignal) => Promise<T>,
  options: HarnessInvocationOptions = {},
): Promise<HarnessInvocationResult<T>> {
  const now = options.now ?? Date.now;
  const permission = options.permission ?? createPermissionContext(now);
  const effect = input.effect ?? "read";
  const decision = permission.evaluate({
    operation_fingerprint: harnessOperationFingerprint(input),
    effect,
    workspace_trusted: input.workspace_trusted ?? false,
    approval_token: input.approval_token,
  });
  const events: HarnessInvocationEvent[] = [];
  const observerErrors: string[] = [];
  const emit = async (event: HarnessInvocationEvent) => {
    const frozen = Object.freeze({ ...event });
    events.push(frozen);
    try {
      await options.onEvent?.(frozen);
    } catch (cause) {
      observerErrors.push(cause instanceof Error ? cause.message : String(cause));
    }
  };
  const frozenEvents = () => Object.freeze([...events]);
  const frozenObserverErrors = () => Object.freeze([...observerErrors]);

  if (decision.decision !== "allow") {
    await emit({ state: "blocked", at: new Date(now()).toISOString(), reason: decision.reason });
    return { state: "blocked", gate: decision, events: frozenEvents(), observer_errors: frozenObserverErrors() };
  }

  const controller = new AbortController();
  const forwardAbort = () => controller.abort(options.signal?.reason ?? abortError("harness_aborted"));
  if (options.signal?.aborted) forwardAbort();
  else options.signal?.addEventListener("abort", forwardAbort, { once: true });

  const failed = async (error: Error, started?: number): Promise<HarnessInvocationResult<T>> => {
    const ended = now();
    await emit({
      state: "failed",
      at: new Date(ended).toISOString(),
      ...(started === undefined ? {} : { duration_ms: Math.max(0, ended - started) }),
      reason: error.message,
    });
    return {
      state: "failed",
      error,
      permission: decision,
      events: frozenEvents(),
      observer_errors: frozenObserverErrors(),
      execution_may_continue: options.cancellation_mode === "foreground-only" && started !== undefined && controller.signal.aborted,
    };
  };

  if (controller.signal.aborted) {
    const error = controller.signal.reason instanceof Error
      ? controller.signal.reason
      : abortError("harness_aborted");
    options.signal?.removeEventListener("abort", forwardAbort);
    return failed(error);
  }

  const started = now();
  await emit({ state: "running", at: new Date(started).toISOString() });
  if (controller.signal.aborted) {
    const error = controller.signal.reason instanceof Error
      ? controller.signal.reason
      : abortError("harness_aborted");
    options.signal?.removeEventListener("abort", forwardAbort);
    return failed(error, started);
  }

  const timeoutMs = Math.max(1, Math.min(options.timeout_ms ?? 120_000, 15 * 60_000));
  const timer = setTimeout(() => controller.abort(abortError("harness_deadline_exceeded")), timeoutMs);

  try {
    const aborted = new Promise<never>((_, reject) => {
      controller.signal.addEventListener("abort", () => reject(
        controller.signal.reason instanceof Error ? controller.signal.reason : abortError("harness_aborted"),
      ), { once: true });
    });
    if (controller.signal.aborted) throw controller.signal.reason;
    const value = await Promise.race([invoke(controller.signal), aborted]);
    const ended = now();
    await emit({ state: "completed", at: new Date(ended).toISOString(), duration_ms: Math.max(0, ended - started) });
    return {
      state: "completed",
      value,
      permission: decision,
      events: frozenEvents(),
      observer_errors: frozenObserverErrors(),
    };
  } catch (cause) {
    const error = cause instanceof Error ? cause : new Error(String(cause));
    return await failed(error, started);
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", forwardAbort);
  }

}

export interface FinalizeFrontDoorOptions {
  raw?: boolean;
  persist?: boolean;
}

/** Select/compress/write: the only projection crossing the agent membrane. */
export async function finalizeFrontDoorResult(
  payload: Record<string, unknown>,
  input: { intent: string; url: string },
  options: FinalizeFrontDoorOptions = {},
): Promise<{ converged: Record<string, unknown>; output: Record<string, unknown> }> {
  const converged = convergeAgentFrontDoorResult(payload, input);
  const output = options.raw ? converged : compactAgentFrontDoorResult(converged, input);
  if (options.persist !== false) await recordHarnessLastRun(input, converged);
  return { converged, output };
}
