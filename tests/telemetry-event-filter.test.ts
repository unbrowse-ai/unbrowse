import { describe, expect, test } from "bun:test";
import { selectMarketplacePublishEndpoints } from "../src/publish-admission";
import type { EndpointDescriptor, SkillManifest } from "../src/types/index.js";

// A9 fix — telemetry/event endpoints with `_` separator (log_event, track_event,
// page_view, etc.) weren't matching \blog\b because `_` is a word character
// in regex. Caught via harness/recursive/ on music.youtube.com:
// /youtubei/v1/log_event was outranking /youtubei/v1/search in the shortlist.

function makeEndpoint(url: string, id = "ep-1"): EndpointDescriptor {
  return {
    endpoint_id: id,
    method: "POST",
    url_template: url,
    description: "",
    idempotency: "safe",
    verification_status: "verified",
    reliability_score: 0.9,
    response_schema: { type: "object", properties: { ok: { type: "boolean" } } },
    semantic: { action_kind: "fetch", resource_kind: "data", requires: [] },
  } as EndpointDescriptor;
}

function makeSkill(domain: string, endpoints: EndpointDescriptor[]): SkillManifest {
  return {
    skill_id: "s-test",
    version: "1.0.0",
    schema_version: "1",
    name: "Test",
    intent_signature: "test",
    domain,
    description: "",
    owner_type: "marketplace",
    execution_type: "http",
    endpoints,
    lifecycle: "active",
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };
}

describe("A9 — telemetry-event endpoints filtered as noise", () => {
  test("youtube /v1/log_event rejected as noise", () => {
    const ep = makeEndpoint("https://music.youtube.com/youtubei/v1/log_event");
    const sel = selectMarketplacePublishEndpoints(makeSkill("youtube.com", [ep]));
    expect(sel.stats.by_reason.noise).toBe(1);
  });

  test("/track_event rejected as noise", () => {
    const ep = makeEndpoint("https://example.com/api/track_event");
    const sel = selectMarketplacePublishEndpoints(makeSkill("example.com", [ep]));
    expect(sel.stats.by_reason.noise).toBe(1);
  });

  test("/page_view rejected as noise", () => {
    const ep = makeEndpoint("https://example.com/api/page_view");
    const sel = selectMarketplacePublishEndpoints(makeSkill("example.com", [ep]));
    expect(sel.stats.by_reason.noise).toBe(1);
  });

  test("/click_events rejected as noise", () => {
    const ep = makeEndpoint("https://example.com/api/v1/click_events");
    const sel = selectMarketplacePublishEndpoints(makeSkill("example.com", [ep]));
    expect(sel.stats.by_reason.noise).toBe(1);
  });

  test("/v1/search NOT rejected (legit business endpoint)", () => {
    const ep = makeEndpoint("https://music.youtube.com/youtubei/v1/search");
    const sel = selectMarketplacePublishEndpoints(makeSkill("youtube.com", [ep]));
    expect(sel.stats.by_reason.noise).toBe(0);
  });

  test("/event/{id} (singular event resource, not telemetry batch) NOT rejected", () => {
    // Singular /event without `_` and without plural `events` is a legit resource
    // (event listings, calendar events, etc.) — must not be filtered.
    const ep = makeEndpoint("https://api.example.com/event/123");
    const sel = selectMarketplacePublishEndpoints(makeSkill("example.com", [ep]));
    expect(sel.stats.by_reason.noise).toBe(0);
  });
});
