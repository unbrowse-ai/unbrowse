export interface PaymentRequest {
  skill_id: string;
  endpoint_id: string;
  caller_address: string;
  amount_wei: bigint;
  token: string;
}

export interface PaymentReceipt {
  tx_hash: string;
  status: "confirmed" | "pending" | "failed";
  amount_wei: bigint;
  paid_at: string;
}

export interface PaymentGate {
  requiresPayment(skillId: string, endpointId: string): Promise<boolean>;
  createPaymentRequest(skillId: string, endpointId: string): Promise<PaymentRequest>;
  verifyPayment(receipt: PaymentReceipt): Promise<boolean>;
}

/**
 * Stub payment gate — always allows execution (no payment required).
 * Replace with Lobster/Corbits x402 integration when payment provider is available.
 */
export class StubPaymentGate implements PaymentGate {
  async requiresPayment(_skillId: string, _endpointId: string): Promise<boolean> {
    return false;
  }

  async createPaymentRequest(skillId: string, endpointId: string): Promise<PaymentRequest> {
    return {
      skill_id: skillId,
      endpoint_id: endpointId,
      caller_address: "0x0000000000000000000000000000000000000000",
      amount_wei: BigInt(0),
      token: "USDC",
    };
  }

  async verifyPayment(receipt: PaymentReceipt): Promise<boolean> {
    return receipt.status === "confirmed";
  }
}

/** Singleton payment gate instance */
export const paymentGate: PaymentGate = new StubPaymentGate();
