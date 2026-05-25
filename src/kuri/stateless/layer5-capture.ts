/**
 * Stateless-kuri Layer 5 — Capture layer.
 *
 * Contract: bbe92ca2
 *
 * A contract-neuron primitive that takes (chrome_runtime_pointer,
 * capture_policy) and emits a capture_session_pointer that is written-to
 * during all subsequent page-control ops on that chrome_runtime_pointer.
 * On chrome teardown, the capture_session_pointer resolves to a frozen
 * ledger row (HAR + fetch/XHR records + perf entries + websocket frames).
 *
 * Validation: bench probes obtain a capture_session_pointer per probe,
 * perform page ops, and emit a stand-alone trace that can be replayed
 * without re-running the browser.
 *
 * NOT IMPLEMENTED. Scaffolding only.
 */

import type { ChromeRuntimePointer } from "./layer3-runtime.js";

export interface CapturePolicy {
  readonly record_har: boolean;
  readonly record_fetch_xhr: boolean;
  readonly record_websocket: boolean;
  readonly record_perf: boolean;
}

export interface CaptureSessionPointer {
  readonly session_id: string;
  readonly chrome_runtime: ChromeRuntimePointer;
  readonly policy: CapturePolicy;
  readonly trace_path: string; // file path written on teardown
  readonly frozen: boolean;
}

export async function startCaptureSession(_runtime: ChromeRuntimePointer, _policy: CapturePolicy): Promise<CaptureSessionPointer> {
  throw new Error("Layer 5 (stateless-kuri bbe92ca2) not implemented — scaffold only.");
}
