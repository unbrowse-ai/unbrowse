/**
 * backend/tests/rank-server.test.ts — WAVE 2 server-move.
 *
 * Exercises the server-side evidence-derived ranker (rankEndpointsServer)
 * directly, no mocks: real function, real EndpointDescriptor fixtures.
 * Asserts the load-bearing invariants the agent contract depends on:
 *   - intent-relevant endpoint ranks above an off-intent sibling
 *   - generic noise (trackers/telemetry) is dropped, not ranked
 *   - per-signal evidence is surfaced so the agent can judge ties
 *   - write verbs are demoted below read endpoints (Agent-UX A13)
 *   - empty / no-candidate input degrades safely (never throws)
 */

import { describe, test, expect } from "bun:test";
import { rankEndpointsServer } from "../src/services/rank.js";
import type { EndpointDescriptor } from "../src/types.js";

function ep(over: Partial<EndpointDescriptor> & { endpoint_id: string; url_template: string }): EndpointDescriptor {
  return {
    method: "GET",
    idempotency: "idempotent",
    verification_status: "unverified",
    reliability_score: 0.5,
    ...over,
  } as EndpointDescriptor;
}

describe("WAVE 2 server-side ranker", () => {
  test("intent-relevant endpoint ranks above an off-intent sibling", () => {
    const endpoints = [
      ep({
        endpoint_id: "search",
        url_template: "https://api.example.com/v2/search/products?q={q}",
        description: "Search the product catalog and return matching products with price and rating.",
        response_schema: { type: "array", properties: { products: {}, price: {}, rating: {} } } as never,
      }),
      ep({
        endpoint_id: "settings",
        url_template: "https://api.example.com/v2/account/preferences",
        description: "Read the current user's notification preferences and UI settings.",
        response_schema: { type: "object", properties: { theme: {}, locale: {} } } as never,
      }),
    ];
    const { ranked, degraded } = rankEndpointsServer({
      intent: "search products by keyword",
      endpoints,
    });
    expect(degraded).toBe(false);
    expect(ranked.length).toBeGreaterThan(0);
    expect(ranked[0].endpoint_id).toBe("search");
  });

  test("generic noise endpoints are filtered out, not ranked", () => {
    const endpoints = [
      ep({
        endpoint_id: "data",
        url_template: "https://api.example.com/v1/orders",
        description: "List the user's orders.",
        response_schema: { type: "array", properties: { orders: {} } } as never,
      }),
      ep({
        endpoint_id: "tracker",
        url_template: "https://www.google-analytics.com/collect?v=1",
        description: "analytics beacon",
      }),
      ep({
        endpoint_id: "pixel",
        url_template: "https://example.com/track/pixel?e=pageview",
        description: "tracking pixel",
      }),
    ];
    const { ranked } = rankEndpointsServer({ intent: "list my orders", endpoints });
    const ids = ranked.map((r) => r.endpoint_id);
    expect(ids).toContain("data");
    expect(ids).not.toContain("tracker");
    expect(ids).not.toContain("pixel");
  });

  test("surfaces per-signal evidence so the agent can judge ties", () => {
    const { ranked } = rankEndpointsServer({
      intent: "list repositories",
      endpoints: [
        ep({
          endpoint_id: "repos",
          url_template: "https://api.github.com/user/repos",
          description: "List repositories for the authenticated user.",
          response_schema: { type: "array", properties: { name: {}, owner: {} } } as never,
        }),
      ],
    });
    expect(ranked.length).toBe(1);
    const ev = ranked[0].evidence;
    expect(typeof ev.bm25).toBe("number");
    expect(typeof ev.url_path_overlap).toBe("number");
    expect(typeof ev.schema_richness).toBe("number");
    expect(typeof ev.host_pattern).toBe("number");
    expect(typeof ev.method_tiebreak).toBe("number");
    expect(typeof ev.response_shape).toBe("number");
    // api. host pattern must fire for api.github.com
    expect(ev.host_pattern).toBeGreaterThan(0);
    // array response shape bonus must fire
    expect(ev.response_shape).toBeGreaterThan(0);
  });

  test("write-verb endpoint is demoted below a read endpoint for the same data", () => {
    const endpoints = [
      ep({
        endpoint_id: "delete-item",
        method: "DELETE",
        url_template: "https://api.example.com/v1/items/{id}",
        description: "Delete an item from the catalog.",
      }),
      ep({
        endpoint_id: "get-items",
        method: "GET",
        url_template: "https://api.example.com/v1/items",
        description: "List items in the catalog.",
        response_schema: { type: "array", properties: { items: {} } } as never,
      }),
    ];
    const { ranked } = rankEndpointsServer({ intent: "get items from the catalog", endpoints });
    expect(ranked[0].endpoint_id).toBe("get-items");
    const del = ranked.find((r) => r.endpoint_id === "delete-item");
    const get = ranked.find((r) => r.endpoint_id === "get-items");
    expect(del && get && del.score < get.score).toBe(true);
  });

  test("empty / all-filtered input degrades safely without throwing", () => {
    expect(rankEndpointsServer({ endpoints: [] })).toEqual({ ranked: [], degraded: false });
    const onlyNoise = rankEndpointsServer({
      intent: "anything",
      endpoints: [
        ep({ endpoint_id: "n1", method: "OPTIONS", url_template: "https://x.com/a" }),
        ep({ endpoint_id: "n2", url_template: "https://www.googletagmanager.com/gtm.js" }),
      ],
    });
    // OPTIONS dropped; gtm host is noise. Falls back to non-disabled pool
    // (still surfaces *something* rather than an empty hard-fail).
    expect(onlyNoise.degraded).toBe(false);
    expect(Array.isArray(onlyNoise.ranked)).toBe(true);
  });
});
