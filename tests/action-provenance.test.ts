import { describe, expect, it } from "bun:test";
import type { RawRequest } from "../src/capture/index.js";
import { tagRequestProvenance } from "../src/capture/index.js";

/**
 * Tests for action→request provenance tagging (#214).
 *
 * `tagRequestProvenance` assigns `triggered_by_step`, `triggered_by_action`,
 * and `triggered_by_ref` to each RawRequest based on timestamp comparison
 * with step timing entries.
 */

function makeRequest(overrides: Partial<RawRequest> & { timestamp: string }): RawRequest {
  return {
    url: "https://api.example.com/data",
    method: "GET",
    request_headers: {},
    response_status: 200,
    response_headers: {},
    timestamp: overrides.timestamp,
    ...overrides,
  };
}

describe("tagRequestProvenance", () => {
  it("tags requests that arrive after a step starts", () => {
    const requests: RawRequest[] = [
      makeRequest({ url: "https://api.example.com/search?q=test", timestamp: "2026-04-01T10:00:01.500Z" }),
      makeRequest({ url: "https://api.example.com/suggest", timestamp: "2026-04-01T10:00:01.800Z" }),
    ];

    const stepTimings = [
      { stepIndex: 0, action: "fill", ref: "e1", startedAt: "2026-04-01T10:00:00.000Z" },
      { stepIndex: 1, action: "click", ref: "e2", startedAt: "2026-04-01T10:00:01.000Z" },
    ];

    tagRequestProvenance(requests, stepTimings);

    // Both requests arrived after step 1 started, so they belong to step 1
    expect(requests[0].triggered_by_step).toBe(1);
    expect(requests[0].triggered_by_action).toBe("click");
    expect(requests[0].triggered_by_ref).toBe("e2");

    expect(requests[1].triggered_by_step).toBe(1);
    expect(requests[1].triggered_by_action).toBe("click");
    expect(requests[1].triggered_by_ref).toBe("e2");
  });

  it("assigns requests to the correct step based on timing", () => {
    const requests: RawRequest[] = [
      // This request arrived between step 0 and step 1
      makeRequest({ url: "https://api.example.com/autocomplete", timestamp: "2026-04-01T10:00:00.500Z" }),
      // This request arrived after step 1
      makeRequest({ url: "https://api.example.com/results", timestamp: "2026-04-01T10:00:01.500Z" }),
      // This request arrived after step 2
      makeRequest({ url: "https://api.example.com/details", timestamp: "2026-04-01T10:00:03.000Z" }),
    ];

    const stepTimings = [
      { stepIndex: 0, action: "fill", ref: "e1", startedAt: "2026-04-01T10:00:00.000Z" },
      { stepIndex: 1, action: "press", ref: undefined, startedAt: "2026-04-01T10:00:01.000Z" },
      { stepIndex: 2, action: "click", ref: "e5", startedAt: "2026-04-01T10:00:02.000Z" },
    ];

    tagRequestProvenance(requests, stepTimings);

    expect(requests[0].triggered_by_step).toBe(0);
    expect(requests[0].triggered_by_action).toBe("fill");
    expect(requests[0].triggered_by_ref).toBe("e1");

    expect(requests[1].triggered_by_step).toBe(1);
    expect(requests[1].triggered_by_action).toBe("press");
    expect(requests[1].triggered_by_ref).toBeUndefined();

    expect(requests[2].triggered_by_step).toBe(2);
    expect(requests[2].triggered_by_action).toBe("click");
    expect(requests[2].triggered_by_ref).toBe("e5");
  });

  it("leaves requests before any step untagged", () => {
    const requests: RawRequest[] = [
      // This request arrived before any step started (during initial navigation)
      makeRequest({ url: "https://example.com/init.js", timestamp: "2026-04-01T09:59:59.000Z" }),
      // This one arrived after step 0
      makeRequest({ url: "https://api.example.com/data", timestamp: "2026-04-01T10:00:00.500Z" }),
    ];

    const stepTimings = [
      { stepIndex: 0, action: "click", ref: "e0", startedAt: "2026-04-01T10:00:00.000Z" },
    ];

    tagRequestProvenance(requests, stepTimings);

    // First request is before any step — should remain untagged
    expect(requests[0].triggered_by_step).toBeUndefined();
    expect(requests[0].triggered_by_action).toBeUndefined();
    expect(requests[0].triggered_by_ref).toBeUndefined();

    // Second request is after step 0
    expect(requests[1].triggered_by_step).toBe(0);
    expect(requests[1].triggered_by_action).toBe("click");
    expect(requests[1].triggered_by_ref).toBe("e0");
  });

  it("handles empty step timings (no-op)", () => {
    const requests: RawRequest[] = [
      makeRequest({ url: "https://api.example.com/data", timestamp: "2026-04-01T10:00:00.000Z" }),
    ];

    tagRequestProvenance(requests, []);

    // Nothing should be tagged
    expect(requests[0].triggered_by_step).toBeUndefined();
    expect(requests[0].triggered_by_action).toBeUndefined();
    expect(requests[0].triggered_by_ref).toBeUndefined();
  });

  it("handles empty requests array (no-op)", () => {
    const stepTimings = [
      { stepIndex: 0, action: "click", ref: "e0", startedAt: "2026-04-01T10:00:00.000Z" },
    ];

    // Should not throw
    tagRequestProvenance([], stepTimings);
  });

  it("handles requests with no timestamp", () => {
    const requests: RawRequest[] = [
      {
        url: "https://api.example.com/data",
        method: "GET",
        request_headers: {},
        response_status: 200,
        response_headers: {},
        timestamp: "", // empty timestamp
      },
    ];

    const stepTimings = [
      { stepIndex: 0, action: "click", ref: "e0", startedAt: "2026-04-01T10:00:00.000Z" },
    ];

    tagRequestProvenance(requests, stepTimings);

    // Empty timestamp -> falsy -> should remain untagged
    expect(requests[0].triggered_by_step).toBeUndefined();
  });

  it("correctly tags a realistic search flow sequence", () => {
    // Simulates: fill search box -> press Enter -> click result
    const requests: RawRequest[] = [
      // Page load request (before any step)
      makeRequest({ url: "https://example.com/", timestamp: "2026-04-01T10:00:00.000Z" }),
      // Autocomplete triggered by filling the search box
      makeRequest({ url: "https://api.example.com/autocomplete?q=tes", timestamp: "2026-04-01T10:00:01.200Z" }),
      makeRequest({ url: "https://api.example.com/autocomplete?q=test", timestamp: "2026-04-01T10:00:01.500Z" }),
      // Search results triggered by pressing Enter
      makeRequest({ url: "https://api.example.com/search?q=test", timestamp: "2026-04-01T10:00:02.500Z" }),
      makeRequest({ url: "https://api.example.com/ads?q=test", timestamp: "2026-04-01T10:00:02.800Z" }),
      // Detail page triggered by clicking a result
      makeRequest({ url: "https://api.example.com/items/42", timestamp: "2026-04-01T10:00:04.000Z" }),
    ];

    const stepTimings = [
      { stepIndex: 0, action: "fill", ref: "e3", startedAt: "2026-04-01T10:00:01.000Z" },
      { stepIndex: 1, action: "press", ref: undefined, startedAt: "2026-04-01T10:00:02.000Z" },
      { stepIndex: 2, action: "click", ref: "e7", startedAt: "2026-04-01T10:00:03.500Z" },
    ];

    tagRequestProvenance(requests, stepTimings);

    // Page load — before any step
    expect(requests[0].triggered_by_step).toBeUndefined();

    // Autocomplete — triggered by fill (step 0)
    expect(requests[1].triggered_by_step).toBe(0);
    expect(requests[1].triggered_by_action).toBe("fill");
    expect(requests[1].triggered_by_ref).toBe("e3");

    expect(requests[2].triggered_by_step).toBe(0);

    // Search results — triggered by press Enter (step 1)
    expect(requests[3].triggered_by_step).toBe(1);
    expect(requests[3].triggered_by_action).toBe("press");
    expect(requests[3].triggered_by_ref).toBeUndefined();

    expect(requests[4].triggered_by_step).toBe(1);

    // Detail page — triggered by click (step 2)
    expect(requests[5].triggered_by_step).toBe(2);
    expect(requests[5].triggered_by_action).toBe("click");
    expect(requests[5].triggered_by_ref).toBe("e7");
  });

  it("handles unsorted step timings gracefully", () => {
    const requests: RawRequest[] = [
      makeRequest({ url: "https://api.example.com/a", timestamp: "2026-04-01T10:00:00.500Z" }),
      makeRequest({ url: "https://api.example.com/b", timestamp: "2026-04-01T10:00:01.500Z" }),
    ];

    // Step timings provided out of order
    const stepTimings = [
      { stepIndex: 1, action: "click", ref: "e2", startedAt: "2026-04-01T10:00:01.000Z" },
      { stepIndex: 0, action: "fill", ref: "e1", startedAt: "2026-04-01T10:00:00.000Z" },
    ];

    tagRequestProvenance(requests, stepTimings);

    // Should still correctly sort and assign
    expect(requests[0].triggered_by_step).toBe(0);
    expect(requests[0].triggered_by_action).toBe("fill");

    expect(requests[1].triggered_by_step).toBe(1);
    expect(requests[1].triggered_by_action).toBe("click");
  });

  it("tags a request exactly at step start time to that step", () => {
    const requests: RawRequest[] = [
      makeRequest({ url: "https://api.example.com/data", timestamp: "2026-04-01T10:00:01.000Z" }),
    ];

    const stepTimings = [
      { stepIndex: 0, action: "fill", ref: "e1", startedAt: "2026-04-01T10:00:00.000Z" },
      { stepIndex: 1, action: "click", ref: "e2", startedAt: "2026-04-01T10:00:01.000Z" },
    ];

    tagRequestProvenance(requests, stepTimings);

    // Request timestamp exactly matches step 1's start time -> attributed to step 1
    expect(requests[0].triggered_by_step).toBe(1);
    expect(requests[0].triggered_by_action).toBe("click");
  });
});
