// Truth-telling coherence: when executeEndpoint detects response-schema
// drift on a previously-captured endpoint and emits a re_capture_signal,
// trace.success MUST NOT remain true. "Re-capture needed" and "here is
// your data" are mutually exclusive — the platform already computed the
// truth (re_capture_signal); success must reflect it.
//
// Live regression (2026-05-16): intent "search beatsaver for camellia"
// executed, server-fetch returned the SPA shell {title,url} instead of
// camellia maps. detectSchemaDrift fired, re_capture_signal was emitted,
// but trace.success stayed true and the agent received {title,url} as a
// "successful" answer. Mirrors the adjacent assessIntentResult-fail
// pattern at src/execution/index.ts (success=false + error + actionable
// data) which the drift branch skipped.
//
// Real-runtime: live executeSkill + globalThis.fetch network-boundary
// stub (no in-process mocks), modeled on execution-recipe-replay.test.ts.

import { describe, test, expect } from "bun:test";
import { executeSkill } from "../src/execution/index.js";
import type { EndpointDescriptor, SkillManifest } from "../src/types/index.js";

const originalFetch = globalThis.fetch;

// Captured "search results" contract: an array of result objects. The
// replay will drift away from this to a bare {title,url} shell.
const CAPTURED_SCHEMA = {
  type: "object" as const,
  properties: {
    docs: {
      type: "array" as const,
      items: {
        type: "object" as const,
        properties: {
          name: { type: "string" as const },
          id: { type: "string" as const },
        },
      },
    },
  },
};

function mkEndpoint(over: Partial<EndpointDescriptor> = {}): EndpointDescriptor {
  return {
    endpoint_id: "search-ep",
    method: "GET",
    url_template: "https://drift.example.org/?q={q}",
    idempotency: "safe",
    verification_status: "verified",
    reliability_score: 1,
    description: "search endpoint",
    response_schema: CAPTURED_SCHEMA,
    ...over,
  };
}

function mkSkill(endpoint: EndpointDescriptor): SkillManifest {
  return {
    skill_id: "drift-skill",
    version: "1.0.0",
    schema_version: "1",
    lifecycle: "active",
    execution_type: "http",
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    name: "drift-test",
    intent_signature: "search drift example",
    domain: "drift.example.org",
    description: "drift coherence test",
    owner_type: "agent",
    endpoints: [endpoint],
  };
}

// Stub: probe (HEAD / ranged GET) → 200; full server fetch → a degenerate
// {title,url} JSON body that drifts hard from CAPTURED_SCHEMA (adds
// title,url; removes docs/docs[].*). application/json keeps the parsed
// object as `data` so the drift branch at index.ts:3791 evaluates it.
function makeStubFetch() {
  const counters = { probe: 0, server: 0 };
  const stub = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const method = (init.method || "GET").toUpperCase();
    const url = typeof input === "string"
      ? input
      : input instanceof URL ? input.toString() : (input as Request).url;
    if (!url.includes("drift.example.org")) {
      return new Response("", { status: 404 });
    }
    const headers = (init.headers ?? {}) as Record<string, string>;
    const isProbe = method === "HEAD" || (method === "GET" && !!headers["range"]);
    if (isProbe) {
      counters.probe += 1;
      return new Response(null, {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    counters.server += 1;
    return new Response(
      JSON.stringify({ title: "Drift Example", url: "https://drift.example.org" }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }) as typeof globalThis.fetch;
  return { stub, counters };
}

describe("execute drift → success coherence (truth-telling)", () => {
  test("re_capture_signal emitted ⟹ trace.success is false (not a silent success on shell data)", async () => {
    const { stub } = makeStubFetch();
    globalThis.fetch = stub;
    try {
      const skill = mkSkill(mkEndpoint());
      const out = await executeSkill(
        skill,
        { q: "camellia" },
        { raw: true },
        {
          intent: "search drift example for camellia",
          contextUrl: "https://drift.example.org/?q=camellia",
        },
      );

      // the platform detected drift and emitted the recapture signal.
      expect(out.trace.drift?.drifted).toBe(true);
      expect(out.trace.re_capture_signal).toBeDefined();
      expect(out.trace.re_capture_signal?.kind).toBe("re_capture_after_drift");

      // The bug: success stayed true while a re_capture_signal said
      // "I did not get the contracted data; re-learn needed." Those
      // cannot both hold. Post-fix, success reflects the signal.
      expect(out.trace.success).toBe(false);

      // And the failure is named honestly so the agent does not treat
      // the drifted shell payload as the answer.
      expect(typeof out.trace.error).toBe("string");
      expect(String(out.trace.error)).toContain("drift");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("no drift ⟹ success unaffected (fix is scoped to the drift+signal case)", async () => {
    // Endpoint whose captured schema matches what the server returns:
    // {title,url}. No drift → no re_capture_signal → success stays true.
    const matchingSchema = {
      type: "object" as const,
      properties: {
        title: { type: "string" as const },
        url: { type: "string" as const },
      },
    };
    const { stub } = makeStubFetch();
    globalThis.fetch = stub;
    try {
      const skill = mkSkill(mkEndpoint({ response_schema: matchingSchema }));
      const out = await executeSkill(
        skill,
        { q: "camellia" },
        { raw: true },
        {
          intent: "get drift example title",
          contextUrl: "https://drift.example.org/?q=camellia",
        },
      );
      expect(out.trace.re_capture_signal).toBeUndefined();
      expect(out.trace.drift?.drifted ?? false).toBe(false);
      // No drift path taken; success is governed by the normal flow,
      // not flipped by this fix.
      expect(out.trace.success).toBe(true);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
