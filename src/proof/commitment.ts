import { createHash } from "crypto";
import type { ProofCommitment, ProofVerificationResult } from "../types/proof.js";

/**
 * SHA-256 hash a response body string. Returns "sha256:<hex>".
 * Empty/undefined bodies hash as empty string.
 */
export function hashResponseBody(body: string | undefined): string {
  const hash = createHash("sha256")
    .update(body ?? "")
    .digest("hex");
  return `sha256:${hash}`;
}

/**
 * Create a proof commitment from a captured raw request.
 * The commitment binds the proof to specific capture evidence
 * without including any sensitive data (auth headers, cookies, PII).
 */
export function createCommitment(
  request: { url: string; method: string; response_status: number; response_body?: string; timestamp: string },
  domain: string,
): ProofCommitment {
  return {
    response_body_hash: hashResponseBody(request.response_body),
    domain,
    url_template: request.url,
    method: request.method,
    response_status: request.response_status,
    captured_at: request.timestamp,
  };
}

/**
 * Verify that a commitment's response body hash matches a given response body.
 * This is the local verification step — it doesn't verify the TLS proof itself,
 * just that the commitment hasn't been tampered with.
 */
export function verifyCommitmentAgainstResponse(
  commitment: ProofCommitment,
  responseBody: string,
): ProofVerificationResult {
  const actualHash = hashResponseBody(responseBody);
  const hashMatch = actualHash === commitment.response_body_hash;

  return {
    valid: hashMatch,
    proof_type: "commitment_only",
    verified_at: new Date().toISOString(),
    domain_match: true,
    response_hash_match: hashMatch,
    failure_reason: hashMatch ? undefined : "response body hash mismatch",
  };
}
