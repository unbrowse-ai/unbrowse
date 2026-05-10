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

describe("A10 — cross-subdomain skill leak demoted", () => {
  test("music.youtube.com endpoint demoted when contextUrl is www.youtube.com", () => {
    const wrong = ep({
      endpoint_id: "music",
      url_template: "https://music.youtube.com/youtubei/v1/search",
      description: "music search",
    });
    const right = ep({
      endpoint_id: "www",
      url_template: "https://www.youtube.com/results",
      description: "results page",
    });
    const ranked = rankEndpoints(
      [wrong, right],
      "youtube about MrBeast page",
      "youtube.com",
      "https://www.youtube.com/@MrBeast/about",
    );
    expect(ranked.length).toBeGreaterThan(0);
    expect(ranked[0].endpoint.endpoint_id).toBe("www");
    const wrongRank = ranked.find((r) => r.endpoint.endpoint_id === "music");
    if (wrongRank) {
      expect(wrongRank.score).toBeLessThan(ranked[0].score - 100);
    }
  });

  test("api.example.com (shared-API subdomain) is NOT demoted vs www context", () => {
    const apiEp = ep({
      endpoint_id: "api",
      url_template: "https://api.example.com/v1/things",
      description: "fetch things",
    });
    const wwwEp = ep({
      endpoint_id: "www",
      url_template: "https://www.example.com/things",
      description: "fetch things",
    });
    const ranked = rankEndpoints(
      [apiEp, wwwEp],
      "fetch things",
      "example.com",
      "https://www.example.com/things",
    );
    expect(ranked.length).toBe(2);
    const apiRank = ranked.find((r) => r.endpoint.endpoint_id === "api")!;
    const wwwRank = ranked.find((r) => r.endpoint.endpoint_id === "www")!;
    expect(apiRank.score).toBeGreaterThan(wwwRank.score - 100);
  });

  test("same-host endpoint is ranked", () => {
    const sameHost = ep({
      endpoint_id: "same",
      url_template: "https://www.youtube.com/results",
      description: "youtube results",
    });
    const ranked = rankEndpoints(
      [sameHost],
      "fetch youtube results",
      "youtube.com",
      "https://www.youtube.com/",
    );
    expect(ranked.length).toBeGreaterThan(0);
  });
});

describe("A1.1 — quadratic penalty when ≥3 leaked literals", () => {
  test("ebay ticketing/redeem (3 leaks) ranks below sch search", () => {
    const wrong = ep({
      endpoint_id: "ticketing",
      url_template: "https://www.ebay.com/nap/napkinapi/v1/ticketing/redeem",
      description: "redeem ticket",
      response_schema: {
        type: "object",
        properties: { ticket: { type: "object" }, status: { type: "string" } },
      },
    });
    const right = ep({
      endpoint_id: "search",
      url_template: "https://www.ebay.com/sch/i.html",
      description: "ebay search",
    });
    const ranked = rankEndpoints(
      [wrong, right],
      "ebay search listings",
      "ebay.com",
      "https://www.ebay.com/sch/i.html?_nkw=playstation",
    );
    expect(ranked.length).toBeGreaterThan(0);
    expect(ranked[0].endpoint.endpoint_id).toBe("search");
    const wrongRank = ranked.find((r) => r.endpoint.endpoint_id === "ticketing");
    if (wrongRank) {
      expect(wrongRank.score).toBeLessThan(ranked[0].score - 200);
    }
  });
});
