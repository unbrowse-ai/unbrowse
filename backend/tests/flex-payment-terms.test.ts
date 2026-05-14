import { describe, test, expect } from "bun:test";
import { buildFlexPaymentTerms } from "../src/services/flex-payment-terms.js";

describe("buildFlexPaymentTerms — Day 4", () => {
  const fakeEnv = {
    FLEX_PLATFORM_RECIPIENT_USDC_ATA: "PlatformATAxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
    FLEX_REFUND_TIMEOUT_SLOTS: "150",
  } as any;
  const skill = {
    skill_id: "skill_test",
    contributors: [
      { agent_id: "a1", wallet_address: "W1xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx", cumulative_delta: 1 } as any,
    ],
  };

  test("emits scheme @faremeter/flex with one accepts entry", async () => {
    const terms = await buildFlexPaymentTerms(fakeEnv, {
      skill,
      priceUsd: 0.01,
      agentEscrow: "EscrowYxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
      resource: "https://test/skill_test",
      currentSlot: 100_000n,
    });
    expect(terms.x402Version).toBe(2);
    expect(terms.accepts.length).toBe(1);
    expect(terms.accepts[0].scheme).toBe("@faremeter/flex");
  });

  test("splits in extra sum to 10000 bps with platform always present", async () => {
    const terms = await buildFlexPaymentTerms(fakeEnv, {
      skill,
      priceUsd: 0.05,
      agentEscrow: "EscrowYxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
      resource: "https://test/skill_test",
      currentSlot: 100_000n,
    });
    const sum = terms.accepts[0].extra.splits.reduce((s, e) => s + e.bps, 0);
    expect(sum).toBe(10000);
    expect(terms.accepts[0].extra.splits[0].recipient).toBe("PlatformATAxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx");
    expect(terms.accepts[0].extra.splits[0].bps).toBe(1000);
  });

  test("maxAmount converts USD to µ¢ correctly (0.01 USD → 10000 µ¢)", async () => {
    const terms = await buildFlexPaymentTerms(fakeEnv, {
      skill,
      priceUsd: 0.01,
      agentEscrow: "EscrowYxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
      resource: "https://test/x",
      currentSlot: 100_000n,
    });
    expect(terms.accepts[0].amount).toBe("10000");
    expect(terms.accepts[0].extra.flexAuthorizationDraft.maxAmount).toBe("10000");
  });

  test("authorizationId is a non-empty decimal string", async () => {
    const terms = await buildFlexPaymentTerms(fakeEnv, {
      skill,
      priceUsd: 0.01,
      agentEscrow: "EscrowYxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
      resource: "https://test/x",
      currentSlot: 100_000n,
    });
    expect(terms.accepts[0].extra.flexAuthorizationDraft.authorizationId).toMatch(/^\d+$/);
  });

  test("expiresAtSlot = currentSlot + refundTimeout (150 default)", async () => {
    const terms = await buildFlexPaymentTerms(fakeEnv, {
      skill,
      priceUsd: 0.01,
      agentEscrow: "EscrowYxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
      resource: "https://test/x",
      currentSlot: 100_000n,
    });
    expect(terms.accepts[0].extra.flexAuthorizationDraft.expiresAtSlot).toBe("100150");
  });
});
