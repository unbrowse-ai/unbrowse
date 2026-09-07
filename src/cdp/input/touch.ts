// CDP_PRIMITIVES.md §L-input — Input.dispatchTouchEvent + Input.dispatchDragEvent

import type { DragEventParams, Target, TouchEventParams } from "../types.js";

/**
 * Input.dispatchTouchEvent — mobile-emulation taps when deviceMetrics.mobile=true.
 */
export async function dispatchTouchEvent(_target: Target, _params: TouchEventParams): Promise<void> {
  throw new Error("not_implemented_yet: scaffold only");
}

/**
 * Input.dispatchDragEvent — replaces Kuri `drag(source, target)`.
 */
export async function dispatchDragEvent(_target: Target, _params: DragEventParams): Promise<void> {
  throw new Error("not_implemented_yet: scaffold only");
}

/**
 * Input.setInterceptDrags — arms Input.dragIntercepted for drag-with-payload flows.
 */
export async function setInterceptDrags(_target: Target, _enabled: boolean): Promise<void> {
  throw new Error("not_implemented_yet: scaffold only");
}
