import { describe, test, expect } from "bun:test";
import { buildFlexPaymentTerms } from "../src/services/flex-payment-terms.js";

const PLATFORM_USDC_ATA = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

describe("buildFlexPaymentTerms — Day 4", () => {
  const fakeEnv = {
    FLEX_PLATFORM_RECIPIENT_USDC_ATA: PLATFORM_USDC_ATA,
    FLEX_REFUND_TIMEOUT_SLOTS: "150",
  } as any;
  const skill = {
    skill_id: "skill_test",
    contributors: [
      { agent_id: "a1", wallet_address: "W1xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx", cumulative_delta: 1 } as any,
    ],
  };

  test("emits Flex plus PayAI exact accepts", async () => {
    const terms = await buildFlexPaymentTerms(fakeEnv, {
      skill,
      priceUsd: 0.01,
      agentEscrow: "EscrowYxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
      resource: "https://test/skill_test",
      currentSlot: 100_000n,
    });
    expect(terms.x402Version).toBe(2);
    expect(terms.accepts.map((entry) => entry.scheme).sort()).toEqual(["@faremeter/flex", "exact"]);
  });

  test("splits in extra sum to 10000 bps with platform always present", async () => {
    const terms = await buildFlexPaymentTerms(fakeEnv, {
      skill,
      priceUsd: 0.05,
      agentEscrow: "EscrowYxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
      resource: "https://test/skill_test",
      currentSlot: 100_000n,
    });
    const flex = terms.accepts.find((entry) => entry.scheme === "@faremeter/flex");
    expect(flex).toBeTruthy();
    if (!flex || flex.scheme !== "@faremeter/flex") throw new Error("missing Flex accept");
    const sum = flex.extra.splits.reduce((s, e) => s + e.bps, 0);
    expect(sum).toBe(10000);
    expect(flex.extra.splits[0].recipient).toBe(PLATFORM_USDC_ATA);
    expect(flex.extra.splits[0].bps).toBe(5000);
  });

  test("maxAmount converts USD to µ¢ correctly (0.01 USD → 10000 µ¢)", async () => {
    const terms = await buildFlexPaymentTerms(fakeEnv, {
      skill,
      priceUsd: 0.01,
      agentEscrow: "EscrowYxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
      resource: "https://test/x",
      currentSlot: 100_000n,
    });
    const flex = terms.accepts.find((entry) => entry.scheme === "@faremeter/flex");
    expect(flex).toBeTruthy();
    if (!flex || flex.scheme !== "@faremeter/flex") throw new Error("missing Flex accept");
    expect(flex.amount).toBe("10000");
    expect(flex.extra.flexAuthorizationDraft.maxAmount).toBe("10000");
  });

  test("authorizationId is a non-empty decimal string", async () => {
    const terms = await buildFlexPaymentTerms(fakeEnv, {
      skill,
      priceUsd: 0.01,
      agentEscrow: "EscrowYxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
      resource: "https://test/x",
      currentSlot: 100_000n,
    });
    const flex = terms.accepts.find((entry) => entry.scheme === "@faremeter/flex");
    expect(flex).toBeTruthy();
    if (!flex || flex.scheme !== "@faremeter/flex") throw new Error("missing Flex accept");
    expect(flex.extra.flexAuthorizationDraft.authorizationId).toMatch(/^\d+$/);
  });

  test("expiresAtSlot = currentSlot + refundTimeout (150 default)", async () => {
    const terms = await buildFlexPaymentTerms(fakeEnv, {
      skill,
      priceUsd: 0.01,
      agentEscrow: "EscrowYxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
      resource: "https://test/x",
      currentSlot: 100_000n,
    });
    const flex = terms.accepts.find((entry) => entry.scheme === "@faremeter/flex");
    expect(flex).toBeTruthy();
    if (!flex || flex.scheme !== "@faremeter/flex") throw new Error("missing Flex accept");
    expect(flex.extra.flexAuthorizationDraft.expiresAtSlot).toBe("100150");
  });
});
