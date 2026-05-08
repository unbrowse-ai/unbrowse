import { createCommitment } from "./commitment.js";
import type { ZkProof } from "../types/proof.js";

export interface NotaryClient {
  notaryUrl: string;
  generateTlsProof(params: {
    url: string;
    method: string;
    responseBody: string;
    responseStatus: number;
    domain: string;
    timestamp: string;
  }): Promise<ZkProof>;
  verifyTlsProof(proof: ZkProof): Promise<boolean>;
}

export function isNotaryAvailable(): boolean {
  return !!process.env.UNBROWSE_NOTARY_URL;
}

export function createNotaryClient(notaryUrl: string): NotaryClient {
  const notaryHost = new URL(notaryUrl).hostname;

  return {
    notaryUrl,

    async generateTlsProof(params) {
      const commitment = createCommitment(
        {
          url: params.url,
          method: params.method,
          response_status: params.responseStatus,
          response_body: params.responseBody,
          timestamp: params.timestamp,
        },
        params.domain,
      );

      // Stub: generates commitment-based proof labeled as tlsnotary.
      // Real implementation would use tlsn-js WASM to run MPC with notary server.
      const proofData = Buffer.from(JSON.stringify({
        ...commitment,
        notary_host: notaryHost,
        stub: true,
      })).toString("base64");

      return {
        proof_type: "tlsnotary",
        proof_data: proofData,
        commitment,
        notary_id: `tlsn-${notaryHost}`,
        generated_at: new Date().toISOString(),
        verified: false,
      };
    },

    async verifyTlsProof(proof: ZkProof): Promise<boolean> {
      if (!proof.commitment.response_body_hash.startsWith("sha256:")) return false;
      if (!proof.commitment.domain) return false;
      return true;
    },
  };
}
