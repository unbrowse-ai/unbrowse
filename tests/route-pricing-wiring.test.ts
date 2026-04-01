/**
 * Tests for issue #231: route pricing endpoint wired into payment flow.
 *
 * Verifies that:
 * 1. fetchRoutePrice is exported from the client module
 * 2. resolveRoutePrice is exported from the payments module
 * 3. resolveRoutePrice returns "0.001" for local: skills (no network needed)
 * 4. resolveRoutePrice returns "0.001" as fallback when in local-only mode
 * 5. checkPaymentRequirement uses the price returned by resolveRoutePrice
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { checkPaymentRequirement, resolveRoutePrice } from "../src/payments/index.js";
import { fetchRoutePrice } from "../src/client/index.js";

describe("issue #231: route pricing wired into payment flow", () => {
  const origEnv = { ...process.env };

  beforeEach(() => {
    delete process.env.UNBROWSE_SKIP_PAYMENT;
    delete process.env.UNBROWSE_FREE_TIER;
    delete process.env.UNBROWSE_LOCAL_ONLY;
  });

  afterEach(() => {
    process.env = { ...origEnv };
  });

  // --- fetchRoutePrice export ---

  test("fetchRoutePrice is exported from client module", () => {
    expect(typeof fetchRoutePrice).toBe("function");
  });

  test("fetchRoutePrice returns null for local: skills (no network needed)", async () => {
    const result = await fetchRoutePrice("local:my-skill");
    expect(result).toBeNull();
  });

  test("fetchRoutePrice returns null in local-only mode", async () => {
    process.env.UNBROWSE_LOCAL_ONLY = "1";
    const result = await fetchRoutePrice("marketplace:skill-1");
    expect(result).toBeNull();
  });

  // --- resolveRoutePrice export and fallback behavior ---

  test("resolveRoutePrice is exported from payments module", () => {
    expect(typeof resolveRoutePrice).toBe("function");
  });

  test("resolveRoutePrice returns default for local: skills", async () => {
    const price = await resolveRoutePrice("local:my-skill");
    expect(price).toBe("0.001");
  });

  test("resolveRoutePrice returns default fallback in local-only mode", async () => {
    process.env.UNBROWSE_LOCAL_ONLY = "1";
    const price = await resolveRoutePrice("marketplace:skill-1");
    expect(price).toBe("0.001");
  });

  test("resolveRoutePrice always returns a string", async () => {
    const price = await resolveRoutePrice("any-skill");
    expect(typeof price).toBe("string");
    expect(parseFloat(price)).toBeGreaterThan(0);
  });

  // --- checkPaymentRequirement uses dynamic price ---

  test("checkPaymentRequirement uses price from resolveRoutePrice (explicit price_usd)", async () => {
    // Simulate what the orchestrator does after getting dynamic price
    const dynamicPrice = "0.005";
    const gate = checkPaymentRequirement("marketplace:skill-1", "ep-1", {
      price_usd: dynamicPrice,
    });
    expect(gate.status).toBe("payment_required");
    expect(gate.requirement!.amount).toBe("0.005");
  });

  test("full wiring: resolveRoutePrice then checkPaymentRequirement — local skill is free", async () => {
    const priceUsd = await resolveRoutePrice("local:my-tool");
    const gate = checkPaymentRequirement("local:my-tool", "ep-1", {
      price_usd: priceUsd,
    });
    // local: skills are always free regardless of price
    expect(gate.status).toBe("free");
  });

  test("full wiring: resolveRoutePrice then checkPaymentRequirement — marketplace skill requires payment", async () => {
    process.env.UNBROWSE_LOCAL_ONLY = "1"; // ensure no real network call
    const priceUsd = await resolveRoutePrice("marketplace:some-skill");
    // Should fall back to default
    expect(priceUsd).toBe("0.001");

    const gate = checkPaymentRequirement("marketplace:some-skill", "search-ep", {
      price_usd: priceUsd,
    });
    expect(gate.status).toBe("payment_required");
    expect(gate.requirement!.amount).toBe("0.001");
    expect(gate.requirement!.currency).toBe("USDC");
    expect(gate.requirement!.memo).toBe("unbrowse:marketplace:some-skill:search-ep");
  });

  test("dynamic price flows into payment requirement amount", async () => {
    // When backend returns a non-default price, it must flow into the gate
    const customPrice = "0.0073";
    const gate = checkPaymentRequirement("skill-x", "ep-y", {
      price_usd: customPrice,
    });
    expect(gate.requirement!.amount).toBe("0.0073");
    expect(gate.requirement!.amount).not.toBe("0.001");
  });

  test("price of 0 from resolveRoutePrice results in free gate", () => {
    // If the backend says price_usd=0, the skill should be free
    const gate = checkPaymentRequirement("skill-x", "ep-y", {
      price_usd: "0",
    });
    expect(gate.status).toBe("free");
  });
});
