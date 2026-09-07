// CDP_PRIMITIVES.md §L-DOM — Page.captureScreenshot + DOMSnapshot.captureSnapshot + Page.printToPDF

import type { Target } from "../types.js";

/**
 * Page.captureScreenshot — replaces Kuri `screenshot`. Image lands in value-store.
 */
export async function captureScreenshot(
  _target: Target,
  _opts?: {
    format?: "jpeg" | "png" | "webp";
    quality?: number;
    clip?: { x: number; y: number; width: number; height: number; scale: number };
    fromSurface?: boolean;
    captureBeyondViewport?: boolean;
  },
): Promise<{ data: string; format: string }> {
  throw new Error("not_implemented_yet: scaffold only");
}

/**
 * DOMSnapshot.captureSnapshot — full layout-tree dump (used for headless A11y crawls).
 */
export async function captureSnapshot(
  _target: Target,
  _computedStyles: string[],
  _opts?: { includePaintOrder?: boolean; includeDOMRects?: boolean; includeBlendedBackgroundColors?: boolean },
): Promise<{ documents: unknown[]; strings: string[] }> {
  throw new Error("not_implemented_yet: scaffold only");
}

/**
 * Page.printToPDF — future doc-extraction primitive (free upgrade vs Kuri, which lacks it).
 */
export async function printToPDF(
  _target: Target,
  _opts?: {
    landscape?: boolean;
    displayHeaderFooter?: boolean;
    printBackground?: boolean;
    scale?: number;
    paperWidth?: number;
    paperHeight?: number;
    marginTop?: number;
    marginBottom?: number;
    marginLeft?: number;
    marginRight?: number;
    pageRanges?: string;
  },
): Promise<{ data: string }> {
  throw new Error("not_implemented_yet: scaffold only");
}
