// CDP_PRIMITIVES.md §L-network — Fetch.enable + Fetch.requestPaused dispatch

import type { FetchRequest, FetchRequestPattern, Target } from "../types.js";

/**
 * Fetch.enable — arm the interceptor with URL patterns. Replaces Kuri's `interceptStart`.
 * Returns the count of patterns registered (idempotent on rearm with same patterns).
 */
export async function fetchEnable(
  _target: Target,
  _patterns: FetchRequestPattern[],
  _opts?: { handleAuthRequests?: boolean },
): Promise<{ patternCount: number }> {
  throw new Error("not_implemented_yet: scaffold only");
}

/**
 * Fetch.disable — drop the interceptor.
 */
export async function fetchDisable(_target: Target): Promise<void> {
  throw new Error("not_implemented_yet: scaffold only");
}

/**
 * Subscribe to Fetch.requestPaused. Handler receives the paused request and MUST
 * eventually call one of continueRequest / fulfillRequest / failRequest / continueWithAuth.
 * Returns an unsubscribe.
 */
export function onRequestPaused(
  _target: Target,
  _handler: (req: FetchRequest) => void | Promise<void>,
): () => void {
  throw new Error("not_implemented_yet: scaffold only");
}

/**
 * Fetch.continueRequest — pass-through (optionally with mutations).
 */
export async function continueRequest(
  _target: Target,
  _requestId: string,
  _opts?: { url?: string; method?: string; postData?: string; headers?: Record<string, string> },
): Promise<{ mutated: boolean }> {
  throw new Error("not_implemented_yet: scaffold only");
}

/**
 * Fetch.fulfillRequest — serve a cached/mock response inline without hitting the network.
 */
export async function fulfillRequest(
  _target: Target,
  _requestId: string,
  _response: { responseCode: number; responseHeaders?: Array<{ name: string; value: string }>; body?: string; binaryResponseHeaders?: string },
): Promise<{ servedFrom: "cache" | "mock" }> {
  throw new Error("not_implemented_yet: scaffold only");
}

/**
 * Fetch.failRequest — surgical block (preferred over setBlockedURLs when pattern needs context).
 */
export async function failRequest(
  _target: Target,
  _requestId: string,
  _errorReason: "Failed" | "Aborted" | "TimedOut" | "AccessDenied" | "ConnectionClosed" | "ConnectionReset" | "ConnectionRefused" | "ConnectionAborted" | "ConnectionFailed" | "NameNotResolved" | "InternetDisconnected" | "AddressUnreachable" | "BlockedByClient" | "BlockedByResponse",
): Promise<{ reason: string }> {
  throw new Error("not_implemented_yet: scaffold only");
}

/**
 * Fetch.continueWithAuth — satisfy a paused proxy/origin auth challenge. Replaces Kuri's `setCredentials`.
 */
export async function continueWithAuth(
  _target: Target,
  _requestId: string,
  _authChallengeResponse: { response: "Default" | "CancelAuth" | "ProvideCredentials"; username?: string; password?: string },
): Promise<{ authProvided: boolean }> {
  throw new Error("not_implemented_yet: scaffold only");
}
