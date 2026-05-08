import { describe, expect, test } from "bun:test";
import { generateProof, isProofEnabled } from "../src/proof/index.js";

describe("proof generation", () => {
  const mockRequest = {
    url: "https://api.example.com/v1/items",
    method: "GET",
    request_headers: { "accept": "application/json" },
    response_status: 200,
    response_headers: { "content-type": "application/json" },
    response_body: JSON.stringify({ items: [{ id: 1 }] }),
    timestamp: "2026-05-02T12:00:00Z",
  };

  test("isProofEnabled returns false by default", () => {
    delete process.env.UNBROWSE_ZK_PROOF;
    expect(isProofEnabled()).toBe(false);
  });

  test("isProofEnabled returns true when UNBROWSE_ZK_PROOF=1", () => {
    process.env.UNBROWSE_ZK_PROOF = "1";
    expect(isProofEnabled()).toBe(true);
    delete process.env.UNBROWSE_ZK_PROOF;
  });

  test("generateProof creates commitment_only proof from request", async () => {
    const proof = await generateProof(mockRequest, "example.com");
    expect(proof.proof_type).toBe("commitment_only");
    expect(proof.commitment.domain).toBe("example.com");
    expect(proof.commitment.method).toBe("GET");
    expect(proof.commitment.response_body_hash).toMatch(/^sha256:/);
    expect(proof.notary_id).toBe("local");
    expect(proof.verified).toBe(false);
    expect(proof.generated_at).toBeTruthy();
  });

  test("generateProof handles missing response body", async () => {
    const noBody = { ...mockRequest, response_body: undefined };
    const proof = await generateProof(noBody, "example.com");
    expect(proof.commitment.response_body_hash).toMatch(/^sha256:/);
  });

  test("generateProof proof_data contains serialized commitment", async () => {
    const proof = await generateProof(mockRequest, "example.com");
    const decoded = JSON.parse(Buffer.from(proof.proof_data, "base64").toString());
    expect(decoded.response_body_hash).toBe(proof.commitment.response_body_hash);
  });
});
