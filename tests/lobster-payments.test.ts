import { beforeEach, describe, expect, it } from "bun:test";
import {
  checkPaymentRequirement,
  interpretPaymentResult,
  resolveUnpaidAccess,
  X402_CONFIG,
  type PaymentRequirement,
} from "../src/payments/index.js";
import { checkWalletConfigured } from "../src/payments/wallet.js";

const PAID_ROUTE = { price_usd: "0.001" } as const;

beforeEach(() => {
  delete process.env.LOBSTER_WALLET_ADDRESS;
  delete process.env.AGENT_WALLET_ADDRESS;
  delete process.env.AGENT_WALLET_PROVIDER;
  delete process.env.UNBROWSE_SKIP_PAYMENT;
  delete process.env.UNBROWSE_FREE_TIER;
  // Block reading the developer's actual ~/.lobster/config.json so the
  // "not configured when no env" assertion is reproducible across machines.
  process.env.UNBROWSE_DISABLE_LOCAL_WALLET = "1";
  // Account-or-x402 gate: keep this payments unit file deterministically
  // anonymous (no leaked dev api key / config) so wallet_not_configured is
  // the correct status for the no-credential path, reproducible across machines.
  delete process.env.UNBROWSE_API_KEY;
  process.env.UNBROWSE_CONFIG_DIR = "/tmp/ubpg-lobster-no-cfg";
});

describe("checkWalletConfigured", () => {
  it("not configured when no env", () => {
    expect(checkWalletConfigured()).toEqual({ configured: false });
  });

  it("detects lobster.cash", () => {
    process.env.LOBSTER_WALLET_ADDRESS = "So1...test";
    const result = checkWalletConfigured();
    expect(result.configured).toBe(true);
    expect(result.provider).toBe("lobster.cash");
  });

  it("detects generic wallet", () => {
    process.env.AGENT_WALLET_ADDRESS = "0xtest";
    process.env.AGENT_WALLET_PROVIDER = "other";
    expect(checkWalletConfigured().provider).toBe("other");
  });
});

describe("checkPaymentRequirement", () => {
  it("free when skip_payment", async () => {
    expect((await checkPaymentRequirement("s1", "e1", { skip_payment: true })).status).toBe("free");
  });

  it("free when env skip", async () => {
    process.env.UNBROWSE_SKIP_PAYMENT = "1";
    expect((await checkPaymentRequirement("s1", "e1")).status).toBe("free");
  });

  it("free for local: skills", async () => {
    expect((await checkPaymentRequirement("local:x", "e1")).status).toBe("free");
  });

  it("free when FREE_TIER", async () => {
    process.env.UNBROWSE_FREE_TIER = "1";
    expect((await checkPaymentRequirement("s1", "e1")).status).toBe("free");
  });

  it("free when price 0", async () => {
    expect((await checkPaymentRequirement("s1", "e1", { price_usd: "0" })).status).toBe("free");
  });

  it("payment_required for marketplace", async () => {
    const result = await checkPaymentRequirement("skill-123", "ep-1", PAID_ROUTE);
    expect(result.status).toBe("payment_required");
    expect(result.requirement?.currency).toBe("USDC");
    expect(result.requirement?.amount).toBe("0.001");
  });

  it("wallet_not_configured when false", async () => {
    const result = await checkPaymentRequirement("s1", "e1", {
      ...PAID_ROUTE,
      wallet_configured: false,
    });
    expect(result.status).toBe("wallet_not_configured");
    expect(JSON.stringify(result)).toContain("@crossmint/lobster-cli");
  });

  it("uses price override", async () => {
    expect((await checkPaymentRequirement("s1", "e1", { price_usd: "0.05" })).requirement?.amount).toBe("0.05");
  });

  it("uses the configured facilitator recipient", async () => {
    const result = await checkPaymentRequirement("s1", "e1", PAID_ROUTE);
    expect(result.requirement?.recipient).toBe(X402_CONFIG.facilitator);
  });

  it("includes memo", async () => {
    expect((await checkPaymentRequirement("abc", "xyz", PAID_ROUTE)).requirement?.memo).toBe("unbrowse:abc:xyz");
  });
});

describe("interpretPaymentResult", () => {
  const requirement: PaymentRequirement = {
    required: true,
    amount: "0.001",
    currency: "USDC",
    reason: "test",
  };

  it("confirmed -> paid", () => {
    expect(interpretPaymentResult("confirmed", requirement).status).toBe("paid");
  });

  it("success -> paid", () => {
    expect(interpretPaymentResult("success", requirement).status).toBe("paid");
  });

  it("pending -> awaiting", () => {
    expect(interpretPaymentResult("pending", requirement).status).toBe("awaiting_confirmation");
  });

  it("insufficient -> insufficient", () => {
    const result = interpretPaymentResult("insufficient_balance", requirement);
    expect(result.status).toBe("insufficient_balance");
    expect(result.message).toContain("0.001");
  });

  it("no_wallet -> wallet_not_configured", () => {
    expect(interpretPaymentResult("wallet_not_configured", requirement).status).toBe("wallet_not_configured");
  });

  it("unknown -> failed", () => {
    expect(interpretPaymentResult("tx_reverted", requirement).status).toBe("payment_failed");
  });
});

describe("X402 config", () => {
  it("keeps supported chains and facilitator wiring", () => {
    // Pins the shipped default facilitator (PayAI, per user steering). The
    // expected side is a concrete literal from the intended contract, NOT a
    // mirror of the production `??` expression (no tautology). Env-override
    // behavior is a separate concern verified elsewhere.
    expect(X402_CONFIG.facilitator).toBe("https://facilitator.payai.network");
    expect(X402_CONFIG.supports_pda_wallets).toBe(true);
    expect(X402_CONFIG.chains.solana.network).toBe("solana");
    expect(X402_CONFIG.chains.solana.currency).toBe("USDC");
    expect(X402_CONFIG.chains.base.network).toBe("base");
    expect(X402_CONFIG.chains.base.currency).toBe("USDC");
  });
});

describe("delegation boundary", () => {
  it("no wallet creation exports", async () => {
    const module = await import("../src/payments/wallet.js");
    expect("createWallet" in module).toBe(false);
    expect("generateKeypair" in module).toBe(false);
  });

  it("no tx signing exports", async () => {
    const module = await import("../src/payments/index.js");
    expect("signTransaction" in module).toBe(false);
  });

  it("no hardcoded action names", async () => {
    const result = await checkPaymentRequirement("s1", "e1", PAID_ROUTE);
    expect(result.message).not.toContain("lobster_tx_create");
    expect(result.message).not.toContain("lobster_send");
  });

  it("capability-level wording", async () => {
    const result = await checkPaymentRequirement("s1", "e1", PAID_ROUTE);
    expect(result.message).toContain("wallet provider");
  });
});

describe("indexing fallback", () => {
  const requirement: PaymentRequirement = {
    required: true,
    amount: "0.001",
    currency: "USDC",
    reason: "test",
  };

  it("wallet_not_configured falls back to indexing", () => {
    const gate = interpretPaymentResult("wallet_not_configured", requirement);
    const resolved = resolveUnpaidAccess(gate);
    expect(resolved.status).toBe("indexing_fallback");
    expect(resolved.message).toContain("No wallet");
    expect(resolved.next_step).toContain("lobster.cash");
  });

  it("insufficient_balance falls back to indexing", () => {
    const gate = interpretPaymentResult("insufficient_balance", requirement);
    const resolved = resolveUnpaidAccess(gate);
    expect(resolved.status).toBe("indexing_fallback");
  });

  it("payment_failed falls back to indexing", () => {
    const gate = interpretPaymentResult("tx_reverted", requirement);
    const resolved = resolveUnpaidAccess(gate);
    expect(resolved.status).toBe("indexing_fallback");
  });

  it("paid does NOT fall back", () => {
    const gate = interpretPaymentResult("confirmed", requirement);
    const resolved = resolveUnpaidAccess(gate);
    expect(resolved.status).toBe("paid");
  });

  it("awaiting_confirmation does NOT fall back", () => {
    const gate = interpretPaymentResult("pending", requirement);
    const resolved = resolveUnpaidAccess(gate);
    expect(resolved.status).toBe("awaiting_confirmation");
  });

  it("free does NOT fall back", async () => {
    const gate = await checkPaymentRequirement("local:x", "e1");
    const resolved = resolveUnpaidAccess(gate);
    expect(resolved.status).toBe("free");
  });
});
