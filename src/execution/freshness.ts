import type { EndpointDescriptor, ExecutionOptions } from "../types/index.js";

export const SKILL_FRESHNESS_TTL_MS = 7 * 24 * 60 * 60_000;
export const SKILL_FRESHNESS_CHECK_TIMEOUT_MS = 5_000;

export type EndpointFreshnessCheckResult =
  | { outcome: "valid"; status: number }
  | { outcome: "stale"; status: number }
  | { outcome: "unknown"; status?: number; reason: string };

export type EndpointFreshnessFetch = (
  url: string,
  init: {
    method: string;
    headers?: Record<string, string>;
    redirect: "follow";
    signal: AbortSignal;
  },
) => Promise<{ status: number }>;

export function isEndpointFreshnessFailureStatus(status: number): boolean {
  // Only treat permanent removal signals as stale. 5xx is transient and
  // handled by the existing withRetry path; preflight should not gate it.
  return status === 404 || status === 410;
}

export function shouldValidateEndpointFreshness(
  endpoint: EndpointDescriptor,
  options?: Pick<ExecutionOptions, "dry_run" | "force_capture">,
  nowMs = Date.now(),
  ttlMs = SKILL_FRESHNESS_TTL_MS,
): boolean {
  if (options?.dry_run || options?.force_capture) return false;
  if (endpoint.method === "WS") return false;
  // HEAD-on-mutation endpoints commonly return 404/410, which would falsely
  // disable valid POST/PUT/PATCH/DELETE routes. Only probe safe methods.
  if (endpoint.idempotency !== "safe") return false;
  if (endpoint.method !== "GET") return false;
  if (!endpoint.last_validated_at) return true;

  const lastValidatedMs = Date.parse(endpoint.last_validated_at);
  if (!Number.isFinite(lastValidatedMs)) return true;
  return nowMs - lastValidatedMs >= ttlMs;
}

export function markEndpointFreshnessValid(endpoint: EndpointDescriptor, nowIso: string): void {
  endpoint.last_validated_at = nowIso;
  if (endpoint.verification_status === "failed" || endpoint.verification_status === "pending" || endpoint.verification_status === "unverified") {
    endpoint.verification_status = "verified";
  }
}

export function markEndpointFreshnessStale(endpoint: EndpointDescriptor): void {
  endpoint.verification_status = "failed";
}

function hasUnresolvedTemplate(url: string): boolean {
  return /\{[^}]+\}/.test(url);
}

async function fetchStatusWithTimeout(
  url: string,
  method: "HEAD" | "GET",
  headers: Record<string, string> | undefined,
  fetchImpl: EndpointFreshnessFetch,
  timeoutMs: number,
): Promise<number> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url, {
      method,
      headers,
      redirect: "follow",
      signal: controller.signal,
    });
    return res.status;
  } finally {
    clearTimeout(timeout);
  }
}

export async function validateEndpointUrlFreshness(
  url: string,
  endpoint: Pick<EndpointDescriptor, "method">,
  headers: Record<string, string> | undefined = undefined,
  fetchImpl: EndpointFreshnessFetch = fetch,
  timeoutMs = SKILL_FRESHNESS_CHECK_TIMEOUT_MS,
): Promise<EndpointFreshnessCheckResult> {
  if (hasUnresolvedTemplate(url)) {
    return { outcome: "unknown", reason: "unresolved_template" };
  }

  try {
    new URL(url);
  } catch {
    return { outcome: "unknown", reason: "invalid_url" };
  }

  try {
    let status = await fetchStatusWithTimeout(url, "HEAD", headers, fetchImpl, timeoutMs);
    if ((status === 405 || status === 501) && endpoint.method === "GET") {
      status = await fetchStatusWithTimeout(url, "GET", headers, fetchImpl, timeoutMs);
    }
    if (status >= 200 && status < 300) return { outcome: "valid", status };
    if (isEndpointFreshnessFailureStatus(status)) return { outcome: "stale", status };
    return { outcome: "unknown", status, reason: "non_terminal_status" };
  } catch {
    return { outcome: "unknown", reason: "network_error" };
  }
}
