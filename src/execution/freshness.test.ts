import { equal } from "node:assert/strict";
import { describe, it } from "node:test";
import type { EndpointDescriptor } from "../types/index.js";
import {
  SKILL_FRESHNESS_TTL_MS,
  isEndpointFreshnessFailureStatus,
  markEndpointFreshnessStale,
  markEndpointFreshnessValid,
  shouldValidateEndpointFreshness,
  validateEndpointUrlFreshness,
  type EndpointFreshnessFetch,
} from "./freshness.js";

function endpoint(overrides: Partial<EndpointDescriptor> = {}): EndpointDescriptor {
  return {
    endpoint_id: "endpoint-1",
    method: "GET",
    url_template: "https://example.com/api/items",
    idempotency: "safe",
    verification_status: "verified",
    reliability_score: 0.9,
    ...overrides,
  };
}

describe("skill freshness checks", () => {
  it("skips a recently validated endpoint", () => {
    const nowMs = Date.parse("2026-05-04T12:00:00.000Z");
    const ep = endpoint({
      last_validated_at: new Date(nowMs - SKILL_FRESHNESS_TTL_MS + 1_000).toISOString(),
    });

    equal(shouldValidateEndpointFreshness(ep, undefined, nowMs), false);
  });

  it("updates last_validated_at when a stale endpoint returns 200", async () => {
    const nowIso = "2026-05-04T12:00:00.000Z";
    const ep = endpoint({
      verification_status: "pending",
      last_validated_at: "2026-04-01T12:00:00.000Z",
    });
    const fetchOk: EndpointFreshnessFetch = async () => ({ status: 200 });

    const result = await validateEndpointUrlFreshness(ep.url_template, ep, undefined, fetchOk);
    equal(result.outcome, "valid");
    markEndpointFreshnessValid(ep, nowIso);

    equal(ep.last_validated_at, nowIso);
    equal(ep.verification_status, "verified");
  });

  it("marks a stale endpoint failed when freshness validation returns 404", async () => {
    const ep = endpoint({ last_validated_at: "2026-04-01T12:00:00.000Z" });
    const fetchNotFound: EndpointFreshnessFetch = async () => ({ status: 404 });

    const result = await validateEndpointUrlFreshness(ep.url_template, ep, undefined, fetchNotFound);
    equal(result.outcome, "stale");
    equal(isEndpointFreshnessFailureStatus(404), true);
    markEndpointFreshnessStale(ep);

    equal(ep.verification_status, "failed");
  });

  it("proceeds without changing the endpoint on network errors", async () => {
    const ep = endpoint({
      verification_status: "verified",
      last_validated_at: "2026-04-01T12:00:00.000Z",
    });
    const failingFetch: EndpointFreshnessFetch = async () => {
      throw new Error("network unavailable");
    };

    const result = await validateEndpointUrlFreshness(ep.url_template, ep, undefined, failingFetch);
    equal(result.outcome, "unknown");
    equal(ep.verification_status, "verified");
    equal(ep.last_validated_at, "2026-04-01T12:00:00.000Z");
  });
});
