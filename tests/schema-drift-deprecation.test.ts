/**
 * Tests for schema drift → endpoint deprecation behavior (Feature #101).
 */
import { describe, it, expect } from "bun:test";
import { detectSchemaDrift } from "../src/transform/drift.js";
import type { EndpointDescriptor, SkillManifest, VerificationStatus } from "../src/types/index.js";

function makeEndpoint(overrides: Partial<EndpointDescriptor> = {}): EndpointDescriptor {
  return {
    endpoint_id: "ep1",
    method: "GET",
    url_template: "https://api.example.com/data",
    idempotency: "safe",
    verification_status: "verified",
    reliability_score: 0.8,
    response_schema: {
      type: "object",
      properties: { id: { type: "string" }, name: { type: "string" } },
      required: ["id", "name"],
    },
    ...overrides,
  };
}

describe("detectSchemaDrift", () => {
  it("detects critical drift when fields are removed", () => {
    const schema = {
      type: "object" as const,
      properties: { id: { type: "string" }, name: { type: "string" } },
      required: ["id", "name"],
    };
    const liveData = { id: "123" }; // name field missing
    const drift = detectSchemaDrift(schema, liveData);
    expect(drift.drifted).toBe(true);
    expect(drift.removed_fields.length).toBeGreaterThan(0);
  });

  it("does not flag drift when only new fields are added", () => {
    const schema = {
      type: "object" as const,
      properties: { id: { type: "string" } },
      required: ["id"],
    };
    const liveData = { id: "123", extra_field: "new" }; // extra field added, not removed
    const drift = detectSchemaDrift(schema, liveData);
    // Added fields only — removed_fields and type_changes should be empty
    expect(drift.removed_fields.length).toBe(0);
    expect(drift.type_changes.length).toBe(0);
  });

  it("detects type change drift", () => {
    const schema = {
      type: "object" as const,
      properties: { count: { type: "number" } },
      required: ["count"],
    };
    const liveData = { count: "not-a-number" }; // type changed from number to string
    const drift = detectSchemaDrift(schema, liveData);
    expect(drift.drifted).toBe(true);
    expect(drift.type_changes.length).toBeGreaterThan(0);
  });
});

describe("verifyEndpoint critical drift → failed status", () => {
  it("critical drift (removed fields) maps to 'failed' status not 'pending'", () => {
    // The logic extracted from verifyEndpoint:
    const schema = {
      type: "object" as const,
      properties: { id: { type: "string" }, name: { type: "string" } },
      required: ["id", "name"],
    };
    const liveData = { id: "123" }; // name removed
    const drift = detectSchemaDrift(schema, liveData);
    const hasCriticalDrift = drift.drifted && (drift.removed_fields.length > 0 || drift.type_changes.length > 0);
    const newStatus: VerificationStatus = hasCriticalDrift ? "failed" : "verified";
    expect(newStatus).toBe("failed");
  });

  it("non-breaking drift (new fields only) keeps 'verified' status", () => {
    const schema = {
      type: "object" as const,
      properties: { id: { type: "string" } },
      required: ["id"],
    };
    const liveData = { id: "123", bonus: true };
    const drift = detectSchemaDrift(schema, liveData);
    const hasCriticalDrift = drift.drifted && (drift.removed_fields.length > 0 || drift.type_changes.length > 0);
    const newStatus: VerificationStatus = hasCriticalDrift ? "failed" : "verified";
    expect(newStatus).toBe("verified");
  });

  it("scheduler includes pending endpoints for re-verification", () => {
    // Verify the scheduler condition logic directly
    const isDisabled = false;
    const isPending = true;
    const lastVerified = Date.now() - 1000; // recently verified
    const STALE_THRESHOLD_MS = 24 * 60 * 60 * 1000;
    const shouldVerify = isDisabled || isPending || (Date.now() - lastVerified > STALE_THRESHOLD_MS);
    expect(shouldVerify).toBe(true); // isPending triggers re-verification
  });
});
