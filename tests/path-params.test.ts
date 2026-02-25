import { describe, it, expect } from "bun:test";
import { extractEndpoints, type ExtractionContext } from "../src/reverse-engineer/index.js";
import type { RawRequest } from "../src/capture/index.js";

function makeReq(method: string, url: string, responseBody?: string): RawRequest {
  return {
    url,
    method,
    request_headers: { "accept": "application/json", "user-agent": "test" },
    response_headers: { "content-type": "application/json" },
    response_body: responseBody ?? JSON.stringify({ ok: true }),
    status: 200,
  } as RawRequest;
}

describe("path parameterization (BUG-006)", () => {
  it("parameterizes comma-separated path segments", () => {
    const reqs = [makeReq("GET", "https://api.example.com/api/v3/quote/SPY,QQQ,AAPL")];
    const endpoints = extractEndpoints(reqs);

    expect(endpoints.length).toBe(1);
    const ep = endpoints[0];

    // URL should have a template variable instead of hardcoded symbols
    expect(ep.url_template).not.toContain("SPY,QQQ,AAPL");
    expect(ep.url_template).toMatch(/\{[a-z_]+\}/);

    // path_params should store the original value as default
    expect(ep.path_params).toBeDefined();
    const paramValues = Object.values(ep.path_params!);
    expect(paramValues).toContain("SPY,QQQ,AAPL");
  });

  it("parameterizes segments matching page URL entities", () => {
    const reqs = [makeReq("GET", "https://api.example.com/price_charts/bitcoin/usd/24_hours.json")];
    const context: ExtractionContext = {
      pageUrl: "https://www.example.com/en/coins/bitcoin",
    };
    const endpoints = extractEndpoints(reqs, undefined, context);

    expect(endpoints.length).toBe(1);
    const ep = endpoints[0];

    // "bitcoin" matches a page URL segment, should be parameterized
    expect(ep.url_template).not.toContain("/bitcoin/");
    expect(ep.url_template).toMatch(/\{[a-z_]+\}/);

    // Default should be "bitcoin"
    expect(ep.path_params).toBeDefined();
    expect(Object.values(ep.path_params!)).toContain("bitcoin");
  });

  it("does not parameterize structural path segments", () => {
    const reqs = [makeReq("GET", "https://api.example.com/api/v3/search/results")];
    const endpoints = extractEndpoints(reqs);

    expect(endpoints.length).toBe(1);
    const ep = endpoints[0];

    // "api", "v3" are structural — should not be parameterized
    expect(ep.url_template).toContain("/api/v3/");
    // No path params expected (search and results are not comma-separated or entity hints)
    expect(ep.path_params).toBeUndefined();
  });

  it("deduplicates different comma-separated lists at the same path", () => {
    const reqs = [
      makeReq("GET", "https://api.example.com/quote/SPY,QQQ"),
      makeReq("GET", "https://api.example.com/quote/AAPL,MSFT"),
    ];
    const endpoints = extractEndpoints(reqs);

    // Both should collapse to the same template → only 1 endpoint
    expect(endpoints.length).toBe(1);
  });

  it("infers param name from preceding segment", () => {
    const reqs = [makeReq("GET", "https://api.example.com/coins/ETH,BTC")];
    const endpoints = extractEndpoints(reqs);

    expect(endpoints.length).toBe(1);
    const ep = endpoints[0];

    // Preceding segment is "coins" → param should be "coin" (singularized)
    expect(ep.url_template).toContain("{coin}");
    expect(ep.path_params?.coin).toBe("ETH,BTC");
  });

  it("preserves existing {id} parameterization and captures defaults", () => {
    // UUID in path — normalizeUrl already handles this
    const reqs = [makeReq("GET", "https://api.example.com/users/550e8400-e29b-41d4-a716-446655440000/profile")];
    const endpoints = extractEndpoints(reqs);

    expect(endpoints.length).toBe(1);
    const ep = endpoints[0];

    // UUID should be parameterized
    expect(ep.url_template).not.toContain("550e8400");
    expect(ep.url_template).toMatch(/\{[a-z_]+\}/);

    // path_params should capture the UUID as default
    expect(ep.path_params).toBeDefined();
    expect(Object.values(ep.path_params!)).toContain("550e8400-e29b-41d4-a716-446655440000");
  });

  it("parameterizes URN identifiers in path segments", () => {
    const reqs = [makeReq("GET", "https://www.linkedin.com/voyager/api/identity/dash/profiles/urn:li:fsd_profile:ACoAAB3fei4B1Wp3CkugPS9tSPGriFw7x8dvxvA?decorationId=com.linkedin.voyager.dash.deco.identity.profile.FullProfile-76")];
    const endpoints = extractEndpoints(reqs);

    expect(endpoints.length).toBe(1);
    const ep = endpoints[0];

    // URN should be parameterized, not hardcoded
    expect(ep.url_template).not.toContain("ACoAAB3fei4B1Wp3CkugPS9tSPGriFw7x8dvxvA");
    expect(ep.url_template).toMatch(/\{[a-z_]+\}/);

    // path_params should capture the URN as default
    expect(ep.path_params).toBeDefined();
    const paramValues = Object.values(ep.path_params!);
    expect(paramValues.some(v => v.includes("urn:li:fsd_profile:"))).toBe(true);
  });

  it("skips file-extension segments from context matching", () => {
    const reqs = [makeReq("GET", "https://api.example.com/data/report.json")];
    const context: ExtractionContext = {
      pageUrl: "https://www.example.com/reports/report.json",
    };
    const endpoints = extractEndpoints(reqs, undefined, context);

    expect(endpoints.length).toBe(1);
    const ep = endpoints[0];

    // "report.json" has a dot — should NOT be parameterized
    expect(ep.url_template).toContain("report.json");
  });
});
