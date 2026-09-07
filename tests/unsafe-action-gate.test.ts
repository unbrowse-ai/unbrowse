import { describe, test, expect } from "bun:test";
import { computeUnsafeActionScore, UNSAFE_ACTION_BLOCK_THRESHOLD } from "../src/router.js";

describe("#87 unsafe action score gate", () => {
  const base = {
    endpoint_id: "test",
    url_template: "https://example.com/api",
    params: [],
    description: "",
    response_schema: { type: "object" as const, properties: {} },
    reliability_score: 0.9,
    verification_status: "verified" as const,
    method: "GET",
    idempotency: "safe" as const,
  };

  test("safe GET endpoint scores low", () => {
    const score = computeUnsafeActionScore(base as any);
    expect(score).toBeLessThan(UNSAFE_ACTION_BLOCK_THRESHOLD);
  });

  test("unsafe DELETE endpoint scores high", () => {
    const score = computeUnsafeActionScore({
      ...base,
      method: "DELETE",
      idempotency: "unsafe",
      verification_status: "failed",
      reliability_score: 0.1,
      response_schema: undefined,
    } as any);
    expect(score).toBeGreaterThanOrEqual(UNSAFE_ACTION_BLOCK_THRESHOLD);
  });

  test("verified endpoint gets score reduction", () => {
    const post = { ...base, method: "POST", idempotency: "unsafe" };
    const unverified = computeUnsafeActionScore({ ...post, verification_status: "unknown" } as any);
    const verified = computeUnsafeActionScore({ ...post, verification_status: "verified" } as any);
    expect(verified).toBeLessThan(unverified);
  });

  test("threshold is 0.6", () => {
    expect(UNSAFE_ACTION_BLOCK_THRESHOLD).toBe(0.6);
  });
});
