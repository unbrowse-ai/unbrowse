// CDP_PRIMITIVES.md §L-DOM — Runtime.evaluate / callFunctionOn / addBinding

import type { RemoteObjectId, RuntimeEvaluateOptions, RuntimeEvaluateResult, Target } from "../types.js";

/**
 * Runtime.enable — arms Runtime.consoleAPICalled + exceptionThrown
 * (replaces Kuri `getConsole` / `getErrors`).
 */
export async function runtimeEnable(_target: Target): Promise<{ enabled: true }> {
  throw new Error("not_implemented_yet: scaffold only");
}

/**
 * Runtime.evaluate — replaces Kuri `evaluate`. The single primitive that
 * `getMarkdown` / `getText` / `getLinks` / `findText` / `getCurrentUrl` / `getPerfLcp`
 * all collapse to with a fixed JS expression.
 */
export async function evaluate(_target: Target, _opts: RuntimeEvaluateOptions): Promise<RuntimeEvaluateResult> {
  throw new Error("not_implemented_yet: scaffold only");
}

/**
 * Runtime.callFunctionOn — typed re-evaluation on a specific node objectId;
 * safer than string-interpolated `evaluate`.
 */
export async function callFunctionOn(
  _target: Target,
  _opts: {
    functionDeclaration: string;
    objectId?: RemoteObjectId;
    arguments?: Array<{ value?: unknown; objectId?: RemoteObjectId; unserializableValue?: string }>;
    awaitPromise?: boolean;
    returnByValue?: boolean;
  },
): Promise<RuntimeEvaluateResult> {
  throw new Error("not_implemented_yet: scaffold only");
}

/**
 * Runtime.addBinding — install a JS-callable function that posts back to the agent via
 * Runtime.bindingCalled events. Used for the spoof-init-script handshake and interceptor wiring.
 */
export async function addBinding(_target: Target, _name: string, _executionContextId?: number): Promise<void> {
  throw new Error("not_implemented_yet: scaffold only");
}

/** Subscribe to Runtime.consoleAPICalled (replaces Kuri `getConsole`). */
export function onConsoleAPICalled(
  _target: Target,
  _handler: (ev: { type: string; args: unknown[]; executionContextId: number; timestamp: number }) => void,
): () => void {
  throw new Error("not_implemented_yet: scaffold only");
}

/** Subscribe to Runtime.exceptionThrown (replaces Kuri `getErrors`). */
export function onExceptionThrown(
  _target: Target,
  _handler: (ev: { timestamp: number; exceptionDetails: unknown }) => void,
): () => void {
  throw new Error("not_implemented_yet: scaffold only");
}
