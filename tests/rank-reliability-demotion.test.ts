/**
 * Auto-deprecated endpoints (reliability_score < 0.2) must rank below comparable
 * endpoints with no reliability signal. Mid-reliability (0.2–0.5) gets a mild
 * demotion. Healthy endpoints keep their bonus. See backend/services/scoring.ts
 * for the matching DEPRECATION_THRESHOLD (consecutive_failures: 5, min_score: 0.2).
 */
import { describe, expect, it } from "bun:test";
import { rankEndpoints } from "../src/execution/index.js";
import type { EndpointDescriptor } from "../src/types/skill.js";

function ep(overrides: Partial<EndpointDescriptor>): EndpointDescriptor {
  return {
    endpoint_id: "e",
    method: "GET",
    url_template: "https://api.example.com/v1/items",
    description: "list items",
    idempotency: "safe",
    verification_status: "unverified",
    ...overrides,
  } as EndpointDescriptor;
}

describe("rankEndpoints — reliability demotion", () => {
  it("ranks an auto-deprecated low-reliability endpoint below an unmeasured peer", () => {
    const healthy = ep({ endpoint_id: "healthy", url_template: "https://api.example.com/v1/items" });
    const dead = ep({
      endpoint_id: "dead",
      url_template: "https://api.example.com/v1/items?stale=1",
      reliability_score: 0,
    });
    const ranked = rankEndpoints([dead, healthy], "list items", "example.com");
    expect(ranked[0].endpoint.endpoint_id).toBe("healthy");
    expect(ranked[1].endpoint.endpoint_id).toBe("dead");
    expect(ranked[0].score - ranked[1].score).toBeGreaterThanOrEqual(60);
  });

  it("ranks a healthy high-reliability endpoint above a flaky mid-reliability peer", () => {
    const good = ep({ endpoint_id: "good", reliability_score: 0.9 });
    const flaky = ep({
      endpoint_id: "flaky",
      url_template: "https://api.example.com/v1/items?b=1",
      reliability_score: 0.35,
    });
    const ranked = rankEndpoints([flaky, good], "list items", "example.com");
    expect(ranked[0].endpoint.endpoint_id).toBe("good");
  });

  it("treats undefined reliability_score as neutral, not negative", () => {
    const noSignal = ep({ endpoint_id: "no-signal" });
    const lowScore = ep({
      endpoint_id: "low",
      url_template: "https://api.example.com/v1/items?b=1",
      reliability_score: 0.1,
    });
    const ranked = rankEndpoints([lowScore, noSignal], "list items", "example.com");
    expect(ranked[0].endpoint.endpoint_id).toBe("no-signal");
  });

  it("penalizes verification_status === 'failed' relative to 'verified'", () => {
    const verified = ep({ endpoint_id: "verified", verification_status: "verified" });
    const failed = ep({
      endpoint_id: "failed",
      url_template: "https://api.example.com/v1/items?b=1",
      verification_status: "failed",
    });
    const ranked = rankEndpoints([failed, verified], "list items", "example.com");
    expect(ranked[0].endpoint.endpoint_id).toBe("verified");
    expect(ranked[0].score - ranked[1].score).toBeGreaterThanOrEqual(15);
  });
});
