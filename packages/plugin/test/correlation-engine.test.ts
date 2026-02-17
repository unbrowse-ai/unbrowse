import { describe, it, expect } from "bun:test";

import { inferCorrelationGraphV1, planChainForTarget } from "../src/correlation-engine.js";
import { prepareRequestForStep, type StepResponseRuntime } from "../src/sequence-executor.js";
import type { CapturedExchange } from "../src/types.js";

describe("correlation-engine: value links + chain planning", () => {
  it("links response.body -> request.header/query and plans prerequisites", () => {
    const exchanges: CapturedExchange[] = [
      {
        index: 0,
        timestamp: 1,
        request: {
          method: "GET",
          url: "https://example.com/start",
          headers: {},
          cookies: {},
          queryParams: {},
        },
        response: {
          status: 200,
          headers: { "content-type": "application/json" },
          cookies: {},
          body: { csrfToken: "abc1234567" },
          bodyRaw: JSON.stringify({ csrfToken: "abc1234567" }),
          bodyFormat: "json",
          contentType: "application/json",
        },
      },
      {
        index: 1,
        timestamp: 2,
        request: {
          method: "POST",
          url: "https://example.com/submit",
          headers: { "X-CSRF-Token": "abc1234567", "content-type": "application/json" },
          cookies: {},
          queryParams: {},
          body: { foo: "bar" },
          bodyRaw: JSON.stringify({ foo: "bar" }),
          bodyFormat: "json",
          contentType: "application/json",
        },
        response: {
          status: 200,
          headers: { "content-type": "application/json" },
          cookies: {},
          body: { sessionId: "sess_12345678" },
          bodyRaw: JSON.stringify({ sessionId: "sess_12345678" }),
          bodyFormat: "json",
          contentType: "application/json",
        },
      },
      {
        index: 2,
        timestamp: 3,
        request: {
          method: "GET",
          url: "https://example.com/data?sessionId=sess_12345678",
          headers: {},
          cookies: {},
          queryParams: { sessionId: "sess_12345678" },
        },
        response: {
          status: 200,
          headers: { "content-type": "application/json" },
          cookies: {},
          body: { ok: true },
          bodyRaw: JSON.stringify({ ok: true }),
          bodyFormat: "json",
          contentType: "application/json",
        },
      },
    ];

    const graph = inferCorrelationGraphV1(exchanges);

    // Expect a link from step 0 response body to step 1 request header.
    const headerLink = graph.links.find(
      (l) =>
        l.sourceRequestIndex === 0 &&
        l.targetRequestIndex === 1 &&
        l.targetLocation === "header" &&
        l.targetPath.includes("X-CSRF-Token"),
    );
    expect(headerLink).toBeDefined();

    // Expect a link from step 1 response body to step 2 query param.
    const queryLink = graph.links.find(
      (l) =>
        l.sourceRequestIndex === 1 &&
        l.targetRequestIndex === 2 &&
        l.targetLocation === "query" &&
        l.targetPath === "query.sessionId",
    );
    expect(queryLink).toBeDefined();

    // Chain planning should include prerequisites.
    expect(planChainForTarget(graph, 2)).toEqual([0, 1, 2]);

    // Injection should set the correlated values when preparing later requests.
    const runtime = new Map<number, StepResponseRuntime>();
    runtime.set(0, {
      status: 200,
      headers: {},
      bodyText: JSON.stringify({ csrfToken: "abc1234567" }),
      contentType: "application/json",
      bodyJson: { csrfToken: "abc1234567" },
    });
    const prepared1 = prepareRequestForStep(exchanges, graph, 1, runtime, { sessionHeaders: {} });
    expect(prepared1?.headers["X-CSRF-Token"]).toBe("abc1234567");

    runtime.set(1, {
      status: 200,
      headers: {},
      bodyText: JSON.stringify({ sessionId: "sess_12345678" }),
      contentType: "application/json",
      bodyJson: { sessionId: "sess_12345678" },
    });
    const prepared2 = prepareRequestForStep(exchanges, graph, 2, runtime, { sessionHeaders: {} });
    expect(prepared2?.url).toContain("sessionId=sess_12345678");
  });
});

