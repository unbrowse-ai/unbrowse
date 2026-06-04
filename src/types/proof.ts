/**
 * Cryptographic commitment binding a proof to specific capture evidence.
 * The commitment is what gets verified — the proof_data is the ZK witness.
 */
export interface ProofCommitment {
  /** SHA-256 hash of the response body: "sha256:<hex>" */
  response_body_hash: string;
  /** Registrable domain the response came from */
  domain: string;
  /** URL template of the endpoint */
  url_template: string;
  /** HTTP method */
  method: string;
  /** HTTP response status code */
  response_status: number;
  /** ISO timestamp of when the request was captured */
  captured_at: string;
  /** Optional: SHA-256 hash of response schema structure (not values) */
  schema_hash?: string;
}

/**
 * Proof metadata attached to captured endpoint evidence.
 * `commitment_only` is a client-side commitment and is not independently
 * verified provenance. `verified:true` is reserved for future notary-backed
 * proof systems after server-side verification.
 */
export interface commitmentProof {
  /** Proof system used: "tlsnotary" | "reclaim" | "commitment_only" */
  proof_type: "tlsnotary" | "reclaim" | "commitment_only";
  /** Base64-encoded proof data (opaque to Unbrowse, verified by proof system) */
  proof_data: string;
  /** Commitment binding this proof to specific capture evidence */
  commitment: ProofCommitment;
  /** Identifier of the notary/verifier that co-signed the proof */
  notary_id: string;
  /** ISO timestamp of proof generation */
  generated_at: string;
  /** Whether this proof has been independently verified */
  verified: boolean;
  /** ISO timestamp of last verification */
  verified_at?: string;
  /** If verification failed, the reason */
  verification_failure?: string;
}

/**
 * Result of verifying a commitmentProof.
 */
export interface ProofVerificationResult {
  valid: boolean;
  proof_type: string;
  verified_at: string;
  /** Whether the domain in the proof matches the endpoint's domain */
  domain_match: boolean;
  /** Whether the response body hash in the proof matches a known capture */
  response_hash_match: boolean;
  /** If invalid, the reason */
  failure_reason?: string;
}
