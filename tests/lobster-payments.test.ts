import { describe, it, expect, beforeEach } from "bun:test";
import {
  checkPaymentRequirement,
  interpretPaymentResult,
  resolveUnpaidAccess,
  X402_CONFIG,
  type PaymentRequirement,
} from "../src/payments/index.js";
import { checkWalletConfigured } from "../src/payments/wallet.js";
import { checkWalletConfigured } from "../src/payments/wallet.js";

beforeEach(() => {
  delete process.env.LOBSTER_WALLET_ADDRESS;
  delete process.env.AGENT_WALLET_ADDRESS;
  delete process.env.AGENT_WALLET_PROVIDER;
  delete process.env.UNBROWSE_SKIP_PAYMENT;
  delete process.env.UNBROWSE_FREE_TIER;
});

describe("checkWalletConfigured", () => {
  it("not configured when no env", () => {
    expect(checkWalletConfigured()).toEqual({ configured: false });
  });
  it("detects lobster.cash", () => {
    process.env.LOBSTER_WALLET_ADDRESS = "So1...test";
    const r = checkWalletConfigured();
    expect(r.configured).toBe(true);
    expect(r.provider).toBe("lobster.cash");
  });
  it("detects generic wallet", () => {
    process.env.AGENT_WALLET_ADDRESS = "0xtest";
    process.env.AGENT_WALLET_PROVIDER = "other";
    expect(checkWalletConfigured().provider).toBe("other");
  });
});

describe("checkPaymentRequirement", () => {
  it("free when skip_payment", () => {
    expect(checkPaymentRequirement("s1", "e1", { skip_payment: true }).status).toBe("free");
  });
  it("free when env skip", () => {
    process.env.UNBROWSE_SKIP_PAYMENT = "1";
    expect(checkPaymentRequirement("s1", "e1").status).toBe("free");
  });
  it("free for local: skills", () => {
    expect(checkPaymentRequirement("local:x", "e1").status).toBe("free");
  });
  it("free when FREE_TIER", () => {
    process.env.UNBROWSE_FREE_TIER = "1";
    expect(checkPaymentRequirement("s1", "e1").status).toBe("free");
  });
  it("free when price 0", () => {
    expect(checkPaymentRequirement("s1", "e1", { price_usd: "0" }).status).toBe("free");
  });
  it("payment_required for marketplace", () => {
    const r = checkPaymentRequirement("skill-123", "ep-1");
    expect(r.status).toBe("payment_required");
    expect(r.requirement?.currency).toBe("USDC");
    expect(r.requirement?.amount).toBe("0.001");
  });
  it("wallet_not_configured when false", () => {
    const r = checkPaymentRequirement("s1", "e1", { wallet_configured: false });
    expect(r.status).toBe("wallet_not_configured");
    expect(r.message).toContain("lobster.cash");
  });
  it("uses price override", () => {
    expect(checkPaymentRequirement("s1", "e1", { price_usd: "0.05" }).requirement?.amount).toBe("0.05");
  });
  it("includes facilitator", () => {
    expect(checkPaymentRequirement("s1", "e1").requirement?.recipient).toBe("https://api.corbits.dev");
  });
  it("includes memo", () => {
    expect(checkPaymentRequirement("abc", "xyz").requirement?.memo).toBe("unbrowse:abc:xyz");
  });
});

describe("interpretPaymentResult", () => {
  const req: PaymentRequirement = { required: true, amount: "0.001", currency: "USDC", reason: "test" };
  it("confirmed -> paid", () => { expect(interpretPaymentResult("confirmed", req).status).toBe("paid"); });
  it("success -> paid", () => { expect(interpretPaymentResult("success", req).status).toBe("paid"); });
  it("pending -> awaiting", () => { expect(interpretPaymentResult("pending", req).status).toBe("awaiting_confirmation"); });
  it("insufficient -> insufficient", () => {
    const r = interpretPaymentResult("insufficient_balance", req);
    expect(r.status).toBe("insufficient_balance");
    expect(r.message).toContain("0.001");
  });
  it("no_wallet -> wallet_not_configured", () => {
    expect(interpretPaymentResult("wallet_not_configured", req).status).toBe("wallet_not_configured");
  });
  it("unknown -> failed", () => {
    expect(interpretPaymentResult("tx_reverted", req).status).toBe("payment_failed");
  });
});

describe("X402 config", () => {
  it("Solana + USDC + corbits.dev + PDA", () => {
    expect(X402_CONFIG.chain).toBe("solana");
    expect(X402_CONFIG.currency).toBe("USDC");
    expect(X402_CONFIG.facilitator).toBe("https://api.corbits.dev");
    expect(X402_CONFIG.supports_pda_wallets).toBe(true);
  });
});

describe("delegation boundary", () => {
  it("no wallet creation exports", async () => {
    const m = await import("../src/payments/wallet.js");
    expect("createWallet" in m).toBe(false);
    expect("generateKeypair" in m).toBe(false);
  });
  it("no tx signing exports", async () => {
    const m = await import("../src/payments/index.js");
    expect("signTransaction" in m).toBe(false);
  });
  it("no hardcoded action names", () => {
    const r = checkPaymentRequirement("s1", "e1");
    expect(r.message).not.toContain("lobster_tx_create");
    expect(r.message).not.toContain("lobster_send");
  });
  it("capability-level wording", () => {
    const r = checkPaymentRequirement("s1", "e1");
    expect(r.message).toContain("wallet provider");
  });
});

describe("indexing fallback", () => {
  const req: PaymentRequirement = { required: true, amount: "0.001", currency: "USDC", reason: "test" };

  it("wallet_not_configured falls back to indexing", () => {
    const gate = interpretPaymentResult("wallet_not_configured", req);
    const resolved = resolveUnpaidAccess(gate);
    expect(resolved.status).toBe("indexing_fallback");
    expect(resolved.message).toContain("Indexing mode");
    expect(resolved.next_step).toContain("--force-capture");
  });

  it("insufficient_balance falls back to indexing", () => {
    const gate = interpretPaymentResult("insufficient_balance", req);
    const resolved = resolveUnpaidAccess(gate);
    expect(resolved.status).toBe("indexing_fallback");
  });

  it("payment_failed falls back to indexing", () => {
    const gate = interpretPaymentResult("tx_reverted", req);
    const resolved = resolveUnpaidAccess(gate);
    expect(resolved.status).toBe("indexing_fallback");
  });

  it("paid does NOT fall back", () => {
    const gate = interpretPaymentResult("confirmed", req);
    const resolved = resolveUnpaidAccess(gate);
    expect(resolved.status).toBe("paid");
  });

  it("awaiting_confirmation does NOT fall back", () => {
    const gate = interpretPaymentResult("pending", req);
    const resolved = resolveUnpaidAccess(gate);
    expect(resolved.status).toBe("awaiting_confirmation");
  });

  it("free does NOT fall back", () => {
    const gate = checkPaymentRequirement("local:x", "e1");
    const resolved = resolveUnpaidAccess(gate);
    expect(resolved.status).toBe("free");
  });
});
