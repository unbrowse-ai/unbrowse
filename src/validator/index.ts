import Ajv from "ajv";
import addFormats from "ajv-formats";
import type { SkillManifest } from "../types/index.js";

const ajv = new Ajv({ allErrors: true });
addFormats(ajv);

const SKILL_SCHEMA = {
  type: "object",
  required: ["skill_id", "version", "schema_version", "name", "intent_signature", "domain", "description", "owner_type", "endpoints", "lifecycle", "created_at", "updated_at"],
  properties: {
    skill_id: { type: "string", minLength: 1 },
    version: { type: "string", pattern: "^\\d+\\.\\d+\\.\\d+$" },
    schema_version: { type: "string" },
    name: { type: "string", minLength: 1 },
    intent_signature: { type: "string", minLength: 1 },
    domain: { type: "string", minLength: 1 },
    description: { type: "string" },
    owner_type: { type: "string", enum: ["agent", "marketplace", "user"] },
    endpoints: { type: "array", minItems: 1 },
    lifecycle: { type: "string", enum: ["active", "deprecated", "disabled"] },
    created_at: { type: "string" },
    updated_at: { type: "string" },
  },
  additionalProperties: true,
};

const ENDPOINT_SCHEMA = {
  type: "object",
  required: ["endpoint_id", "method", "url_template", "idempotency", "verification_status", "reliability_score"],
  properties: {
    endpoint_id: { type: "string", minLength: 1 },
    method: { type: "string", enum: ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"] },
    url_template: { type: "string", minLength: 1, pattern: "^https?://" },
    idempotency: { type: "string", enum: ["safe", "unsafe"] },
    verification_status: { type: "string", enum: ["verified", "unverified", "failed", "pending"] },
    reliability_score: { type: "number", minimum: 0, maximum: 1 },
  },
  additionalProperties: true,
};

const validateSkill = ajv.compile(SKILL_SCHEMA);
const validateEndpoint = ajv.compile(ENDPOINT_SCHEMA);

export interface ValidationResult {
  valid: boolean;
  hardErrors: string[];
  softWarnings: string[];
}

export function validateSkillManifest(manifest: unknown): ValidationResult {
  const hardErrors: string[] = [];
  const softWarnings: string[] = [];

  const skillValid = validateSkill(manifest);
  if (!skillValid) {
    for (const err of validateSkill.errors ?? []) {
      hardErrors.push(`skill${err.instancePath} ${err.message}`);
    }
  }

  const m = manifest as SkillManifest;
  if (Array.isArray(m?.endpoints)) {
    for (const ep of m.endpoints) {
      const epValid = validateEndpoint(ep);
      if (!epValid) {
        for (const err of validateEndpoint.errors ?? []) {
          hardErrors.push(`endpoint[${ep.endpoint_id}]${err.instancePath} ${err.message}`);
        }
      }
      if (ep.method !== "GET" && !ep.csrf_plan) {
        softWarnings.push(`endpoint[${ep.endpoint_id}] non-GET endpoint missing csrf_plan`);
      }
    }
  }

  return { valid: hardErrors.length === 0, hardErrors, softWarnings };
}
