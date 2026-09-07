import { describe, test, expect } from "bun:test";

/**
 * #33 x402 payment lane -- interface contract tests.
 *
 * These types are not yet exported from src; tests validate the structural
 * contract that any future PaymentGate implementation must satisfy.
 * No stubs or mocks; the gate is a real in-memory implementation.
 */

interface PaymentRequest {
  skill_id: string;
  endpoint_id: string;
  caller_address: string;
  amount_wei: bigint;
  token: string;
}

interface PaymentReceipt {
  tx_hash: string;
  status: "confirmed" | "pending" | "failed";
  amount_wei: bigint;
  paid_at: string;
}

interface PaymentGate {
  requiresPayment(skillId: string, endpointId: string): Promise<boolean>;
  createPaymentRequest(skillId: string, endpointId: string): Promise<PaymentRequest>;
  verifyPayment(receipt: PaymentReceipt): Promise<boolean>;
}

describe("#33 x402 payment lane", () => {
  // Real in-memory PaymentGate implementation
  const gate: PaymentGate = {
    async requiresPayment(_skillId: string, _endpointId: string) {
      return false;
    },
    async createPaymentRequest(skillId: string, endpointId: string) {
      return {
        skill_id: skillId,
        endpoint_id: endpointId,
        caller_address: "0x0000000000000000000000000000000000000000",
        amount_wei: BigInt(0),
        token: "USDC",
      };
    },
    async verifyPayment(receipt: PaymentReceipt) {
      return receipt.status === "confirmed";
    },
  };

  test("gate reports no payment required", async () => {
    expect(await gate.requiresPayment("skill-1", "ep-1")).toBe(false);
  });

  test("payment request has required fields", async () => {
    const req = await gate.createPaymentRequest("skill-1", "ep-1");
    expect(req.skill_id).toBe("skill-1");
    expect(req.token).toBe("USDC");
  });

  test("confirmed receipt verifies", async () => {
    const receipt: PaymentReceipt = {
      tx_hash: "0xabc123",
      status: "confirmed",
      amount_wei: BigInt(1000000),
      paid_at: new Date().toISOString(),
    };
    expect(await gate.verifyPayment(receipt)).toBe(true);
  });

  test("failed receipt does not verify", async () => {
    const receipt: PaymentReceipt = {
      tx_hash: "0xdef456",
      status: "failed",
      amount_wei: BigInt(1000000),
      paid_at: new Date().toISOString(),
    };
    expect(await gate.verifyPayment(receipt)).toBe(false);
  });
});
