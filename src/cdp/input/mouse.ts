// CDP_PRIMITIVES.md §L-input — Input.dispatchMouseEvent (atomic) + composed click/move

import type { MouseButton, MouseEventParams, Target } from "../types.js";

/**
 * Input.dispatchMouseEvent — atomic primitive. The 1:1 CDP method.
 * Composite gestures (click, drag, hover) live in the recipe layer above primitives.
 */
export async function dispatchMouseEvent(_target: Target, _params: MouseEventParams): Promise<void> {
  throw new Error("not_implemented_yet: scaffold only");
}

/**
 * Composed: press then release at the same coords. NOT a CDP primitive —
 * two dispatchMouseEvent calls (mousePressed + mouseReleased) at (x,y).
 */
export async function click(
  _target: Target,
  _x: number,
  _y: number,
  _opts?: { button?: MouseButton; clickCount?: number; modifiers?: number },
): Promise<void> {
  throw new Error("not_implemented_yet: scaffold only");
}

/**
 * Composed: mouseMoved at the given coords.
 */
export async function move(_target: Target, _x: number, _y: number, _opts?: { modifiers?: number }): Promise<void> {
  throw new Error("not_implemented_yet: scaffold only");
}
