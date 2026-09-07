import { describe, expect, test } from "bun:test";
import type { ZkProof, ProofCommitment, ProofVerificationResult } from "../src/types/proof.js";
import type { EndpointDescriptor } from "../src/types/skill.js";

describe("ZkProof types", () => {
  test("ZkProof has required fields", () => {
    const proof: ZkProof = {
      proof_type: "tlsnotary",
      proof_data: "base64-encoded-proof",
      commitment: {
        response_body_hash: "sha256:abc123",
        domain: "api.example.com",
        url_template: "https://api.example.com/v1/items",
        method: "GET",
        response_status: 200,
        captured_at: "2026-05-02T12:00:00Z",
      },
      notary_id: "notary-1",
      generated_at: "2026-05-02T12:00:00Z",
      verified: false,
    };
    expect(proof.proof_type).toBe("tlsnotary");
    expect(proof.commitment.domain).toBe("api.example.com");
    expect(proof.verified).toBe(false);
  });

  test("EndpointDescriptor accepts optional zk_proof field", () => {
    const ep: EndpointDescriptor = {
      endpoint_id: "ep-1",
      method: "GET",
      url_template: "https://api.example.com/v1/items",
      idempotency: "safe",
      verification_status: "verified",
      reliability_score: 0.95,
      zk_proof: {
        proof_type: "tlsnotary",
        proof_data: "base64-proof",
        commitment: {
          response_body_hash: "sha256:abc123",
          domain: "api.example.com",
          url_template: "https://api.example.com/v1/items",
          method: "GET",
          response_status: 200,
          captured_at: "2026-05-02T12:00:00Z",
        },
        notary_id: "notary-1",
        generated_at: "2026-05-02T12:00:00Z",
        verified: true,
      },
    };
    expect(ep.zk_proof?.proof_type).toBe("tlsnotary");
    expect(ep.zk_proof?.verified).toBe(true);
  });

  test("ProofVerificationResult reports pass/fail with reason", () => {
    const result: ProofVerificationResult = {
      valid: true,
      proof_type: "tlsnotary",
      verified_at: "2026-05-02T12:00:00Z",
      domain_match: true,
      response_hash_match: true,
    };
    expect(result.valid).toBe(true);

    const failed: ProofVerificationResult = {
      valid: false,
      proof_type: "tlsnotary",
      verified_at: "2026-05-02T12:00:00Z",
      domain_match: true,
      response_hash_match: false,
      failure_reason: "response body hash mismatch",
    };
    expect(failed.valid).toBe(false);
    expect(failed.failure_reason).toBe("response body hash mismatch");
  });
});
