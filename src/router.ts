import type { EndpointDescriptor } from "./types/index.js";

export const UNSAFE_ACTION_BLOCK_THRESHOLD = 0.6;

export function computeUnsafeActionScore(endpoint: EndpointDescriptor): number {
  let score = 0;
  if (endpoint.idempotency === "unsafe") score += 0.4;
  if (endpoint.method === "POST" || endpoint.method === "PUT" || endpoint.method === "DELETE") score += 0.2;
  const inferredFromBundle = /inferred from js bundle/i.test(endpoint.description ?? "");
  if (inferredFromBundle) score += 0.2;
  if (!endpoint.response_schema) score += 0.1;
  if (endpoint.verification_status === "failed") score += 0.1;
  if (endpoint.reliability_score < 0.3) score += 0.1;
  if (endpoint.trigger_url) score -= 0.1;
  if (endpoint.verification_status === "verified") score -= 0.15;
  return Math.max(0, Math.min(1, score));
}
