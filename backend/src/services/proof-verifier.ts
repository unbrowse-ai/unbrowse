import type { ZkProof, ProofSummary, ProofVerificationResult } from "../types.js";

const SUPPORTED_PROOF_TYPES = new Set(["commitment_only", "tlsnotary", "reclaim"]);

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function malformed(reason: string, proofType = "unknown"): ProofVerificationResult {
  return {
    valid: false,
    proof_type: proofType,
    verified_at: new Date().toISOString(),
    domain_match: false,
    response_hash_match: false,
    failure_reason: reason,
    failure_kind: "malformed_proof",
  };
}

export function verifyEndpointProof(proof: ZkProof, expectedDomain: string): ProofVerificationResult {
  const now = new Date().toISOString();
  if (!isObject(proof)) return malformed("proof must be an object");
  const commitment = proof.commitment;
  if (!SUPPORTED_PROOF_TYPES.has(proof.proof_type)) {
    return malformed(`unsupported proof_type: ${String(proof.proof_type)}`, String(proof.proof_type ?? "unknown"));
  }
  if (!isObject(commitment)) return malformed("proof.commitment must be an object", proof.proof_type);
  for (const field of ["response_body_hash", "domain", "url_template", "method", "captured_at"] as const) {
    if (typeof commitment[field] !== "string" || commitment[field].length === 0) {
      return malformed(`proof.commitment.${field} is required`, proof.proof_type);
    }
  }
  if (typeof commitment.response_status !== "number") {
    return malformed("proof.commitment.response_status must be a number", proof.proof_type);
  }
  if (typeof proof.proof_data !== "string" || proof.proof_data.length === 0) {
    return malformed("proof.proof_data is required", proof.proof_type);
  }
  if (typeof proof.generated_at !== "string" || proof.generated_at.length === 0) {
    return malformed("proof.generated_at is required", proof.proof_type);
  }

  if (proof.commitment.domain !== expectedDomain) {
    return {
      valid: false,
      proof_type: proof.proof_type,
      verified_at: now,
      domain_match: false,
      response_hash_match: true,
      failure_reason: `domain mismatch: proof says "${proof.commitment.domain}", skill says "${expectedDomain}"`,
      failure_kind: "domain_mismatch",
    };
  }

  if (!proof.commitment.response_body_hash.match(/^sha256:[a-f0-9]{64}$/)) {
    return {
      valid: false,
      proof_type: proof.proof_type,
      verified_at: now,
      domain_match: true,
      response_hash_match: false,
      failure_reason: "malformed hash: expected sha256:<64 hex chars>",
      failure_kind: "malformed_hash",
    };
  }

  const proofTime = new Date(proof.generated_at).getTime();
  if (!Number.isFinite(proofTime)) {
    return malformed("proof.generated_at must be a valid ISO timestamp", proof.proof_type);
  }
  if (proofTime > Date.now() + 5 * 60 * 1000) {
    return {
      valid: false,
      proof_type: proof.proof_type,
      verified_at: now,
      domain_match: true,
      response_hash_match: true,
      failure_reason: "proof timestamp is in the future",
      failure_kind: "future_timestamp",
    };
  }

  if (proof.proof_type === "commitment_only") {
    return {
      valid: false,
      proof_type: proof.proof_type,
      verified_at: now,
      domain_match: true,
      response_hash_match: true,
      failure_reason: "commitment_only proofs are client commitments, not independently verified provenance",
      failure_kind: "unverified_proof",
    };
  }

  // TLSNotary/Reclaim support is intentionally deferred. Until a real verifier
  // validates proof_data against a notary/verifier, these proofs stay unverified.
  return {
    valid: false,
    proof_type: proof.proof_type,
    verified_at: now,
    domain_match: true,
    response_hash_match: true,
    failure_reason: `${proof.proof_type} verification is not implemented in this branch`,
    failure_kind: "unverified_proof",
  };
}

export interface MalformedProofReport {
  endpoint_id?: string;
  reason: string;
  kind: "malformed_proof" | "malformed_hash" | "future_timestamp";
}

export interface VerifyInPlaceResult {
  verified: number;
  malformed: MalformedProofReport[];
}

/**
 * Verify every zk_proof on the given endpoints in place. Mutates each proof's
 * `verified` / `verified_at` / `verification_failure` fields. Endpoints without
 * a proof are untouched.
 *
 * Returns:
 *  - verified: count of independently verified proofs
 *  - malformed: structural failures the publisher cannot fix at runtime
 *    (malformed_proof, malformed_hash, future_timestamp). Domain mismatches
 *    and unsupported verifier paths are stamped on the proof and flow through
 *    publish with verified:false.
 */
export function verifyEndpointProofsInPlace(
  endpoints: Array<{ endpoint_id?: string; zk_proof?: ZkProof }>,
  expectedDomain: string,
): VerifyInPlaceResult {
  if (!expectedDomain) return { verified: 0, malformed: [] };
  let verifiedCount = 0;
  const malformed: MalformedProofReport[] = [];
  for (const ep of endpoints) {
    if (!ep.zk_proof) continue;
    const result = verifyEndpointProof(ep.zk_proof, expectedDomain);
    ep.zk_proof.verified = result.valid;
    ep.zk_proof.verified_at = result.verified_at;
    if (result.valid) {
      delete ep.zk_proof.verification_failure;
      verifiedCount++;
      continue;
    }
    ep.zk_proof.verification_failure = result.failure_reason;
    if (result.failure_kind === "malformed_proof" || result.failure_kind === "malformed_hash" || result.failure_kind === "future_timestamp") {
      malformed.push({
        endpoint_id: ep.endpoint_id,
        reason: result.failure_reason ?? "unknown",
        kind: result.failure_kind,
      });
    }
  }
  return { verified: verifiedCount, malformed };
}

export function summarizeSkillProofs(
  endpoints: Array<{ zk_proof?: ZkProof }>,
): ProofSummary {
  const proofTypes: Record<string, number> = {};
  let withProof = 0;
  let verified = 0;

  for (const ep of endpoints) {
    if (!ep.zk_proof) continue;
    withProof++;
    if (ep.zk_proof.verified && ep.zk_proof.proof_type !== "commitment_only") verified++;
    const type = ep.zk_proof.proof_type;
    proofTypes[type] = (proofTypes[type] ?? 0) + 1;
  }

  return {
    total_endpoints: endpoints.length,
    endpoints_with_proof: withProof,
    verified_proofs: verified,
    proof_types: proofTypes,
  };
}
