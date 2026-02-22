import { executeInBrowser } from "../capture/index.js";
import { updateEndpointScore } from "../marketplace/index.js";
import { listSkills, getSkill } from "../marketplace/index.js";
import { detectSchemaDrift } from "../transform/drift.js";
import type { EndpointDescriptor, SkillManifest, VerificationStatus } from "../types/index.js";

/**
 * Verify a single endpoint by test-executing safe (GET) endpoints.
 * Returns the new verification status.
 */
export async function verifyEndpoint(
  skill: SkillManifest,
  endpoint: EndpointDescriptor
): Promise<VerificationStatus> {
  // Only verify safe (GET) endpoints automatically
  if (endpoint.method !== "GET") return endpoint.verification_status;

  try {
    const { status, data } = await executeInBrowser(
      endpoint.url_template,
      endpoint.method,
      endpoint.headers_template ?? {},
      undefined,
      undefined,
      undefined
    );

    if (status < 200 || status >= 300) {
      await updateEndpointScore(skill.skill_id, endpoint.endpoint_id, endpoint.reliability_score, "failed");
      return "failed";
    }

    // Check for schema drift if we have a response schema
    let hasCriticalDrift = false;
    if (endpoint.response_schema && data != null) {
      const drift = detectSchemaDrift(endpoint.response_schema, data);
      if (drift.drifted && (drift.removed_fields.length > 0 || drift.type_changes.length > 0)) {
        hasCriticalDrift = true;
      }
    }

    const newStatus: VerificationStatus = hasCriticalDrift ? "pending" : "verified";
    // Reset score for recovered disabled endpoints so they become usable again
    const newScore = endpoint.verification_status === "disabled" && newStatus === "verified"
      ? 0.5
      : endpoint.reliability_score;
    await updateEndpointScore(skill.skill_id, endpoint.endpoint_id, newScore, newStatus);
    // Update last_verified_at
    const fullSkill = await getSkill(skill.skill_id);
    if (fullSkill) {
      const ep = fullSkill.endpoints.find((e) => e.endpoint_id === endpoint.endpoint_id);
      if (ep) ep.last_verified_at = new Date().toISOString();
    }
    return newStatus;
  } catch {
    await updateEndpointScore(skill.skill_id, endpoint.endpoint_id, endpoint.reliability_score, "failed");
    return "failed";
  }
}

/**
 * Verify all safe endpoints in a skill.
 * Returns a map of endpoint_id -> verification status.
 */
export async function verifySkill(
  skill: SkillManifest
): Promise<Record<string, VerificationStatus>> {
  const results: Record<string, VerificationStatus> = {};
  for (const endpoint of skill.endpoints) {
    results[endpoint.endpoint_id] = await verifyEndpoint(skill, endpoint);
  }
  return results;
}

const VERIFICATION_INTERVAL_MS = 6 * 60 * 60 * 1000; // 6 hours
const STALE_THRESHOLD_MS = 24 * 60 * 60 * 1000; // 24 hours

/**
 * Schedule periodic re-verification of stale endpoints.
 */
export function schedulePeriodicVerification(): ReturnType<typeof setInterval> {
  return setInterval(async () => {
    const skills = await listSkills();
    const now = Date.now();
    for (const skill of skills) {
      if (skill.lifecycle !== "active") continue;
      for (const endpoint of skill.endpoints) {
        if (endpoint.method !== "GET") continue;
        const isDisabled = endpoint.verification_status === "disabled";
        const lastVerified = endpoint.last_verified_at
          ? new Date(endpoint.last_verified_at).getTime()
          : 0;
        if (isDisabled || now - lastVerified > STALE_THRESHOLD_MS) {
          await verifyEndpoint(skill, endpoint).catch(() => {});
        }
      }
    }
  }, VERIFICATION_INTERVAL_MS);
}
