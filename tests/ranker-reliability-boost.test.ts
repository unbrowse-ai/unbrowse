// Falsifier for commit 3 of the Darwinian-marketplace clean-up.
// Pre-fix reliability_score added at most +10 to the rank — drowned by
// other signals like BM25 (×150). Post-fix:
//   - <0.2  → -60 (auto-deprecation push)
//   - <0.5  → -15
//   - ≈0.5  → +8 (cold-start bonus so new endpoints get tried)
//   - ≥0.5  → reliability × 40 (max +40 for 1.0)
//
// This verifies the boost via direct call to rankEndpoints with three
// nearly-identical endpoints differing only in reliability_score, and
// asserts the ranking matches the documented bands.
import { describe, expect, it } from "bun:test";
import { rankEndpoints } from "../src/execution/index.ts";
import type { EndpointDescriptor } from "../src/types/index.ts";

function ep(reliability: number, suffix: string): EndpointDescriptor {
  return {
    endpoint_id: `ep-${suffix}`,
    method: "GET",
    url_template: `https://example.test/api/${suffix}`,
    idempotency: "safe",
    verification_status: "verified",
    reliability_score: reliability,
    response_schema: { type: "object", properties: { name: { type: "string" } } } as any,
  };
}

describe("rankEndpoints — reliability boost + cold-start (commit 3 of marketplace clean-up)", () => {
  it("higher reliability ranks above lower (when other signals equal)", () => {
    const endpoints = [ep(0.95, "high"), ep(0.7, "mid"), ep(0.5, "neutral")];
    const ranked = rankEndpoints(endpoints, "get example data");
    const ids = ranked.map((r) => r.endpoint.endpoint_id);
    // 0.95 should be at top; 0.7 next; 0.5 (cold-start +8) last
    expect(ids.indexOf("ep-high")).toBeLessThan(ids.indexOf("ep-mid"));
    expect(ids.indexOf("ep-mid")).toBeLessThan(ids.indexOf("ep-neutral"));
  });

  it("very-low reliability (auto-deprecation band) drops below cold-start", () => {
    const endpoints = [ep(0.5, "neutral"), ep(0.1, "deprecated")];
    const ranked = rankEndpoints(endpoints, "get data");
    const ids = ranked.map((r) => r.endpoint.endpoint_id);
    // Cold-start (+8) should beat <0.2 (-60)
    expect(ids.indexOf("ep-neutral")).toBeLessThan(ids.indexOf("ep-deprecated"));
  });

  it("score delta between 1.0 and 0.5 reliability is at least 30 points", () => {
    const endpoints = [ep(1.0, "perfect"), ep(0.5, "neutral")];
    const ranked = rankEndpoints(endpoints, "get data");
    const perfect = ranked.find((r) => r.endpoint.endpoint_id === "ep-perfect")!;
    const neutral = ranked.find((r) => r.endpoint.endpoint_id === "ep-neutral")!;
    expect(perfect.score - neutral.score).toBeGreaterThanOrEqual(30);
  });

  it("0.4 reliability (low-band) is penalized vs cold-start", () => {
    const endpoints = [ep(0.5, "neutral"), ep(0.4, "low")];
    const ranked = rankEndpoints(endpoints, "get data");
    const neutral = ranked.find((r) => r.endpoint.endpoint_id === "ep-neutral")!;
    const low = ranked.find((r) => r.endpoint.endpoint_id === "ep-low")!;
    // 0.5 cold-start gets +8; 0.4 gets -15. Delta should be ≥ 20.
    expect(neutral.score - low.score).toBeGreaterThanOrEqual(20);
  });

  it("cold-start bonus is small enough to not override BM25 from strong description", () => {
    // Strong-BM25 endpoint should still beat cold-start if its description
    // is significantly more relevant. We don't assert exact numbers — just
    // that cold-start is +8 and BM25 is in the 100+ range, so a clearly
    // relevant description wins over an irrelevant cold-start endpoint.
    const strong = ep(0.5, "strong"); // also cold-start, but description-strong
    strong.description = "search for the example data the user requested";
    const irrelevant = ep(0.5, "irrelevant");
    irrelevant.description = "OAuth callback handler for SSO bootstrapping";
    const ranked = rankEndpoints([strong, irrelevant], "search for example data");
    expect(ranked[0].endpoint.endpoint_id).toBe("ep-strong");
  });
});
