// CDP_PRIMITIVES.md §L-input — Input.dispatchKeyEvent + Input.insertText

import type { KeyEventParams, Target } from "../types.js";

/**
 * Input.dispatchKeyEvent — atomic key primitive (keyDown / keyUp / rawKeyDown / char).
 * Replaces Kuri `keyDown` / `keyUp` / `press` with honest modifier handling.
 */
export async function dispatchKeyEvent(_target: Target, _params: KeyEventParams): Promise<void> {
  throw new Error("not_implemented_yet: scaffold only");
}

/**
 * Input.insertText — paste-equivalent input; bypasses per-key React handlers.
 * Replaces Kuri `keyboardInsertText`.
 */
export async function insertText(_target: Target, _text: string): Promise<{ len: number }> {
  throw new Error("not_implemented_yet: scaffold only");
}

/**
 * Composed: down then up of the same key. NOT a CDP primitive — two dispatchKeyEvent calls.
 */
export async function press(_target: Target, _key: string, _opts?: { code?: string; modifiers?: number; text?: string }): Promise<void> {
  throw new Error("not_implemented_yet: scaffold only");
}
