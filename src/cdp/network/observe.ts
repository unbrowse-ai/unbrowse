// CDP_PRIMITIVES.md §L-network — Network.enable + lifecycle event subscriptions

import type {
  NetworkLoadingFinishedEvent,
  NetworkRequestWillBeSentEvent,
  NetworkResponseReceivedEvent,
  Target,
} from "../types.js";

/**
 * Network.enable — first call after target attach. Arms request/response/loading events
 * for HAR-equivalent capture.
 */
export async function networkEnable(
  _target: Target,
  _opts?: { maxResourceBufferSize?: number; maxTotalBufferSize?: number; maxPostDataSize?: number },
): Promise<{ enabled: true }> {
  throw new Error("not_implemented_yet: scaffold only");
}

/**
 * Network.disable.
 */
export async function networkDisable(_target: Target): Promise<void> {
  throw new Error("not_implemented_yet: scaffold only");
}

/**
 * Network.setCacheDisabled — force-fresh capture; load-bearing for HAR completeness.
 */
export async function setCacheDisabled(_target: Target, _disabled: boolean): Promise<{ cacheDisabled: boolean }> {
  throw new Error("not_implemented_yet: scaffold only");
}

/**
 * Network.setBlockedURLs — coarse-grained block by URL pattern (telemetry/ads).
 */
export async function setBlockedUrls(_target: Target, _patterns: string[]): Promise<{ count: number }> {
  throw new Error("not_implemented_yet: scaffold only");
}

/**
 * Network.getResponseBody — fetch the captured response body for a requestId.
 * Returned body should land in the value-store; receipt carries the sha256.
 */
export async function getResponseBody(
  _target: Target,
  _requestId: string,
): Promise<{ body: string; base64Encoded: boolean }> {
  throw new Error("not_implemented_yet: scaffold only");
}

/** Subscribe to Network.requestWillBeSent. */
export function onRequestWillBeSent(
  _target: Target,
  _handler: (ev: NetworkRequestWillBeSentEvent) => void,
): () => void {
  throw new Error("not_implemented_yet: scaffold only");
}

/** Subscribe to Network.responseReceived. */
export function onResponseReceived(
  _target: Target,
  _handler: (ev: NetworkResponseReceivedEvent) => void,
): () => void {
  throw new Error("not_implemented_yet: scaffold only");
}

/** Subscribe to Network.loadingFinished. */
export function onLoadingFinished(
  _target: Target,
  _handler: (ev: NetworkLoadingFinishedEvent) => void,
): () => void {
  throw new Error("not_implemented_yet: scaffold only");
}
