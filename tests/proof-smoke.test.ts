import { describe, expect, test } from "bun:test";
import { generateProof, generateProofsForCapture, isProofEnabled } from "../src/proof/index.js";
import { verifyCommitmentAgainstResponse, hashResponseBody } from "../src/proof/commitment.js";
import { createNotaryClient, isNotaryAvailable } from "../src/proof/notary.js";

describe("ZK proof smoke test — full pipeline", () => {
  const apiResponse = JSON.stringify({
    data: { users: [{ id: 1, name: "Alice" }, { id: 2, name: "Bob" }] },
    meta: { total: 2, page: 1 },
  });

  const capturedRequest = {
    url: "https://api.example.com/v2/users?page=1",
    method: "GET",
    request_headers: {
      "authorization": "Bearer secret-token",
      "accept": "application/json",
    },
    response_status: 200,
    response_headers: { "content-type": "application/json; charset=utf-8" },
    response_body: apiResponse,
    timestamp: new Date().toISOString(),
  };

  test("1. generate proof from captured request", async () => {
    const proof = await generateProof(capturedRequest, "example.com");
    expect(proof.proof_type).toBe("commitment_only");
    expect(proof.commitment.domain).toBe("example.com");
    expect(proof.commitment.response_status).toBe(200);
    // Auth headers are NOT in the commitment
    expect(JSON.stringify(proof.commitment)).not.toContain("secret-token");
  });

  test("2. verify commitment matches original response", async () => {
    const proof = await generateProof(capturedRequest, "example.com");
    const result = verifyCommitmentAgainstResponse(proof.commitment, apiResponse);
    expect(result.valid).toBe(true);
  });

  test("3. commitment rejects tampered response", async () => {
    const proof = await generateProof(capturedRequest, "example.com");
    const tampered = JSON.stringify({ data: { users: [] }, meta: { total: 0 } });
    const result = verifyCommitmentAgainstResponse(proof.commitment, tampered);
    expect(result.valid).toBe(false);
  });

  test("4. batch proof generation filters correctly", async () => {
    const requests = [
      capturedRequest,
      { ...capturedRequest, url: "https://cdn.example.com/logo.png", response_headers: { "content-type": "image/png" } },
      { ...capturedRequest, url: "https://api.example.com/error", response_status: 500 },
    ];
    const proofs = await generateProofsForCapture(requests, "example.com");
    expect(proofs.size).toBe(1);
    expect(proofs.has("GET:https://api.example.com/v2/users?page=1")).toBe(true);
  });

  test("5. proof does not leak sensitive data", async () => {
    const proof = await generateProof(capturedRequest, "example.com");
    const serialized = JSON.stringify(proof);
    // No auth headers, no cookies, no request body
    expect(serialized).not.toContain("Bearer");
    expect(serialized).not.toContain("secret-token");
    expect(serialized).not.toContain("authorization");
    // Response body hash is present but not the body itself
    expect(serialized).toContain("sha256:");
    expect(serialized).not.toContain("Alice");
    expect(serialized).not.toContain("Bob");
  });
});
