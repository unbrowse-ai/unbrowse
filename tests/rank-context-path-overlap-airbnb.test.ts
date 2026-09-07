/**
 * Local rankEndpoints — regression coverage for the A1.2 contextUrl path-
 * segment overlap signal against the airbnb fixture from
 * unbrowse-ai/unbrowse#48.
 *
 * Companion to backend PR #537 (`fix(ranker): contextUrl path-prefix
 * preference signal`). The local fallback ranker already implements an
 * equivalent (stronger) signal at src/execution/index.ts:6079-6100 (set-
 * based segment overlap, +200 per matched segment). This file proves the
 * airbnb fixture from #48 stays green on the local path so future
 * refactors don't silently regress.
 *
 * No new production code — just falsifier-shape regression test.
 */
import { describe, expect, test } from "bun:test";
import { rankEndpoints } from "../src/client/rank-server-first";
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
    response_schema: { type: "array", properties: { trips: {} } },
    ...over,
  } as EndpointDescriptor;
}

describe("A1.2 — local rankEndpoints contextUrl path-segment overlap (#48 airbnb fixture)", () => {
  test("airbnb /users/profile/past-trips contextUrl picks the path-matching endpoint", () => {
    const tripsPast = ep({
      endpoint_id: "trips-past",
      url_template: "https://www.airbnb.com/trips/past",
      description: "List past trips for the current user.",
    });
    const profilePastTrips = ep({
      endpoint_id: "users-profile-past-trips",
      url_template: "https://www.airbnb.com/users/profile/past-trips",
      description: "Past trips on the user profile view.",
    });
    const ranked = rankEndpoints(
      [tripsPast, profilePastTrips],
      "get my past airbnb trips",
      "airbnb.com",
      "https://www.airbnb.com/users/profile/past-trips",
    );
    expect(ranked[0].endpoint.endpoint_id).toBe("users-profile-past-trips");
  });

  test("no contextUrl: both candidates ranked without path-prefix preference (no regression)", () => {
    const tripsPast = ep({
      endpoint_id: "trips-past",
      url_template: "https://www.airbnb.com/trips/past",
      description: "List past trips for the current user.",
    });
    const profilePastTrips = ep({
      endpoint_id: "users-profile-past-trips",
      url_template: "https://www.airbnb.com/users/profile/past-trips",
      description: "Past trips on the user profile view.",
    });
    const ranked = rankEndpoints(
      [tripsPast, profilePastTrips],
      "get my past airbnb trips",
      "airbnb.com",
    );
    // Both should appear; no assertion on order without contextUrl context.
    expect(ranked.length).toBe(2);
  });

  test("generic, not per-domain — same shape on example.org", () => {
    const wrongPath = ep({
      endpoint_id: "wrong-path",
      url_template: "https://example.org/api/other",
      description: "Other endpoint.",
      response_schema: { type: "object" } as never,
    });
    const rightPath = ep({
      endpoint_id: "right-path",
      url_template: "https://example.org/api/users/42/items",
      description: "Items for user 42.",
      response_schema: { type: "array" } as never,
    });
    const ranked = rankEndpoints(
      [wrongPath, rightPath],
      "get items",
      "example.org",
      "https://example.org/api/users/42/items",
    );
    expect(ranked[0].endpoint.endpoint_id).toBe("right-path");
  });
});
