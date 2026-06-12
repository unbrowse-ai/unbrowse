import { describe, expect, test } from "bun:test";
import type { CaptureResult } from "../src/capture/index.js";
import { generateProofsForCapture } from "../src/proof/index.js";
import type { commitmentProof } from "../src/types/proof.js";

describe("proof-capture integration", () => {
  const capturedRequests = [
    {
      url: "https://api.example.com/v1/items",
      method: "GET",
      request_headers: { "accept": "application/json" },
      response_status: 200,
      response_headers: { "content-type": "application/json" },
      response_body: JSON.stringify({ items: [{ id: 1 }] }),
      timestamp: "2026-05-02T12:00:00Z",
    },
    {
      url: "https://cdn.example.com/tracking.gif",
      method: "GET",
      request_headers: {},
      response_status: 200,
      response_headers: { "content-type": "image/gif" },
      response_body: undefined,
      timestamp: "2026-05-02T12:00:01Z",
    },
    {
      url: "https://api.example.com/v1/users/123",
      method: "GET",
      request_headers: {},
      response_status: 404,
      response_headers: { "content-type": "application/json" },
      response_body: '{"error":"not found"}',
      timestamp: "2026-05-02T12:00:02Z",
    },
  ];

  test("generateProofsForCapture only proves JSON 2xx responses", async () => {
    const proofs = await generateProofsForCapture(capturedRequests, "example.com");
    expect(proofs.size).toBe(1);
    expect(proofs.has("GET:https://api.example.com/v1/items")).toBe(true);
    expect(proofs.has("GET:https://cdn.example.com/tracking.gif")).toBe(false);
    expect(proofs.has("GET:https://api.example.com/v1/users/123")).toBe(false);
  });

  test("CaptureResult can hold proof map", () => {
    const result: CaptureResult = {
      requests: capturedRequests as any,
      har_lineage_id: "har-test",
      domain: "example.com",
      final_url: "https://example.com",
      zk_proofs: new Map([
        ["GET:https://api.example.com/v1/items", {
          proof_type: "commitment_only",
          proof_data: "base64",
          commitment: {
            response_body_hash: "sha256:abc",
            domain: "example.com",
            url_template: "https://api.example.com/v1/items",
            method: "GET",
            response_status: 200,
            captured_at: "2026-05-02T12:00:00Z",
          },
          notary_id: "local",
          generated_at: "2026-05-02T12:00:00Z",
          verified: false,
        }],
      ]),
    };
    expect(result.zk_proofs?.size).toBe(1);
  });
});
