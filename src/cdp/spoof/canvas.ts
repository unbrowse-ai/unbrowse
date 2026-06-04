// CDP_PRIMITIVES.md §spoof-surface — Page.addScriptToEvaluateOnNewDocument: canvas fingerprint

import type { SpoofInitScript, Target } from "../types.js";

/**
 * Install the canvas-fingerprint shim: patch HTMLCanvasElement.toDataURL +
 * CanvasRenderingContext2D.getImageData with deterministic per-session noise
 * (seeded from sessionId so the fingerprint is stable across a probe's lifetime).
 */
export async function installCanvasShim(_target: Target, _seed?: string): Promise<SpoofInitScript> {
  throw new Error("not_implemented_yet: scaffold only");
}

/**
 * Source string of the canvas shim parameterised by seed.
 */
export function canvasShimSource(_seed: string): string {
  throw new Error("not_implemented_yet: scaffold only");
}
