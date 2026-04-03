import { executeInBrowser } from "../capture/index.js";
import { updateEndpointScore } from "../marketplace/index.js";
import { listSkills, getSkill } from "../marketplace/index.js";
import { detectSchemaDrift } from "../transform/drift.js";
import { computeVerificationCoverage, INITIAL_MATRIX } from "./matrix.js";
import { isAuthGatedEndpoint } from "./auth-gate.js";
import type { VerificationMatrix } from "./matrix.js";
import type { EndpointDescriptor, SkillManifest, VerificationStatus } from "../types/index.js";
import { selectVerificationCandidates } from "./candidates.js";

const VERIFICATION_INTERVAL_MS = 6 * 60 * 60 * 1000; // 6 hours
const VERIFY_ENDPOINT_BATCH_SIZE = Math.max(1, Number(process.env.UNBROWSE_VERIFY_ENDPOINT_BATCH_SIZE ?? 3));

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
  skill: SkillManifest,
  options?: {
    endpoints?: EndpointDescriptor[];
    staleOnly?: boolean;
    limit?: number;
    now?: number;
  },
): Promise<Record<string, VerificationStatus>> {
  const results: Record<string, VerificationStatus> = {};
  const endpoints = options?.endpoints ?? selectVerificationCandidates(skill, options);
  for (const endpoint of endpoints) {
    results[endpoint.endpoint_id] = await verifyEndpoint(skill, endpoint);
  }
  return results;
}

/**
 * Verify all safe endpoints in a skill and compute verification coverage
 * from the integration matrix. Returns endpoint results plus a coverage ratio.
 */
export async function verifySkillWithCoverage(
  skill: SkillManifest,
  matrix: VerificationMatrix = INITIAL_MATRIX,
): Promise<{ results: Record<string, VerificationStatus>; coverage: number }> {
  const results = await verifySkill(skill);
  const coverage = computeVerificationCoverage(matrix);
  return { results, coverage };
}

/**
 * Schedule periodic re-verification of stale endpoints.
 */
export function schedulePeriodicVerification(): ReturnType<typeof setInterval> {
  return setInterval(async () => {
    const skills = await listSkills();
    for (const skill of skills) {
      if (skill.lifecycle !== "active") continue;
      const endpoints = selectVerificationCandidates(skill, {
        staleOnly: true,
        limit: VERIFY_ENDPOINT_BATCH_SIZE,
      });
      for (const endpoint of endpoints) {
        if (isAuthGatedEndpoint(skill, endpoint)) continue;
        await verifyEndpoint(skill, endpoint).catch(() => {});
      }
    }
  }, VERIFICATION_INTERVAL_MS);
}
