/**
 * Three-plane secret seal — runnable witness for "nothing secret leaves".
 *
 *   REPO   — covered by leak-guard-gate (separate) + pre-commit
 *   INDEX  — sanitizeManifestForPublish strips headers_template / proven headers
 *   HEADERS/WIRE — assertWirePayloadClean refuses cookie/authorization values
 *
 * Uses site-specific synthetic credentials that lookLikeSecret does NOT match
 * by pattern alone — the allowlist + forbidden-header rule must hold.
 */
import { describe, expect, it } from "bun:test";
import {
  assertWirePayloadClean,
  findWireSecretHits,
  sanitizeForPublish,
  sanitizeManifestForPublish,
} from "../src/publish/sanitize.js";
import type { EndpointDescriptor, SkillManifest } from "../src/types/index.js";

const SESSION_NAME = "IndrX1dCQXZ4aW5XXzdnZ2luMVhqVkdwcXRRQ1lVUGFz";
const SESSION_VALUE = "9f3c1a7b2e4d6058ac91bd73";
const KNOWN = "sk-testonly000000000000000000";

function dirtyEndpoint(): EndpointDescriptor {
  return {
    endpoint_id: "ep-1",
    method: "GET",
    url_template: "https://api.site.test/v1/me",
    headers_template: {
      cookie: `${SESSION_NAME}=${SESSION_VALUE}`,
      authorization: `Bearer ${KNOWN}`,
      "x-wk-session": SESSION_VALUE,
      accept: "application/json",
    },
    proven_recipe: {
      method: "GET",
      url_template: "https://api.site.test/v1/me",
      headers: {
        cookie: `${SESSION_NAME}=${SESSION_VALUE}`,
        "x-wk-session": SESSION_VALUE,
        accept: "application/json",
      },
    },
    query: { q: "hello" },
    description: "profile",
    idempotency: "safe",
    verification_status: "verified",
    reliability_score: 0.9,
  } as EndpointDescriptor;
}

describe("secret-seal INDEX plane", () => {
  it("sanitizeForPublish drops headers_template and proven_recipe header values", () => {
    const [clean] = sanitizeForPublish([dirtyEndpoint()]);
    expect(clean).toBeDefined();
    const wire = JSON.stringify(clean);
    expect(wire).not.toContain(SESSION_VALUE);
    expect(wire).not.toContain(KNOWN);
    expect((clean as EndpointDescriptor).headers_template).toBeUndefined();
    expect((clean as EndpointDescriptor).proven_recipe?.headers).toEqual({});
  });

  it("sanitizeManifestForPublish cleans operation_graph prose and endpoints", () => {
    const manifest = {
      domain: "site.test",
      intent_signature: "me",
      endpoints: [dirtyEndpoint()],
      operation_graph: {
        operations: [
          {
            operation_id: "op1",
            method: "GET",
            url_template: "https://api.site.test/v1/me",
            description: `token ${KNOWN}`,
            example_request: { authorization: KNOWN },
          },
        ],
      },
    } as unknown as SkillManifest;
    const clean = sanitizeManifestForPublish(manifest);
    const wire = JSON.stringify(clean);
    expect(wire).not.toContain(KNOWN);
    expect(wire).not.toContain(SESSION_VALUE);
  });
});

describe("secret-seal HEADERS/WIRE plane", () => {
  it("findWireSecretHits flags ANY non-empty value under a headers map (not just cookie/auth names)", () => {
    const hits = findWireSecretHits({
      proven_recipe: {
        headers: {
          cookie: `${SESSION_NAME}=${SESSION_VALUE}`,
          "x-wk-session": SESSION_VALUE,
          accept: "application/json",
        },
      },
    });
    // Structural: whole map is toxic — site-specific headers included.
    expect(hits.some((h) => h.reason === "header_map_value")).toBe(true);
    expect(hits.some((h) => h.path.includes("x-wk-session"))).toBe(true);
    expect(hits.some((h) => h.path.includes("accept"))).toBe(true);
  });

  it("sanitize strips nested example_request.headers for index/graph wire", () => {
    const ep = dirtyEndpoint() as EndpointDescriptor & {
      semantic?: { example_request?: unknown };
    };
    ep.semantic = {
      example_request: {
        headers: { "x-wk-session": SESSION_VALUE, accept: "application/json" },
        body: { q: "hi" },
      },
    };
    const [clean] = sanitizeForPublish([ep]);
    const wire = JSON.stringify(clean);
    expect(wire).not.toContain(SESSION_VALUE);
    const headers = (clean as { semantic?: { example_request?: { headers?: Record<string, string> } } })
      .semantic?.example_request?.headers;
    expect(headers === undefined || Object.keys(headers).length === 0).toBe(true);
  });

  it("assertWirePayloadClean passes after sanitizeManifestForPublish", () => {
    const clean = sanitizeManifestForPublish({
      domain: "site.test",
      endpoints: [dirtyEndpoint()],
    });
    expect(() => assertWirePayloadClean(clean, "test")).not.toThrow();
  });

  it("assertWirePayloadClean refuses dirty capture (fail-closed)", () => {
    expect(() =>
      assertWirePayloadClean({ endpoints: [dirtyEndpoint()] }, "test"),
    ).toThrow(/secret-seal/);
  });

  it("assertWirePayloadClean refuses known-shape secrets in body fields", () => {
    expect(() =>
      assertWirePayloadClean({ body: { api_key: KNOWN } }, "test"),
    ).toThrow(/secret-seal/);
  });

  it("assertWirePayloadClean refuses residual headers map on graph-style skeleton", () => {
    expect(() =>
      assertWirePayloadClean(
        {
          endpoints: [
            {
              sample_request: {
                headers: { "x-site-token": SESSION_VALUE },
              },
            },
          ],
        },
        "graph.augment",
      ),
    ).toThrow(/header_map_value|secret-seal/);
  });
});
