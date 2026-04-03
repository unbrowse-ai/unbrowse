import type { EndpointDescriptor, SkillManifest } from "../types/index.js";

const STALE_THRESHOLD_MS = 24 * 60 * 60 * 1000; // 24 hours

export function selectVerificationCandidates(
  skill: SkillManifest,
  options?: {
    staleOnly?: boolean;
    limit?: number;
    now?: number;
  },
): EndpointDescriptor[] {
  const now = options?.now ?? Date.now();
  const candidates = skill.endpoints.filter((endpoint) => {
    if (endpoint.method !== "GET") return false;
    if (!options?.staleOnly) return true;
    const isDisabled = endpoint.verification_status === "disabled";
    const isFailed = endpoint.verification_status === "failed";
    const lowReliability = typeof endpoint.reliability_score === "number" && endpoint.reliability_score < 0.2;
    const lastVerified = endpoint.last_verified_at
      ? new Date(endpoint.last_verified_at).getTime()
      : 0;
    return isDisabled || isFailed || lowReliability || now - lastVerified > STALE_THRESHOLD_MS;
  });
  const limit = options?.limit && options.limit > 0 ? options.limit : candidates.length;
  return candidates.slice(0, limit);
}
