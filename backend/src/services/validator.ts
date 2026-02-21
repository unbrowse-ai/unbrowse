import type { SkillManifest, ValidationResult } from "../types.js";

const VALID_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"];
const VALID_OWNER_TYPES = ["agent", "marketplace", "user"];
const VALID_LIFECYCLES = ["active", "deprecated", "disabled"];
const VALID_IDEMPOTENCY = ["safe", "unsafe"];
const VALID_VERIFICATION = ["verified", "unverified", "failed", "pending"];
const VERSION_RE = /^\d+\.\d+\.\d+$/;
const URL_RE = /^https?:\/\//;

export function validateSkillManifest(manifest: unknown): ValidationResult {
  const hardErrors: string[] = [];
  const softWarnings: string[] = [];
  const m = manifest as Record<string, unknown>;

  // Required string fields
  for (const field of ["skill_id", "version", "schema_version", "name", "intent_signature", "domain", "description", "owner_type", "lifecycle", "created_at", "updated_at"]) {
    if (typeof m?.[field] !== "string" || (m[field] as string).length === 0) {
      hardErrors.push(`skill.${field} is required and must be a non-empty string`);
    }
  }

  if (typeof m?.version === "string" && !VERSION_RE.test(m.version as string)) {
    hardErrors.push("skill.version must match semver (x.y.z)");
  }
  if (typeof m?.owner_type === "string" && !VALID_OWNER_TYPES.includes(m.owner_type as string)) {
    hardErrors.push(`skill.owner_type must be one of: ${VALID_OWNER_TYPES.join(", ")}`);
  }
  if (typeof m?.lifecycle === "string" && !VALID_LIFECYCLES.includes(m.lifecycle as string)) {
    hardErrors.push(`skill.lifecycle must be one of: ${VALID_LIFECYCLES.join(", ")}`);
  }

  // Endpoints array
  if (!Array.isArray(m?.endpoints) || (m.endpoints as unknown[]).length === 0) {
    hardErrors.push("skill.endpoints must be a non-empty array");
  } else {
    for (const ep of m.endpoints as Record<string, unknown>[]) {
      const epId = (ep.endpoint_id as string) ?? "unknown";
      if (typeof ep.endpoint_id !== "string" || ep.endpoint_id.length === 0) {
        hardErrors.push(`endpoint.endpoint_id is required`);
      }
      if (typeof ep.method !== "string" || !VALID_METHODS.includes(ep.method)) {
        hardErrors.push(`endpoint[${epId}].method must be one of: ${VALID_METHODS.join(", ")}`);
      }
      if (typeof ep.url_template !== "string" || !URL_RE.test(ep.url_template)) {
        hardErrors.push(`endpoint[${epId}].url_template must start with http:// or https://`);
      }
      if (typeof ep.idempotency !== "string" || !VALID_IDEMPOTENCY.includes(ep.idempotency)) {
        hardErrors.push(`endpoint[${epId}].idempotency must be "safe" or "unsafe"`);
      }
      if (typeof ep.verification_status !== "string" || !VALID_VERIFICATION.includes(ep.verification_status)) {
        hardErrors.push(`endpoint[${epId}].verification_status must be one of: ${VALID_VERIFICATION.join(", ")}`);
      }
      if (typeof ep.reliability_score !== "number" || ep.reliability_score < 0 || ep.reliability_score > 1) {
        hardErrors.push(`endpoint[${epId}].reliability_score must be a number between 0 and 1`);
      }
      if (ep.method !== "GET" && !ep.csrf_plan) {
        softWarnings.push(`endpoint[${epId}] non-GET endpoint missing csrf_plan`);
      }
    }
  }

  return { valid: hardErrors.length === 0, hardErrors, softWarnings };
}
