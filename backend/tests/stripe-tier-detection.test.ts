import { describe, expect, it } from "bun:test";
import {
  inferTier,
  TIER_GRANTS,
  type StripeSubscriptionLike,
} from "../src/services/stripe-tier-detection.js";

// L3 partial (unbrowse-payments-faremeter wave 2). Pure-function tests
// pinning the tier inference; the wave-3 caller that actually grants
// credits depends on this being stable.

const ENV = {
  STRIPE_PRICE_PRO_MONTHLY: "price_pro_monthly_test",
  STRIPE_PRICE_METERED: "price_metered_test",
};

function sub(
  priceIds: string[],
  status: string = "active",
): StripeSubscriptionLike {
  return {
    status,
    items: {
      data: priceIds.map((id) => ({ price: { id } })),
    },
  };
}

describe("L3 inferTier — free", () => {
  it("null subscription -> free, 0 grant", () => {
    const r = inferTier(ENV, null);
    expect(r.tier).toBe("free");
    expect(r.grant_uc).toBe(0);
    expect(r.matched_price_id).toBeNull();
    expect(r.status).toBeNull();
  });

  it("undefined subscription -> free, 0 grant", () => {
    const r = inferTier(ENV, undefined);
    expect(r.tier).toBe("free");
    expect(r.grant_uc).toBe(0);
  });

  it("canceled status -> free regardless of price", () => {
    const r = inferTier(ENV, sub(["price_pro_monthly_test"], "canceled"));
    expect(r.tier).toBe("free");
    expect(r.grant_uc).toBe(0);
    expect(r.status).toBe("canceled");
  });

  it("incomplete_expired -> free", () => {
    const r = inferTier(ENV, sub(["price_pro_monthly_test"], "incomplete_expired"));
    expect(r.tier).toBe("free");
    expect(r.grant_uc).toBe(0);
  });

  it("subscription with unrecognized price -> free", () => {
    const r = inferTier(ENV, sub(["price_unknown"], "active"));
    expect(r.tier).toBe("free");
    expect(r.grant_uc).toBe(0);
  });

  it("env without any configured price IDs -> always free", () => {
    const r = inferTier({}, sub(["price_pro_monthly_test"], "active"));
    expect(r.tier).toBe("free");
    expect(r.grant_uc).toBe(0);
  });
});

describe("L3 inferTier — pro", () => {
  it("active Pro -> tier=pro, grant=PRO_TIER_GRANT_UC (200k uc)", () => {
    const r = inferTier(ENV, sub(["price_pro_monthly_test"], "active"));
    expect(r.tier).toBe("pro");
    expect(r.grant_uc).toBe(TIER_GRANTS.PRO_TIER_GRANT_UC);
    expect(r.grant_uc).toBe(200_000);
    expect(r.matched_price_id).toBe("price_pro_monthly_test");
    expect(r.status).toBe("active");
  });

  it("trialing Pro -> tier=pro, grant=200k uc (trial gets full grant)", () => {
    const r = inferTier(ENV, sub(["price_pro_monthly_test"], "trialing"));
    expect(r.tier).toBe("pro");
    expect(r.grant_uc).toBe(200_000);
  });

  it("past_due Pro -> tier=pro reported, grant=0 (caller decides claw-back)", () => {
    const r = inferTier(ENV, sub(["price_pro_monthly_test"], "past_due"));
    expect(r.tier).toBe("pro");
    expect(r.grant_uc).toBe(0);
    expect(r.matched_price_id).toBe("price_pro_monthly_test");
    expect(r.status).toBe("past_due");
  });

  it("paused Pro -> tier=pro, grant=0", () => {
    const r = inferTier(ENV, sub(["price_pro_monthly_test"], "paused"));
    expect(r.tier).toBe("pro");
    expect(r.grant_uc).toBe(0);
  });
});

describe("L3 inferTier — metered", () => {
  it("active Metered -> tier=metered, grant=0 (Meter API fires per-execute)", () => {
    const r = inferTier(ENV, sub(["price_metered_test"], "active"));
    expect(r.tier).toBe("metered");
    expect(r.grant_uc).toBe(0);
    expect(r.matched_price_id).toBe("price_metered_test");
  });

  it("Pro + Metered combo -> metered subsumes (no Pro flat grant)", () => {
    const r = inferTier(
      ENV,
      sub(["price_pro_monthly_test", "price_metered_test"], "active"),
    );
    expect(r.tier).toBe("metered");
    expect(r.grant_uc).toBe(0);
    expect(r.matched_price_id).toBe("price_metered_test");
  });

  it("Metered with whitespace in env still matches", () => {
    const r = inferTier(
      { STRIPE_PRICE_METERED: "  price_metered_test  " },
      sub(["price_metered_test"], "active"),
    );
    expect(r.tier).toBe("metered");
  });
});

describe("L3 inferTier — defensive parsing", () => {
  it("missing items field -> free", () => {
    const r = inferTier(ENV, { status: "active" });
    expect(r.tier).toBe("free");
  });

  it("empty items.data -> free", () => {
    const r = inferTier(ENV, { status: "active", items: { data: [] } });
    expect(r.tier).toBe("free");
  });

  it("item with null price -> ignored, free", () => {
    const r = inferTier(ENV, {
      status: "active",
      items: { data: [{ price: null }] },
    });
    expect(r.tier).toBe("free");
  });

  it("item with empty price id -> ignored, free", () => {
    const r = inferTier(ENV, {
      status: "active",
      items: { data: [{ price: { id: "" } }] },
    });
    expect(r.tier).toBe("free");
  });

  it("status null + Pro price -> grant=0 because not healthy", () => {
    const r = inferTier(ENV, {
      status: null,
      items: { data: [{ price: { id: "price_pro_monthly_test" } }] },
    });
    expect(r.tier).toBe("pro");
    expect(r.grant_uc).toBe(0);
  });
});
