import { describe, expect, it } from "bun:test";
import { isAuthGatedEndpoint } from "../src/verification/auth-gate.js";
import type { EndpointDescriptor, SkillManifest } from "../src/types/index.js";

function makeEndpoint(overrides: Partial<EndpointDescriptor> = {}): EndpointDescriptor {
  return {
    endpoint_id: "ep-1",
    method: "GET",
    url_template: "https://api.example.com/me",
    idempotency: "safe",
    verification_status: "verified",
    reliability_score: 0.9,
    ...overrides,
  };
}

function makeSkill(overrides: Partial<SkillManifest> = {}): SkillManifest {
  return {
    skill_id: "skill-1",
    version: "1.0.0",
    schema_version: "1",
    name: "example",
    intent_signature: "browse example.com",
    domain: "example.com",
    description: "Example",
    owner_type: "agent",
    execution_type: "http",
    lifecycle: "active",
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    endpoints: [],
    ...overrides,
  };
}

describe("isAuthGatedEndpoint", () => {
  it("treats skills with auth profiles as auth-gated", () => {
    expect(isAuthGatedEndpoint(
      makeSkill({ auth_profile_ref: "linkedin.com" }),
      makeEndpoint(),
    )).toBe(true);
  });

  it("treats endpoints with semantic auth_required as auth-gated", () => {
    expect(isAuthGatedEndpoint(
      makeSkill(),
      makeEndpoint({ semantic: { action_kind: "detail", resource_kind: "profile", auth_required: true } }),
    )).toBe(true);
  });

  it("leaves public GET endpoints eligible for verification", () => {
    expect(isAuthGatedEndpoint(
      makeSkill(),
      makeEndpoint({ semantic: { action_kind: "detail", resource_kind: "profile" } }),
    )).toBe(false);
  });
});
