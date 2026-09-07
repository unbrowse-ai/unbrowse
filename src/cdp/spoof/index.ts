// CDP_PRIMITIVES.md §spoof-surface — plane re-exports + Emulation.* knobs

export * as userAgent from "./user-agent.js";
export * as navigator from "./navigator.js";
export * as canvas from "./canvas.js";
export * as webgl from "./webgl.js";

import type { SpoofInitScript, Target } from "../types.js";

/**
 * Page.addScriptToEvaluateOnNewDocument — install an init script that runs before any
 * page script. Replaces Kuri `addInitScript` + `injectStealthScript` + `INTERCEPTOR_SCRIPT`.
 * Idempotent on (target, source): re-issuing returns the same identifier.
 */
export async function addInitScript(
  _target: Target,
  _source: string,
  _opts?: { worldName?: string; includeCommandLineAPI?: boolean; runImmediately?: boolean },
): Promise<SpoofInitScript> {
  throw new Error("not_implemented_yet: scaffold only");
}

/**
 * Page.removeScriptToEvaluateOnNewDocument — per-session cleanup.
 */
export async function removeInitScript(_target: Target, _identifier: string): Promise<void> {
  throw new Error("not_implemented_yet: scaffold only");
}

/**
 * Emulation.setDeviceMetricsOverride — viewport, DPR, mobile bit (drives sec-ch-ua-mobile).
 */
export async function setDeviceMetricsOverride(
  _target: Target,
  _opts: { width: number; height: number; deviceScaleFactor: number; mobile: boolean; screenWidth?: number; screenHeight?: number; positionX?: number; positionY?: number; dontSetVisibleSize?: boolean; screenOrientation?: { type: "portraitPrimary" | "portraitSecondary" | "landscapePrimary" | "landscapeSecondary"; angle: number } },
): Promise<void> {
  throw new Error("not_implemented_yet: scaffold only");
}

/**
 * Emulation.setTimezoneOverride — spoof timezone to match proxy geo.
 */
export async function setTimezoneOverride(_target: Target, _timezoneId: string): Promise<void> {
  throw new Error("not_implemented_yet: scaffold only");
}

/**
 * Emulation.setLocaleOverride — match Accept-Language + navigator.language.
 */
export async function setLocaleOverride(_target: Target, _locale: string): Promise<void> {
  throw new Error("not_implemented_yet: scaffold only");
}

/**
 * Emulation.setGeolocationOverride — match proxy geo.
 */
export async function setGeolocationOverride(
  _target: Target,
  _opts: { latitude: number; longitude: number; accuracy: number },
): Promise<void> {
  throw new Error("not_implemented_yet: scaffold only");
}
