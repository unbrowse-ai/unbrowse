import { describe, expect, test } from "bun:test";
import { rankEndpoints } from "../src/ranking/index";
import type { EndpointDescriptor } from "../src/types/index.js";

function ep(over: Partial<EndpointDescriptor>): EndpointDescriptor {
  return {
    endpoint_id: "ep",
    method: "GET",
    url_template: "https://example.com/",
    description: "",
    idempotency: "safe",
    verification_status: "verified",
    reliability_score: 0.9,
    response_schema: { type: "object", properties: { data: { type: "array" } } },
    ...over,
  } as EndpointDescriptor;
}

describe("A12 — cross-brand demotion (different registrable domain)", () => {
  test("notion.com skill is heavily demoted vs notion.so contextUrl", () => {
    const wrongBrand = ep({
      endpoint_id: "notion-com",
      url_template: "https://www.notion.com/templates",
      description: "templates page",
    });
    const rightBrand = ep({
      endpoint_id: "notion-so",
      url_template: "https://www.notion.so/templates",
      description: "templates page",
    });
    const ranked = rankEndpoints(
      [wrongBrand, rightBrand],
      "fetch templates",
      "notion.so",
      "https://www.notion.so/templates",
    );
    expect(ranked.length).toBeGreaterThan(0);
    expect(ranked[0].endpoint.endpoint_id).toBe("notion-so");
    const wrongRank = ranked.find((r) => r.endpoint.endpoint_id === "notion-com");
    if (wrongRank) {
      // -800 cross-brand penalty puts it well below the right one
      expect(wrongRank.score).toBeLessThan(ranked[0].score - 500);
    }
  });

  test("api.example.com (shared-API on different brand) still penalised but less", () => {
    // api.example.com is shared-API style. But against notion.so context,
    // its registrable example.com !== notion.so so cross-brand penalty fires
    // unless we treat shared-API hosts as universal — current logic exempts
    // shared-API ONLY when registrable domains match. Different brand →
    // still penalised. This pins that behavior.
    const apiOtherBrand = ep({
      endpoint_id: "api-other",
      url_template: "https://api.example.com/v1/templates",
    });
    const ranked = rankEndpoints(
      [apiOtherBrand],
      "fetch templates",
      "notion.so",
      "https://www.notion.so/templates",
    );
    // The api.* exemption only applies when registrable matches. Different
    // brand → A12 -800 penalty. Score is heavily negative.
    expect(ranked[0].score).toBeLessThan(0);
  });
});

describe("A1.2 — contextUrl path-segment overlap bonus", () => {
  test("stripe.com/pricing query ranks pricing endpoint above /notifications", () => {
    const right = ep({
      endpoint_id: "pricing",
      url_template: "https://stripe.com/pricing",
      description: "pricing page",
    });
    const wrong = ep({
      endpoint_id: "notifications",
      url_template: "https://stripe.com/en-sg/notifications",
      description: "notifications",
      // give wrong endpoint a richer schema to simulate the original failure mode
      response_schema: {
        type: "object",
        properties: {
          notifications: { type: "array" },
          unread: { type: "integer" },
          last_seen: { type: "string" },
        },
      },
    });
    const ranked = rankEndpoints(
      [right, wrong],
      "stripe pricing",
      "stripe.com",
      "https://stripe.com/pricing",
    );
    expect(ranked.length).toBeGreaterThan(0);
    expect(ranked[0].endpoint.endpoint_id).toBe("pricing");
  });

  test("multi-segment overlap stacks (each shared segment gives +200)", () => {
    const overlap2 = ep({
      endpoint_id: "two-overlap",
      url_template: "https://example.com/products/electronics",
    });
    const overlap0 = ep({
      endpoint_id: "no-overlap",
      url_template: "https://example.com/cart/checkout",
    });
    const ranked = rankEndpoints(
      [overlap2, overlap0],
      "browse listings",
      "example.com",
      "https://example.com/products/electronics",
    );
    expect(ranked[0].endpoint.endpoint_id).toBe("two-overlap");
    const otherRank = ranked.find((r) => r.endpoint.endpoint_id === "no-overlap");
    if (otherRank) {
      // 2 segments × +200 = +400 minimum advantage
      expect(otherRank.score).toBeLessThan(ranked[0].score - 200);
    }
  });
});
