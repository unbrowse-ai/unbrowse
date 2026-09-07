import { describe, it, expect } from "bun:test";
// @ts-ignore — looksLikeEntityId is not exported; we test it indirectly via minePathTemplates
import { minePathTemplates, extractEndpoints } from "../backend/src/services/reverse-engineer/index.js";
import type { RawRequest } from "../src/capture/index.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeReq(url: string): RawRequest {
  return {
    url,
    method: "GET",
    request_headers: { accept: "application/json", "user-agent": "test" },
    response_headers: { "content-type": "application/json" },
    response_body: JSON.stringify({ ok: true, data: { id: 1, name: "test" } }),
    status: 200,
  } as RawRequest;
}

// ---------------------------------------------------------------------------
// looksLikeEntityId — tested indirectly through minePathTemplates / extractEndpoints
// ---------------------------------------------------------------------------

describe("looksLikeEntityId", () => {
  it("recognises base64-encoded IDs (dXNlcjoxMjM=)", () => {
    // Use minePathTemplates with maxChildren=2: if the segment is treated as an
    // entity ID, the position is wildcarded and the path changes.
    const result = minePathTemplates(
      ["/api/token/dXNlcjoxMjM=", "/api/token/dXNlcjoxNDU="],
      2,
    );
    // Both paths should be templated — segments look like entity IDs
    expect(result.size).toBe(2);
    expect(result.get("/api/token/dXNlcjoxMjM=")).toBe("/api/token/{id}");
  });

  it("does not wildcard readable resource names like 'settings'", () => {
    // "settings", "profile", "account" are action/resource names, not entity IDs
    const result = minePathTemplates(
      ["/api/users/settings", "/api/users/profile"],
      2,
    );
    expect(result.size).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// minePathTemplates
// ---------------------------------------------------------------------------

describe("minePathTemplates", () => {
  it("templates a mid-path position that varies with numeric IDs", () => {
    const paths = ["/api/users/123/posts", "/api/users/456/posts"];
    const result = minePathTemplates(paths, 2);

    expect(result.size).toBe(2);
    expect(result.get("/api/users/123/posts")).toBe("/api/users/{id}/posts");
    expect(result.get("/api/users/456/posts")).toBe("/api/users/{id}/posts");
  });

  it("does NOT wildcard when distinct values < maxChildren (default 4)", () => {
    // Only 3 distinct IDs — below the default threshold of 4
    const paths = [
      "/api/items/1/detail",
      "/api/items/2/detail",
      "/api/items/3/detail",
    ];
    const result = minePathTemplates(paths); // maxChildren defaults to 4
    expect(result.size).toBe(0);
  });

  it("wildcards when distinct values >= maxChildren", () => {
    const paths = [
      "/api/items/1/detail",
      "/api/items/2/detail",
      "/api/items/3/detail",
      "/api/items/4/detail",
    ];
    const result = minePathTemplates(paths); // maxChildren=4, exactly meets threshold
    expect(result.size).toBe(4);
    for (const v of result.values()) {
      expect(v).toBe("/api/items/{id}/detail");
    }
  });

  it("does not wildcard positions where most segments look like resource names", () => {
    // positions filled with camelCase or lowercase word names — not entity IDs
    const paths = [
      "/api/users/settings",
      "/api/users/profile",
      "/api/users/notifications",
      "/api/users/preferences",
    ];
    const result = minePathTemplates(paths); // all look like resource names
    expect(result.size).toBe(0);
  });

  it("returns empty map for empty input", () => {
    expect(minePathTemplates([]).size).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Integration: extractEndpoints annotates _minedTemplate when no pageUrl
// ---------------------------------------------------------------------------

describe("extractEndpoints + minePathTemplates integration", () => {
  it("annotates _minedTemplate on endpoints from passive captures (no context)", () => {
    const reqs = [
      makeReq("https://api.example.com/v1/users/101/posts"),
      makeReq("https://api.example.com/v1/users/202/posts"),
      makeReq("https://api.example.com/v1/users/303/posts"),
      makeReq("https://api.example.com/v1/users/404/posts"),
    ];
    // No context → minePathTemplates should annotate _minedTemplate
    const endpoints = extractEndpoints(reqs);
    const templated = endpoints.filter((ep) => ep._minedTemplate);
    // At least one endpoint should carry the mined template
    expect(templated.length).toBeGreaterThan(0);
    for (const ep of templated) {
      expect(ep._minedTemplate).toBe("/v1/users/{id}/posts");
    }
  });

  it("does NOT annotate _minedTemplate when context pageUrl is provided", () => {
    const reqs = [
      makeReq("https://api.example.com/v1/users/101/posts"),
      makeReq("https://api.example.com/v1/users/202/posts"),
      makeReq("https://api.example.com/v1/users/303/posts"),
      makeReq("https://api.example.com/v1/users/404/posts"),
    ];
    const endpoints = extractEndpoints(reqs, undefined, {
      pageUrl: "https://example.com/dashboard",
    });
    const templated = endpoints.filter((ep) => ep._minedTemplate);
    expect(templated.length).toBe(0);
  });
});
