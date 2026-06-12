// W1: when executeEndpoint detects BREAKING response-schema drift but the
// server returned a non-empty body with real data, the platform must NOT
// replace `data` with a schema_drift_recapture_required envelope. The body
// is what the agent will ultimately judge against the intent
// (GATE_JUDGE.md: "body is what matters; an empty array can return HTTP
// 200"); drift is surfaced as a side-channel signal via
// trace.error + trace.re_capture_signal + trace.drift so the agent has
// BOTH: the body it can read and the platform's "this drifted, may need
// re-capture" warning. Replacing the body hides the real response.
//
// Live regression source: .bench-gate/20260519T203955Z/verdict.json: many
// RETRIEVE_FAIL probes (047 youtube_subscriptions, 043 x.com home, 057
// southwest, 016 stackoverflow, 049 x.com home) carried real data in the
// response body but the platform served a 200-wrapped error envelope
// instead, causing the in-thread judge to mark them retrieval failures.
//
// Coherent with execution-drift-success-coherence.test.ts: that test still
// holds (trace.success === false, trace.error contains "drift"). This test
// adds the missing assertion: the BODY survives the drift branch.
//
// Real-runtime: live executeSkill + globalThis.fetch network-boundary stub.

import { describe, test, expect } from "bun:test";
import { executeSkill } from "../src/execution/index.js";
import type { EndpointDescriptor, SkillManifest } from "../src/types/index.js";

const originalFetch = globalThis.fetch;

// Captured schema: array of subscription objects with link/url/title (an
// RSS-feed-ish shape that some capture pipelines learn for feed pages).
const CAPTURED_SCHEMA = {
  type: "object" as const,
  properties: {
    items: {
      type: "array" as const,
      items: {
        type: "object" as const,
        properties: {
          link: { type: "string" as const },
          url: { type: "string" as const },
          title: { type: "string" as const },
        },
      },
    },
  },
};

// Server returns the REAL YouTube-style subscription data (different field
// names than CAPTURED_SCHEMA); drift is BREAKING (removed link/url/title)
// but the body carries real subscriptions the agent can read.
const REAL_BODY = {
  kind: "youtube#subscriptionListResponse",
  items: [
    { id: "sub_1", snippet: { title: "Channel A", resourceId: { channelId: "UCxx1" } } },
    { id: "sub_2", snippet: { title: "Channel B", resourceId: { channelId: "UCxx2" } } },
    { id: "sub_3", snippet: { title: "Channel C", resourceId: { channelId: "UCxx3" } } },
  ],
};

function mkEndpoint(over: Partial<EndpointDescriptor> = {}): EndpointDescriptor {
  return {
    endpoint_id: "subscriptions-ep",
    method: "GET",
    url_template: "https://drift-body.example.org/subscriptions",
    idempotency: "safe",
    verification_status: "verified",
    reliability_score: 1,
    description: "subscriptions endpoint",
    response_schema: CAPTURED_SCHEMA,
    ...over,
  };
}

function mkSkill(endpoint: EndpointDescriptor): SkillManifest {
  return {
    skill_id: "drift-body-skill",
    version: "1.0.0",
    schema_version: "1",
    lifecycle: "active",
    execution_type: "http",
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    name: "drift-body-test",
    intent_signature: "list subscriptions",
    domain: "drift-body.example.org",
    description: "drift body preservation test",
    owner_type: "agent",
    endpoints: [endpoint],
  };
}

function makeStubFetch() {
  const stub = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const method = (init.method || "GET").toUpperCase();
    const url = typeof input === "string"
      ? input
      : input instanceof URL ? input.toString() : (input as Request).url;
    if (!url.includes("drift-body.example.org")) {
      return new Response("", { status: 404 });
    }
    const headers = (init.headers ?? {}) as Record<string, string>;
    const isProbe = method === "HEAD" || (method === "GET" && !!headers["range"]);
    if (isProbe) {
      return new Response(null, {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    return new Response(JSON.stringify(REAL_BODY), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof globalThis.fetch;
  return { stub };
}

describe("execute drift -> body preservation (W1 retrieval truth-telling)", () => {
  test("breaking drift + real-data body: data is the real body, not the schema_drift envelope", async () => {
    const { stub } = makeStubFetch();
    globalThis.fetch = stub;
    try {
      const skill = mkSkill(mkEndpoint());
      const out = await executeSkill(
        skill,
        {},
        { raw: true },
        {
          intent: "list my subscriptions",
          contextUrl: "https://drift-body.example.org/subscriptions",
        },
      );

      // Drift detected as expected (RSS-shape captured, REST-shape served).
      expect(out.trace.drift?.drifted).toBe(true);
      expect(out.trace.re_capture_signal).toBeDefined();

      // the platform may still flip success=false to be coherent with
      // re_capture_signal (existing test contract). What it MUST NOT do is
      // replace `data` with the error envelope, hiding the real body.
      expect(out.trace.error).toBe("schema_drift_recapture_required");

      // THE W1 ASSERTION: the body the agent receives carries the real
      // data (the platform's role is to surface evidence + signals; the
      // agent judges whether the body matches the intent, per
      // GATE_JUDGE.md "body is what matters").
      const body = out.result as Record<string, unknown> | null;
      expect(body).not.toBeNull();
      expect(body).not.toHaveProperty("error", "schema_drift_recapture_required");
      expect(body).toHaveProperty("kind", "youtube#subscriptionListResponse");
      expect(Array.isArray((body as { items?: unknown }).items)).toBe(true);
      expect(((body as { items: unknown[] }).items).length).toBe(3);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("breaking drift on a GraphQL error envelope: still replaces body (legitimate no-data case)", async () => {
    // Sanity-check the unchanged GraphQL-envelope branch: when the body
    // genuinely has no data (errors[] populated, no data key), the
    // platform should still surface a graphql_error_envelope wrapper so
    // the agent sees the server's actual error messages. The W1 fix only
    // touches the generic schema-drift branch, not the GraphQL one.
    const GQL_SCHEMA = {
      type: "object" as const,
      properties: {
        data: {
          type: "object" as const,
          properties: {
            user: { type: "object" as const, properties: { id: { type: "string" as const } } },
          },
        },
      },
    };
    const gqlStub = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
      const method = (init.method || "GET").toUpperCase();
      const headers = (init.headers ?? {}) as Record<string, string>;
      const url = typeof input === "string" ? input : (input as URL).toString();
      if (!url.includes("gql-envelope.example.org")) {
        return new Response("", { status: 404 });
      }
      const isProbe = method === "HEAD" || (method === "GET" && !!headers["range"]);
      if (isProbe) {
        return new Response(null, { status: 200, headers: { "content-type": "application/json" } });
      }
      return new Response(
        JSON.stringify({ errors: [{ message: "Token expired" }] }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as typeof globalThis.fetch;
    globalThis.fetch = gqlStub;
    try {
      const ep: EndpointDescriptor = {
        endpoint_id: "gql-ep",
        method: "GET",
        url_template: "https://gql-envelope.example.org/graphql",
        idempotency: "safe",
        verification_status: "verified",
        reliability_score: 1,
        description: "graphql endpoint",
        response_schema: GQL_SCHEMA,
      };
      const skill: SkillManifest = {
        skill_id: "gql-skill",
        version: "1.0.0",
        schema_version: "1",
        lifecycle: "active",
        execution_type: "http",
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        name: "gql-test",
        intent_signature: "fetch user",
        domain: "gql-envelope.example.org",
        description: "gql envelope test",
        owner_type: "agent",
        endpoints: [ep],
      };
      const out = await executeSkill(
        skill,
        {},
        { raw: true },
        { intent: "fetch user", contextUrl: "https://gql-envelope.example.org/graphql" },
      );
      // GraphQL envelope path: body genuinely has no data (errors only),
      // so the platform's graphql_error_envelope wrapper is the right
      // surface; the agent gets the server's error messages.
      expect(out.trace.error).toBe("graphql_error_envelope");
      const body = out.result as Record<string, unknown> | null;
      expect(body).toHaveProperty("error", "graphql_error_envelope");
      expect(body).toHaveProperty("graphql_errors");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
