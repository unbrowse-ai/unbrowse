import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import {
  checkPaymentRequirement,
  resolveUnpaidAccess,
  interpretPaymentResult,
} from "../src/payments/index.js";
import { checkWalletConfigured } from "../src/payments/wallet.js";
import type { PaymentGateResult } from "../src/payments/index.js";

// ---------------------------------------------------------------------------
// checkPaymentRequirement — real function tests
// ---------------------------------------------------------------------------

describe("checkPaymentRequirement", () => {
  const origEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...origEnv };
  });

  test("returns free for local: skills", () => {
    const result = checkPaymentRequirement("local:my-skill", "ep-1");
    expect(result.status).toBe("free");
  });

  test("returns free when UNBROWSE_SKIP_PAYMENT=1", () => {
    process.env.UNBROWSE_SKIP_PAYMENT = "1";
    const result = checkPaymentRequirement("marketplace:skill-1", "ep-1");
    expect(result.status).toBe("free");
  });

  test("returns free when UNBROWSE_FREE_TIER=1", () => {
    process.env.UNBROWSE_FREE_TIER = "1";
    const result = checkPaymentRequirement("marketplace:skill-1", "ep-1");
    expect(result.status).toBe("free");
  });

  test("returns free when skip_payment option is true", () => {
    const result = checkPaymentRequirement("marketplace:skill-1", "ep-1", {
      skip_payment: true,
    });
    expect(result.status).toBe("free");
  });

  test("returns free when price_usd is zero", () => {
    const result = checkPaymentRequirement("marketplace:skill-1", "ep-1", {
      price_usd: "0",
    });
    expect(result.status).toBe("free");
  });

  test("returns payment_required for marketplace skills with default price", () => {
    delete process.env.UNBROWSE_SKIP_PAYMENT;
    delete process.env.UNBROWSE_FREE_TIER;
    const result = checkPaymentRequirement("marketplace:skill-1", "ep-1");
    expect(result.status).toBe("payment_required");
    expect(result.requirement).toBeDefined();
    expect(result.requirement!.amount).toBe("0.001");
    expect(result.requirement!.currency).toBe("USDC");
  });

  test("returns wallet_not_configured when wallet_configured is false", () => {
    delete process.env.UNBROWSE_SKIP_PAYMENT;
    delete process.env.UNBROWSE_FREE_TIER;
    const result = checkPaymentRequirement("marketplace:skill-1", "ep-1", {
      wallet_configured: false,
    });
    expect(result.status).toBe("wallet_not_configured");
    expect(result.requirement).toBeDefined();
    expect(result.requirement!.required).toBe(true);
  });

  test("requirement includes correct memo format", () => {
    delete process.env.UNBROWSE_SKIP_PAYMENT;
    delete process.env.UNBROWSE_FREE_TIER;
    const result = checkPaymentRequirement("my-skill", "search-ep");
    expect(result.requirement!.memo).toBe("unbrowse:my-skill:search-ep");
  });
});

// ---------------------------------------------------------------------------
// checkWalletConfigured — real function tests
// ---------------------------------------------------------------------------

describe("checkWalletConfigured", () => {
  const origEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...origEnv };
  });

  test("returns configured=false when no wallet env vars set", () => {
    delete process.env.LOBSTER_WALLET_ADDRESS;
    delete process.env.AGENT_WALLET_ADDRESS;
    const result = checkWalletConfigured();
    expect(result.configured).toBe(false);
    expect(result.provider).toBeUndefined();
  });

  test("detects lobster.cash wallet", () => {
    process.env.LOBSTER_WALLET_ADDRESS = "So11111111111111111111111111111111111111112";
    const result = checkWalletConfigured();
    expect(result.configured).toBe(true);
    expect(result.provider).toBe("lobster.cash");
  });

  test("detects generic agent wallet", () => {
    delete process.env.LOBSTER_WALLET_ADDRESS;
    process.env.AGENT_WALLET_ADDRESS = "0xdeadbeef";
    process.env.AGENT_WALLET_PROVIDER = "custom-wallet";
    const result = checkWalletConfigured();
    expect(result.configured).toBe(true);
    expect(result.provider).toBe("custom-wallet");
  });

  test("lobster.cash takes priority over generic wallet", () => {
    process.env.LOBSTER_WALLET_ADDRESS = "lobster-addr";
    process.env.AGENT_WALLET_ADDRESS = "generic-addr";
    const result = checkWalletConfigured();
    expect(result.provider).toBe("lobster.cash");
  });
});

// ---------------------------------------------------------------------------
// resolveUnpaidAccess — real function tests
// ---------------------------------------------------------------------------

describe("resolveUnpaidAccess", () => {
  test("returns indexing_fallback for wallet_not_configured", () => {
    const gateResult: PaymentGateResult = {
      status: "wallet_not_configured",
      message: "No wallet",
      requirement: {
        required: true,
        amount: "0.001",
        currency: "USDC",
        reason: "test",
      },
    };
    const fallback = resolveUnpaidAccess(gateResult);
    expect(fallback.status).toBe("indexing_fallback");
    expect(fallback.message).toContain("Indexing mode");
  });

  test("returns indexing_fallback for insufficient_balance", () => {
    const gateResult: PaymentGateResult = {
      status: "insufficient_balance",
      message: "Not enough",
      requirement: {
        required: true,
        amount: "0.001",
        currency: "USDC",
        reason: "test",
      },
    };
    const fallback = resolveUnpaidAccess(gateResult);
    expect(fallback.status).toBe("indexing_fallback");
  });

  test("returns indexing_fallback for payment_failed", () => {
    const gateResult: PaymentGateResult = {
      status: "payment_failed",
      message: "Tx failed",
    };
    const fallback = resolveUnpaidAccess(gateResult);
    expect(fallback.status).toBe("indexing_fallback");
  });

  test("passes through free status unchanged", () => {
    const gateResult: PaymentGateResult = {
      status: "free",
      message: "No payment required.",
    };
    const result = resolveUnpaidAccess(gateResult);
    expect(result.status).toBe("free");
  });

  test("passes through paid status unchanged", () => {
    const gateResult: PaymentGateResult = {
      status: "paid",
      message: "Payment confirmed.",
    };
    const result = resolveUnpaidAccess(gateResult);
    expect(result.status).toBe("paid");
  });

  test("passes through payment_required unchanged", () => {
    const gateResult: PaymentGateResult = {
      status: "payment_required",
      message: "Payment needed",
    };
    const result = resolveUnpaidAccess(gateResult);
    expect(result.status).toBe("payment_required");
  });
});

// ---------------------------------------------------------------------------
// interpretPaymentResult — real function tests
// ---------------------------------------------------------------------------

describe("interpretPaymentResult", () => {
  const requirement = {
    required: true,
    amount: "0.001",
    currency: "USDC",
    reason: "test",
  };

  test("maps confirmed to paid", () => {
    const result = interpretPaymentResult("confirmed", requirement);
    expect(result.status).toBe("paid");
  });

  test("maps success to paid", () => {
    const result = interpretPaymentResult("success", requirement);
    expect(result.status).toBe("paid");
  });

  test("maps pending to awaiting_confirmation", () => {
    const result = interpretPaymentResult("pending", requirement);
    expect(result.status).toBe("awaiting_confirmation");
  });

  test("maps insufficient_balance correctly", () => {
    const result = interpretPaymentResult("insufficient_balance", requirement);
    expect(result.status).toBe("insufficient_balance");
  });

  test("maps no_wallet to wallet_not_configured", () => {
    const result = interpretPaymentResult("no_wallet", requirement);
    expect(result.status).toBe("wallet_not_configured");
  });

  test("maps unknown status to payment_failed", () => {
    const result = interpretPaymentResult("something_weird", requirement);
    expect(result.status).toBe("payment_failed");
    expect(result.message).toContain("something_weird");
  });
});

// ---------------------------------------------------------------------------
// Payment gate integration — wallet check + payment check + fallback
// ---------------------------------------------------------------------------

describe("payment gate integration", () => {
  const origEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...origEnv };
  });

  test("full flow: no wallet -> wallet_not_configured -> indexing_fallback", () => {
    delete process.env.LOBSTER_WALLET_ADDRESS;
    delete process.env.AGENT_WALLET_ADDRESS;
    delete process.env.UNBROWSE_SKIP_PAYMENT;
    delete process.env.UNBROWSE_FREE_TIER;

    const walletCheck = checkWalletConfigured();
    expect(walletCheck.configured).toBe(false);

    const paymentCheck = checkPaymentRequirement("marketplace:skill", "ep-1", {
      wallet_configured: walletCheck.configured,
    });
    expect(paymentCheck.status).toBe("wallet_not_configured");

    const fallback = resolveUnpaidAccess(paymentCheck);
    expect(fallback.status).toBe("indexing_fallback");
    expect(fallback.message).toContain("Indexing mode");
  });

  test("full flow: wallet configured -> payment_required (no block)", () => {
    process.env.LOBSTER_WALLET_ADDRESS = "test-wallet-addr";
    delete process.env.UNBROWSE_SKIP_PAYMENT;
    delete process.env.UNBROWSE_FREE_TIER;

    const walletCheck = checkWalletConfigured();
    expect(walletCheck.configured).toBe(true);

    const paymentCheck = checkPaymentRequirement("marketplace:skill", "ep-1", {
      wallet_configured: walletCheck.configured,
    });
    expect(paymentCheck.status).toBe("payment_required");
    // Payment does NOT block — the orchestrator continues
    expect(paymentCheck.requirement!.amount).toBe("0.001");
  });

  test("full flow: local skill is always free regardless of wallet", () => {
    delete process.env.LOBSTER_WALLET_ADDRESS;
    delete process.env.UNBROWSE_SKIP_PAYMENT;
    delete process.env.UNBROWSE_FREE_TIER;

    const paymentCheck = checkPaymentRequirement("local:my-tool", "ep-1");
    expect(paymentCheck.status).toBe("free");
  });

  test("UNBROWSE_SKIP_PAYMENT bypasses everything", () => {
    process.env.UNBROWSE_SKIP_PAYMENT = "1";
    const paymentCheck = checkPaymentRequirement("marketplace:expensive-skill", "ep-1");
    expect(paymentCheck.status).toBe("free");
  });

  test("UNBROWSE_FREE_TIER bypasses everything", () => {
    process.env.UNBROWSE_FREE_TIER = "1";
    const paymentCheck = checkPaymentRequirement("marketplace:expensive-skill", "ep-1");
    expect(paymentCheck.status).toBe("free");
  });
});

// ---------------------------------------------------------------------------
// OrchestratorResult payment field shape
// ---------------------------------------------------------------------------

describe("OrchestratorResult payment field", () => {
  test("payment field is typed correctly from PaymentGateResult", () => {
    // Verify the payment module exports are importable and well-typed
    const gate: PaymentGateResult = checkPaymentRequirement("test", "ep");
    expect(gate).toHaveProperty("status");
    expect(gate).toHaveProperty("message");
    // The status should be one of the valid PaymentStatus values
    const validStatuses = [
      "paid", "payment_required", "wallet_not_configured",
      "insufficient_balance", "payment_failed", "awaiting_confirmation",
      "indexing_fallback", "free",
    ];
    expect(validStatuses).toContain(gate.status);
  });
});
