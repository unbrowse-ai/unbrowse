import { describe, expect, test } from "bun:test";
import { verifyEndpointProof, summarizeSkillProofs, verifyEndpointProofsInPlace } from "../src/services/proof-verifier.js";

describe("backend proof verifier", () => {
  test("verifyEndpointProof validates commitment_only proof structure", () => {
    const result = verifyEndpointProof({
      proof_type: "commitment_only",
      proof_data: Buffer.from(JSON.stringify({
        response_body_hash: "sha256:" + "a".repeat(64),
        domain: "example.com",
      })).toString("base64"),
      commitment: {
        response_body_hash: "sha256:" + "a".repeat(64),
        domain: "example.com",
        url_template: "https://example.com/api/items",
        method: "GET",
        response_status: 200,
        captured_at: "2026-05-02T12:00:00Z",
      },
      notary_id: "local",
      generated_at: "2026-05-02T12:00:00Z",
      verified: false,
    }, "example.com");

    expect(result.valid).toBe(false);
    expect(result.domain_match).toBe(true);
    expect(result.failure_kind).toBe("unverified_proof");
    expect(result.failure_reason).toContain("not independently verified");
  });

  test("verifyEndpointProof rejects domain mismatch", () => {
    const result = verifyEndpointProof({
      proof_type: "commitment_only",
      proof_data: "base64",
      commitment: {
        response_body_hash: "sha256:" + "a".repeat(64),
        domain: "evil.com",
        url_template: "https://evil.com/api/items",
        method: "GET",
        response_status: 200,
        captured_at: "2026-05-02T12:00:00Z",
      },
      notary_id: "local",
      generated_at: "2026-05-02T12:00:00Z",
      verified: false,
    }, "example.com");

    expect(result.valid).toBe(false);
    expect(result.domain_match).toBe(false);
    expect(result.failure_reason).toContain("domain mismatch");
  });

  test("verifyEndpointProof rejects malformed hash", () => {
    const result = verifyEndpointProof({
      proof_type: "commitment_only",
      proof_data: "base64",
      commitment: {
        response_body_hash: "not-a-hash",
        domain: "example.com",
        url_template: "https://example.com/api/items",
        method: "GET",
        response_status: 200,
        captured_at: "2026-05-02T12:00:00Z",
      },
      notary_id: "local",
      generated_at: "2026-05-02T12:00:00Z",
      verified: false,
    }, "example.com");

    expect(result.valid).toBe(false);
    expect(result.failure_reason).toContain("malformed hash");
  });

  test("summarizeSkillProofs counts proofs by type and verification status", () => {
    const endpoints = [
      { zk_proof: { proof_type: "commitment_only", verified: false } },
      { zk_proof: { proof_type: "tlsnotary", verified: true } },
      { zk_proof: undefined },
    ];

    const summary = summarizeSkillProofs(endpoints as any);
    expect(summary.total_endpoints).toBe(3);
    expect(summary.endpoints_with_proof).toBe(2);
    expect(summary.verified_proofs).toBe(1);
    expect(summary.proof_types.commitment_only).toBe(1);
    expect(summary.proof_types.tlsnotary).toBe(1);
  });

  test("verifyEndpointProofsInPlace keeps commitment_only proofs unverified", () => {
    const endpoints = [
      {
        endpoint_id: "ep1",
        zk_proof: {
          proof_type: "commitment_only" as const,
          proof_data: "x",
          commitment: {
            response_body_hash: "sha256:" + "b".repeat(64),
            domain: "example.com",
            url_template: "https://example.com/api/x",
            method: "GET",
            response_status: 200,
            captured_at: "2026-05-02T12:00:00Z",
          },
          notary_id: "local",
          generated_at: "2026-05-02T12:00:00Z",
          verified: false,
        },
      },
    ];

    const result = verifyEndpointProofsInPlace(endpoints, "example.com");

    expect(result.verified).toBe(0);
    expect(result.malformed).toEqual([]);
    expect(endpoints[0].zk_proof.verified).toBe(false);
    expect(endpoints[0].zk_proof.verified_at).toBeDefined();
    expect(endpoints[0].zk_proof.verification_failure).toContain("not independently verified");
  });

  test("verifyEndpointProofsInPlace stamps verified=false + reason on domain mismatch", () => {
    const endpoints = [
      {
        zk_proof: {
          proof_type: "commitment_only" as const,
          proof_data: "x",
          commitment: {
            response_body_hash: "sha256:" + "c".repeat(64),
            domain: "evil.com",
            url_template: "https://evil.com/api/x",
            method: "GET",
            response_status: 200,
            captured_at: "2026-05-02T12:00:00Z",
          },
          notary_id: "local",
          generated_at: "2026-05-02T12:00:00Z",
          verified: false,
        },
      },
    ];

    const result = verifyEndpointProofsInPlace(endpoints, "example.com");

    expect(result.verified).toBe(0);
    // Domain mismatch is soft-rejected, NOT classified as malformed
    expect(result.malformed).toEqual([]);
    expect(endpoints[0].zk_proof.verified).toBe(false);
    expect(endpoints[0].zk_proof.verification_failure).toContain("domain mismatch");
  });

  test("verifyEndpointProofsInPlace skips endpoints without proofs", () => {
    const endpoints = [
      { endpoint_id: "no-proof" },
      {
        endpoint_id: "with-proof",
        zk_proof: {
          proof_type: "commitment_only" as const,
          proof_data: "x",
          commitment: {
            response_body_hash: "sha256:" + "d".repeat(64),
            domain: "example.com",
            url_template: "https://example.com/api/x",
            method: "GET",
            response_status: 200,
            captured_at: "2026-05-02T12:00:00Z",
          },
          notary_id: "local",
          generated_at: "2026-05-02T12:00:00Z",
          verified: false,
        },
      },
    ];

    const result = verifyEndpointProofsInPlace(endpoints as any, "example.com");

    expect(result.verified).toBe(0);
    expect((endpoints[1] as any).zk_proof.verified).toBe(false);
    expect((endpoints[0] as any).zk_proof).toBeUndefined();
  });

  test("verifyEndpointProofsInPlace replaces stale verification_failure on re-verify", () => {
    const endpoints = [
      {
        zk_proof: {
          proof_type: "commitment_only" as const,
          proof_data: "x",
          commitment: {
            response_body_hash: "sha256:" + "e".repeat(64),
            domain: "example.com",
            url_template: "https://example.com/api/x",
            method: "GET",
            response_status: 200,
            captured_at: "2026-05-02T12:00:00Z",
          },
          notary_id: "local",
          generated_at: "2026-05-02T12:00:00Z",
          verified: false,
          verification_failure: "stale failure from earlier run",
        },
      },
    ];

    verifyEndpointProofsInPlace(endpoints, "example.com");

    expect(endpoints[0].zk_proof.verified).toBe(false);
    expect(endpoints[0].zk_proof.verification_failure).toContain("not independently verified");
  });

  test("verifyEndpointProofsInPlace returns 0 when expectedDomain is empty", () => {
    const endpoints = [
      {
        zk_proof: {
          proof_type: "commitment_only" as const,
          proof_data: "x",
          commitment: {
            response_body_hash: "sha256:" + "f".repeat(64),
            domain: "example.com",
            url_template: "https://example.com/api/x",
            method: "GET",
            response_status: 200,
            captured_at: "2026-05-02T12:00:00Z",
          },
          notary_id: "local",
          generated_at: "2026-05-02T12:00:00Z",
          verified: false,
        },
      },
    ];

    const result = verifyEndpointProofsInPlace(endpoints, "");

    expect(result.verified).toBe(0);
    expect(result.malformed).toEqual([]);
    expect(endpoints[0].zk_proof.verified).toBe(false);
  });

  test("verifyEndpointProofsInPlace flags malformed_hash in malformed[]", () => {
    const endpoints = [
      {
        endpoint_id: "ep-malformed",
        zk_proof: {
          proof_type: "commitment_only" as const,
          proof_data: "x",
          commitment: {
            response_body_hash: "not-a-real-hash",
            domain: "example.com",
            url_template: "https://example.com/api/x",
            method: "GET",
            response_status: 200,
            captured_at: "2026-05-02T12:00:00Z",
          },
          notary_id: "local",
          generated_at: "2026-05-02T12:00:00Z",
          verified: false,
        },
      },
    ];

    const result = verifyEndpointProofsInPlace(endpoints, "example.com");

    expect(result.verified).toBe(0);
    expect(result.malformed).toHaveLength(1);
    expect(result.malformed[0]).toMatchObject({
      endpoint_id: "ep-malformed",
      kind: "malformed_hash",
    });
    expect(result.malformed[0].reason).toContain("malformed hash");
    expect(endpoints[0].zk_proof.verified).toBe(false);
  });

  test("verifyEndpointProofsInPlace flags future_timestamp in malformed[]", () => {
    const farFuture = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
    const endpoints = [
      {
        endpoint_id: "ep-future",
        zk_proof: {
          proof_type: "commitment_only" as const,
          proof_data: "x",
          commitment: {
            response_body_hash: "sha256:" + "1".repeat(64),
            domain: "example.com",
            url_template: "https://example.com/api/x",
            method: "GET",
            response_status: 200,
            captured_at: farFuture,
          },
          notary_id: "local",
          generated_at: farFuture,
          verified: false,
        },
      },
    ];

    const result = verifyEndpointProofsInPlace(endpoints, "example.com");

    expect(result.verified).toBe(0);
    expect(result.malformed).toHaveLength(1);
    expect(result.malformed[0]).toMatchObject({
      endpoint_id: "ep-future",
      kind: "future_timestamp",
    });
    expect(endpoints[0].zk_proof.verified).toBe(false);
  });

  test("verifyEndpointProofsInPlace rejects malformed proof objects cleanly", () => {
    const endpoints = [
      {
        endpoint_id: "ep-empty-proof",
        zk_proof: {} as any,
      },
    ];

    const result = verifyEndpointProofsInPlace(endpoints, "example.com");

    expect(result.verified).toBe(0);
    expect(result.malformed).toHaveLength(1);
    expect(result.malformed[0]).toMatchObject({
      endpoint_id: "ep-empty-proof",
      kind: "malformed_proof",
    });
    expect(endpoints[0].zk_proof.verified).toBe(false);
  });
});
