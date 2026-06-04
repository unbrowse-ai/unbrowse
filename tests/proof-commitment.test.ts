import { describe, expect, test } from "bun:test";
import {
  createCommitment,
  verifyCommitmentAgainstResponse,
  hashResponseBody,
} from "../src/proof/commitment.js";

describe("proof commitment", () => {
  const mockRequest = {
    url: "https://api.example.com/v1/items?page=1",
    method: "GET",
    request_headers: { "accept": "application/json" },
    response_status: 200,
    response_headers: { "content-type": "application/json" },
    response_body: JSON.stringify({ items: [{ id: 1, name: "Widget" }] }),
    timestamp: "2026-05-02T12:00:00Z",
  };

  test("hashResponseBody returns sha256 hex string", () => {
    const hash = hashResponseBody('{"items":[{"id":1}]}');
    expect(hash).toMatch(/^sha256:[a-f0-9]{64}$/);
  });

  test("hashResponseBody returns consistent hash for same input", () => {
    const body = '{"data":"test"}';
    expect(hashResponseBody(body)).toBe(hashResponseBody(body));
  });

  test("hashResponseBody returns different hash for different input", () => {
    expect(hashResponseBody("a")).not.toBe(hashResponseBody("b"));
  });

  test("createCommitment builds commitment from request data", () => {
    const commitment = createCommitment(mockRequest, "example.com");
    expect(commitment.response_body_hash).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(commitment.domain).toBe("example.com");
    expect(commitment.url_template).toBe("https://api.example.com/v1/items?page=1");
    expect(commitment.method).toBe("GET");
    expect(commitment.response_status).toBe(200);
    expect(commitment.captured_at).toBe("2026-05-02T12:00:00Z");
  });

  test("createCommitment handles missing response body gracefully", () => {
    const noBody = { ...mockRequest, response_body: undefined };
    const commitment = createCommitment(noBody, "example.com");
    expect(commitment.response_body_hash).toMatch(/^sha256:[a-f0-9]{64}$/);
  });

  test("verifyCommitmentAgainstResponse validates matching body hash", () => {
    const commitment = createCommitment(mockRequest, "example.com");
    const result = verifyCommitmentAgainstResponse(commitment, mockRequest.response_body!);
    expect(result.valid).toBe(true);
    expect(result.response_hash_match).toBe(true);
  });

  test("verifyCommitmentAgainstResponse rejects mismatched body hash", () => {
    const commitment = createCommitment(mockRequest, "example.com");
    const result = verifyCommitmentAgainstResponse(commitment, '{"tampered":true}');
    expect(result.valid).toBe(false);
    expect(result.response_hash_match).toBe(false);
    expect(result.failure_reason).toBe("response body hash mismatch");
  });
});
