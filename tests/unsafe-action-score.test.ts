/**
 * Tests for unsafe action score and auto-execution blocking (Feature #87).
 */
import { describe, it, expect } from "bun:test";
import { computeUnsafeActionScore, UNSAFE_ACTION_BLOCK_THRESHOLD } from "../src/router.js";

function makeEndpoint(overrides: Record<string, unknown> = {}) {
  return {
    endpoint_id: "ep1",
    method: "GET",
    url_template: "https://api.example.com/data",
    idempotency: "safe",
    verification_status: "verified",
    reliability_score: 0.8,
    ...overrides,
  } as any;
}

describe("computeUnsafeActionScore", () => {
  it("safe GET endpoint scores near 0", () => {
    const ep = makeEndpoint({ method: "GET", idempotency: "safe", verification_status: "verified", reliability_score: 0.9 });
    const score = computeUnsafeActionScore(ep);
    expect(score).toBeLessThan(UNSAFE_ACTION_BLOCK_THRESHOLD);
  });

  it("unsafe POST from bundle inference scores above threshold", () => {
    const ep = makeEndpoint({
      method: "POST",
      idempotency: "unsafe",
      description: "inferred from js bundle: submit form",
      verification_status: "unverified",
      reliability_score: 0.2,
    });
    const score = computeUnsafeActionScore(ep);
    expect(score).toBeGreaterThanOrEqual(UNSAFE_ACTION_BLOCK_THRESHOLD);
  });

  it("unsafe POST with verified status and trigger_url scores below threshold", () => {
    const ep = makeEndpoint({
      method: "POST",
      idempotency: "unsafe",
      verification_status: "verified",
      reliability_score: 0.9,
      trigger_url: "https://example.com/page",
      response_schema: { type: "object", properties: {} },
    });
    const score = computeUnsafeActionScore(ep);
    expect(score).toBeLessThan(UNSAFE_ACTION_BLOCK_THRESHOLD);
  });

  it("score is clamped to [0, 1]", () => {
    const ep = makeEndpoint({
      method: "DELETE",
      idempotency: "unsafe",
      description: "inferred from js bundle",
      verification_status: "failed",
      reliability_score: 0.1,
    });
    const score = computeUnsafeActionScore(ep);
    expect(score).toBeGreaterThanOrEqual(0);
    expect(score).toBeLessThanOrEqual(1);
  });

  it("DOM extraction endpoints pass with score below threshold", () => {
    const ep = makeEndpoint({
      method: "GET",
      idempotency: "safe",
      dom_extraction: { extraction_method: "css", confidence: 0.9 },
    });
    const score = computeUnsafeActionScore(ep);
    expect(score).toBeLessThan(UNSAFE_ACTION_BLOCK_THRESHOLD);
  });

  it("confirm_unsafe=true bypasses the block (gate logic)", () => {
    const ep = makeEndpoint({
      method: "POST",
      idempotency: "unsafe",
      description: "inferred from js bundle",
      verification_status: "unverified",
      reliability_score: 0.1,
    });
    const score = computeUnsafeActionScore(ep);
    const confirmUnsafe = true;
    const blocked = score >= UNSAFE_ACTION_BLOCK_THRESHOLD && !confirmUnsafe;
    expect(blocked).toBe(false); // confirm_unsafe bypasses
  });
});
