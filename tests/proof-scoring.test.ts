import { describe, expect, test } from "bun:test";
import { selectMarketplacePublishEndpoints } from "../src/publish-admission.js";
import type { EndpointDescriptor, SkillManifest } from "../src/types/index.js";

function makeEndpoint(overrides: Partial<EndpointDescriptor> = {}): EndpointDescriptor {
  return {
    endpoint_id: "ep-1",
    method: "GET",
    url_template: "https://www.example.com/api/items?page={page}",
    description: "List items",
    idempotency: "safe",
    verification_status: "verified",
    reliability_score: 0.95,
    response_schema: {
      type: "object",
      properties: { items: { type: "array" } },
    },
    semantic: {
      action_kind: "list",
      resource_kind: "item",
      example_fields: ["items[].id"],
    },
    ...overrides,
  } as EndpointDescriptor;
}

function makeSkill(overrides: Partial<SkillManifest> = {}): SkillManifest {
  return {
    skill_id: "skill-1",
    version: "1.0.0",
    schema_version: "1",
    name: "Example",
    intent_signature: "list items",
    domain: "www.example.com",
    description: "Example skill",
    owner_type: "marketplace",
    execution_type: "http",
    endpoints: [makeEndpoint()],
    lifecycle: "active",
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    ...overrides,
  };
}

describe("proof scoring bonus", () => {
  test("endpoint with zk_proof scores higher than same endpoint without", () => {
    const withoutProof = makeEndpoint({
      endpoint_id: "no-proof",
      url_template: "https://www.example.com/api/items?page={page}",
    });
    const withProof = makeEndpoint({
      endpoint_id: "with-proof",
      url_template: "https://www.example.com/api/users?page={page}",
      zk_proof: {
        proof_type: "commitment_only",
        proof_data: "base64",
        commitment: {
          response_body_hash: "sha256:abc",
          domain: "www.example.com",
          url_template: "https://www.example.com/api/users",
          method: "GET",
          response_status: 200,
          captured_at: "2026-05-02T12:00:00Z",
        },
        notary_id: "local",
        generated_at: "2026-05-02T12:00:00Z",
        verified: false,
      },
    });

    const skill = makeSkill({ endpoints: [withoutProof, withProof] });
    const result = selectMarketplacePublishEndpoints(skill);
    const selected = result.endpoints.map((e) => e.endpoint_id);
    expect(selected).toContain("with-proof");
    expect(selected).toContain("no-proof");
    expect(selected.indexOf("with-proof")).toBeLessThan(selected.indexOf("no-proof"));
  });

  test("verified zk_proof scores higher than unverified", () => {
    const unverified = makeEndpoint({
      endpoint_id: "unverified-proof",
      url_template: "https://www.example.com/api/items?page={page}",
      zk_proof: {
        proof_type: "commitment_only",
        proof_data: "base64",
        commitment: {
          response_body_hash: "sha256:abc",
          domain: "www.example.com",
          url_template: "https://www.example.com/api/items",
          method: "GET",
          response_status: 200,
          captured_at: "2026-05-02T12:00:00Z",
        },
        notary_id: "local",
        generated_at: "2026-05-02T12:00:00Z",
        verified: false,
      },
    });
    const verified = makeEndpoint({
      endpoint_id: "verified-proof",
      url_template: "https://www.example.com/api/users?page={page}",
      zk_proof: {
        proof_type: "tlsnotary",
        proof_data: "base64-real-proof",
        commitment: {
          response_body_hash: "sha256:abc",
          domain: "www.example.com",
          url_template: "https://www.example.com/api/users",
          method: "GET",
          response_status: 200,
          captured_at: "2026-05-02T12:00:00Z",
        },
        notary_id: "notary-1",
        generated_at: "2026-05-02T12:00:00Z",
        verified: true,
      },
    });

    const skill = makeSkill({ endpoints: [unverified, verified] });
    const result = selectMarketplacePublishEndpoints(skill);
    const selected = result.endpoints.map((e) => e.endpoint_id);
    expect(selected.indexOf("verified-proof")).toBeLessThan(selected.indexOf("unverified-proof"));
  });
});
