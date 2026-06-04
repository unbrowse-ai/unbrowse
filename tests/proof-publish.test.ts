import { describe, expect, test } from "bun:test";
import type { EndpointDescriptor } from "../src/types/index.js";
import type { commitment proof } from "../src/types/proof.js";

describe("proof publishing", () => {
  test("endpoint with zk_proof serializes proof in JSON payload", () => {
    const proof: commitment proof = {
      proof_type: "commitment_only",
      proof_data: "base64data",
      commitment: {
        response_body_hash: "sha256:abc123",
        domain: "example.com",
        url_template: "https://example.com/api/items",
        method: "GET",
        response_status: 200,
        captured_at: "2026-05-02T12:00:00Z",
      },
      notary_id: "local",
      generated_at: "2026-05-02T12:00:00Z",
      verified: false,
    };

    const endpoint: EndpointDescriptor = {
      endpoint_id: "ep-1",
      method: "GET",
      url_template: "https://example.com/api/items",
      idempotency: "safe",
      verification_status: "verified",
      reliability_score: 0.95,
      zk_proof: proof,
    };

    const serialized = JSON.stringify(endpoint);
    const deserialized = JSON.parse(serialized) as EndpointDescriptor;
    expect(deserialized.zk_proof?.proof_type).toBe("commitment_only");
    expect(deserialized.zk_proof?.commitment.response_body_hash).toBe("sha256:abc123");
    expect(deserialized.zk_proof?.commitment.domain).toBe("example.com");
  });

  test("endpoint without zk_proof serializes without proof field", () => {
    const endpoint: EndpointDescriptor = {
      endpoint_id: "ep-1",
      method: "GET",
      url_template: "https://example.com/api/items",
      idempotency: "safe",
      verification_status: "verified",
      reliability_score: 0.95,
    };

    const serialized = JSON.stringify(endpoint);
    const deserialized = JSON.parse(serialized);
    expect(deserialized.zk_proof).toBeUndefined();
  });
});
