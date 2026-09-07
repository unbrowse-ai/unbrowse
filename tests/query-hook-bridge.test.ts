import { describe, test, expect } from "bun:test";
import type { RawRequest, QueryHookEvent } from "../src/capture/index.js";

describe("#114 query hook bridge", () => {
  test("RawRequest supports provenance fields", () => {
    const req: RawRequest = {
      url: "https://api.example.com/submit",
      method: "POST",
      request_headers: {},
      response_status: 200,
      response_headers: {},
      timestamp: new Date().toISOString(),
      triggered_by_step: 2,
      triggered_by_action: "click",
      triggered_by_ref: "button#submit",
    };
    expect(req.triggered_by_step).toBe(2);
    expect(req.triggered_by_action).toBe("click");
    expect(req.triggered_by_ref).toBe("button#submit");
  });

  test("QueryHookEvent aggregates requests per action", () => {
    const event: QueryHookEvent = {
      step_index: 1,
      action_type: "click",
      selector: "button#go",
      requests_triggered: [
        { url: "https://api.example.com/search", method: "GET" },
        { url: "https://api.example.com/log", method: "POST" },
      ],
      timestamp: Date.now(),
    };
    expect(event.requests_triggered.length).toBe(2);
    expect(event.action_type).toBe("click");
  });

  test("provenance fields are optional for backward compat", () => {
    const req: RawRequest = {
      url: "https://example.com",
      method: "GET",
      request_headers: {},
      response_status: 200,
      response_headers: {},
      timestamp: new Date().toISOString(),
    };
    expect(req.triggered_by_step).toBeUndefined();
  });
});
