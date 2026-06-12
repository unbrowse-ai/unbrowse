// Server-first DOM extraction (Wave 2 STEP 3 of the
// move-only-the-deterministic-credential-free-non- migration; principle
// 20260522T031732Z-3c67f936, pointer-not-payload client architecture).
//
// Mirror of `rankEndpointsServerFirst` (src/client/rank-server-first.ts): the
// deterministic extraction intelligence is served from the backend
// (POST /v1/extract/refine, @unbrowse/extraction-core); the client tries
// the server first and falls back to the LOCAL `extractFromDOM` on any
// failure, so the capture/execution path never hard-fails offline.
//
// The client posts only an already-credential-stripped HTML string --
// the browser, cookies, and the authenticated fetch stay client-side.
// x402 payment-required errors propagate (the caller decides whether to
// settle and retry); every other failure degrades silently to local.

import { extractFromDOM, type ExtractionResult } from "./index.js";
import { refineExtractionRemote } from "../client/index.js";

/**
 * Try server-side extraction first; fall back to the local `extractFromDOM`
 * on any non-x402 failure. Behaviour is byte-identical to the local path
 * whenever the server is unreachable, local-only mode is set, or the
 * server returns a degraded/error result -- so wiring this in place of a
 * direct `extractFromDOM` call cannot regress offline behaviour.
 */
export async function extractFromDOMServerFirst(
  html: string,
  intent: string,
  contextUrl?: string,
): Promise<ExtractionResult> {
  const local = (): ExtractionResult => extractFromDOM(html, intent, contextUrl);
  if (typeof html !== "string" || html.length === 0) return local();

  // refineExtractionRemote returns null on every non-x402 failure and
  // re-raises x402 by contract; letting x402 propagate lets the caller
  // settle and retry.
  const remote = await refineExtractionRemote(html, intent ?? "", contextUrl);
  if (remote) return remote;
  return local();
}
