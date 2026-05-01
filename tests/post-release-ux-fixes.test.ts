import { describe, expect, test } from "bun:test";

// Three pre-existing UX bugs caught by driving the harness against shipped v6.1.0:
//  - silent execute fail (status_code:0, empty result, no error in slimTrace projection)
//  - resolve surfaces a single negative-score endpoint instead of falling through
//  - resolve generates one endpoint_id while the cached skill has another

describe("UX fix #10 — silent execute failure surfaces error", () => {
  // Mirror the slimTrace projection from src/cli.ts — the shipped one stripped
  // trace.error, leaving the user with success:false + status_code:0 and nothing
  // to act on. The fix: include trace.error in the projection.
  function slimTraceProjection(trace: { error?: string; success: boolean; status_code: number }) {
    return {
      success: trace.success,
      status_code: trace.status_code,
      ...(typeof trace.error === "string" ? { error: trace.error } : {}),
    };
  }

  test("network failure (status 0) keeps trace.error in slimmed output", () => {
    const slim = slimTraceProjection({ success: false, status_code: 0, error: "HTTP 0 — network failure" });
    expect(slim.error).toContain("HTTP 0");
  });

  test("successful trace omits error field", () => {
    const slim = slimTraceProjection({ success: true, status_code: 200 });
    expect("error" in slim).toBe(false);
  });
});

describe("UX fix #11 — all-negative shortlist falls through to handoff", () => {
  // Mirror the gate from src/orchestrator/index.ts: when same-host resolve
  // returns only negative-score endpoints, treat as no real match and emit
  // an actionable next_step rather than surfacing the wrong endpoint.
  function shouldHandoff(epRanked: Array<{ score: number }>, hostMatches: boolean): boolean {
    const allNegative = epRanked.length > 0 && epRanked.every((r) => r.score < 0);
    return (epRanked.length === 0 || allNegative) && hostMatches;
  }

  test("empty shortlist on same host triggers handoff", () => {
    expect(shouldHandoff([], true)).toBe(true);
  });

  test("only-negative shortlist on same host triggers handoff", () => {
    expect(shouldHandoff([{ score: -41.7 }, { score: -100 }], true)).toBe(true);
  });

  test("any positive score keeps the shortlist", () => {
    expect(shouldHandoff([{ score: -41.7 }, { score: 50 }], true)).toBe(false);
  });

  test("cross-host never triggers handoff (defer to other resolve sources)", () => {
    expect(shouldHandoff([{ score: -41.7 }], false)).toBe(false);
  });
});

describe("UX fix #9 — endpoint_id mismatch self-heals via single-endpoint fallback", () => {
  // Mirror the single-endpoint branch of routes.ts auto-recovery.
  function rewriteEndpointId(
    want: string,
    available: Array<{ endpoint_id: string }>,
  ): string {
    if (available.length === 1 && available[0].endpoint_id !== want) {
      return available[0].endpoint_id;
    }
    return want;
  }

  test("single-endpoint skill: rewrites caller's stale ID to the only available", () => {
    const rewritten = rewriteEndpointId("QIclmv-resolve-id", [{ endpoint_id: "Uoju8N3-cache-id" }]);
    expect(rewritten).toBe("Uoju8N3-cache-id");
  });

  test("multi-endpoint skill: does not silently rewrite (caller must pick)", () => {
    const rewritten = rewriteEndpointId("Q-want", [
      { endpoint_id: "ep-a" },
      { endpoint_id: "ep-b" },
    ]);
    expect(rewritten).toBe("Q-want");
  });

  test("matching ID: no rewrite", () => {
    const rewritten = rewriteEndpointId("ep-a", [{ endpoint_id: "ep-a" }]);
    expect(rewritten).toBe("ep-a");
  });
});
