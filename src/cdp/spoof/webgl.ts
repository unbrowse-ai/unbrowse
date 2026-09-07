// CDP_PRIMITIVES.md §spoof-surface — Page.addScriptToEvaluateOnNewDocument: WebGL fingerprint

import type { SpoofInitScript, Target } from "../types.js";

/**
 * Install the WebGL-fingerprint shim: patch WebGLRenderingContext.getParameter to return
 * realistic UNMASKED_VENDOR_WEBGL / UNMASKED_RENDERER_WEBGL strings matching the
 * spoofed platform from Emulation.setDeviceMetricsOverride.
 */
export async function installWebglShim(
  _target: Target,
  _opts?: { vendor?: string; renderer?: string },
): Promise<SpoofInitScript> {
  throw new Error("not_implemented_yet: scaffold only");
}

/**
 * Source string of the WebGL shim, parameterised by vendor/renderer overrides.
 */
export function webglShimSource(_vendor: string, _renderer: string): string {
  throw new Error("not_implemented_yet: scaffold only");
}
