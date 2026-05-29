/**
 * Chrome-prim Layer 4 — Page-control layer (lifted from src/kuri/stateless/ 2026-05-28).
 * Gen 18:25 — same lift discipline.
 *
 * Contract: c9d8f459
 *
 * A contract-neuron primitive that takes (chrome_runtime_pointer, page_op)
 * and emits an op_result_pointer. The chrome_runtime_pointer is taken by
 * reference (not consumed) so multiple page ops can run on the same
 * ephemeral chrome — but the chrome is still per-call, not shared globally.
 *
 * Validation: nav + eval + intercept can all be issued against one
 * chrome_runtime_pointer in one bench probe; 35 concurrent (chrome +
 * page-control) compositions produce 35 distinct intercepted-traffic
 * captures.
 *
 * NOT IMPLEMENTED. Scaffolding only.
 */

import type { ChromeRuntimePointer } from "./layer3-runtime.js";

export type PageOp =
  | { readonly kind: "nav"; readonly url: string; readonly wait_until: "load" | "domcontentloaded" | "networkidle"; readonly timeout_ms?: number }
  | { readonly kind: "eval"; readonly expression: string; readonly timeout_ms?: number }
  | { readonly kind: "screenshot"; readonly format: "png" | "jpeg"; readonly full_page: boolean }
  | { readonly kind: "intercept"; readonly pattern: string; readonly on_request?: "log" | "block" | "modify"; readonly on_response?: "log" };

export interface OpResultPointer {
  readonly op_kind: PageOp["kind"];
  readonly success: boolean;
  readonly result_ref: string; // file path, ledger row id, or pointer URL
  readonly duration_ms: number;
}

export async function pageOp(_runtime: ChromeRuntimePointer, _op: PageOp): Promise<OpResultPointer> {
  throw new Error("Layer 4 (chrome-prim c9d8f459) not implemented — scaffold only.");
}
