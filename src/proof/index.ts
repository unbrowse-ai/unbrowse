import { createCommitment, hashResponseBody } from "./commitment.js";
import type { ZkProof, ProofCommitment } from "../types/proof.js";
import { isNotaryAvailable, createNotaryClient } from "./notary.js";

export { createCommitment, hashResponseBody, verifyCommitmentAgainstResponse } from "./commitment.js";
export type { ZkProof, ProofCommitment, ProofVerificationResult } from "../types/proof.js";
export { isNotaryAvailable, createNotaryClient } from "./notary.js";
export type { NotaryClient } from "./notary.js";

/**
 * Check if ZK proof generation is enabled.
 * DEFAULT-ON (good default, no opt-in friction): every capture gets a proof.
 * The default proof type is `commitment_only` — a cheap local hash, no external
 * deps, no notary round-trip — so default-on adds negligible cost. The stronger
 * `tlsnotary` type stays gated on UNBROWSE_NOTARY_URL being set.
 * Opt OUT explicitly with UNBROWSE_ZK_PROOF=0 (or "false") for the rare
 * cost-sensitive path that genuinely wants no proof.
 */
export function isProofEnabled(): boolean {
  const v = process.env.UNBROWSE_ZK_PROOF?.trim().toLowerCase();
  return v !== "0" && v !== "false";
}

/**
 * Generate a ZK proof for a captured HTTP request.
 *
 * Currently supports:
 * - "commitment_only": local hash commitment (no TLS proof, fast, no external deps)
 * - "tlsnotary": full TLSNotary MPC proof (requires notary server) — added in Task 6
 *
 * Defaults to "commitment_only". Set UNBROWSE_ZK_PROOF_TYPE=tlsnotary to upgrade.
 */
export async function generateProof(
  request: { url: string; method: string; response_status: number; response_body?: string; timestamp: string },
  domain: string,
): Promise<ZkProof> {
  // Use TLSNotary if configured
  if (isNotaryAvailable()) {
    const client = createNotaryClient(process.env.UNBROWSE_NOTARY_URL!);
    return client.generateTlsProof({
      url: request.url,
      method: request.method,
      responseBody: request.response_body ?? "",
      responseStatus: request.response_status,
      domain,
      timestamp: request.timestamp,
    });
  }

  // Fallback: commitment_only mode
  const commitment = createCommitment(request, domain);
  const proofData = Buffer.from(JSON.stringify(commitment)).toString("base64");

  return {
    proof_type: "commitment_only",
    proof_data: proofData,
    commitment,
    notary_id: "local",
    generated_at: new Date().toISOString(),
    verified: false,
  };
}

/**
 * Generate proofs for a batch of captured requests.
 * Filters to only API-like requests (JSON responses, status 200-299).
 */
export async function generateProofsForCapture(
  requests: Array<{ url: string; method: string; response_status: number; response_body?: string; response_headers: Record<string, string>; timestamp: string }>,
  domain: string,
): Promise<Map<string, ZkProof>> {
  const proofs = new Map<string, ZkProof>();

  for (const req of requests) {
    const contentType = req.response_headers["content-type"] ?? "";
    if (!contentType.includes("json") && !contentType.includes("text/html")) continue;
    if (req.response_status < 200 || req.response_status >= 400) continue;

    const proof = await generateProof(req, domain);
    const key = `${req.method}:${req.url}`;
    proofs.set(key, proof);
  }

  return proofs;
}
