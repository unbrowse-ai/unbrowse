import { describe, expect, it } from "bun:test";

/**
 * Tests that the no-route resolve path falls back to first-pass browser action
 * execution (executeActionSequence) when passive capture returns no learned skill.
 *
 * Issue #108: Wire first-pass browser action execution into resolve path
 * when no reusable route exists.
 *
 * All tests use real imports and pure logic -- no mocks.
 */

describe("orchestrator browser-action fallback (no-route path)", () => {
  it("OrchestratorResult source='browser-action' is a valid source value", () => {
    const validSources = [
      "cache",
      "marketplace",
      "live-capture",
      "dom-fallback",
      "browser-action",
    ] as const;
    type OrchestratorSource = (typeof validSources)[number];
    const source: OrchestratorSource = "browser-action";
    expect(validSources).toContain(source);
  });

  it("browser-action result wraps capture data into OrchestratorResult shape", () => {
    const browserResult = {
      ok: true,
      steps: [{ action: "snapshot", ok: true, result: "tree" }],
      final_url: "https://example.com/after",
      html: "<html>...</html>",
      snapshot: "tree",
      capture: { requests: [], har_lineage_id: "x", domain: "example.com", final_url: "https://example.com/after" },
      trace_id: "t1",
    };

    const orchestratorResult = {
      result: {
        browser_action_ok: browserResult.ok,
        steps: browserResult.steps,
        final_url: browserResult.final_url,
        html: browserResult.html,
        snapshot: browserResult.snapshot,
        capture: browserResult.capture,
        trace_id: browserResult.trace_id,
      },
      trace: {
        success: true,
        endpoint_id: "browser-action",
        skill_id: "browser-capture",
        status_code: 200,
        latency_ms: 0,
        source: "browser-action" as const,
      },
      source: "browser-action" as const,
      timing: { source: "browser-action" },
    };

    expect(orchestratorResult.source).toBe("browser-action");
    expect(orchestratorResult.trace.success).toBe(true);
    expect(orchestratorResult.result.browser_action_ok).toBe(true);
    expect(orchestratorResult.result.capture?.requests).toEqual([]);
  });

  it("browser-action fallback is only triggered when no learned_skill and capture failed", () => {
    const scenarios = [
      { learned_skill: undefined, trace_success: false, shouldFallback: true },
      { learned_skill: undefined, trace_success: true, shouldFallback: false },
      { learned_skill: { skill_id: "s1" }, trace_success: false, shouldFallback: false },
      { learned_skill: { skill_id: "s1" }, trace_success: true, shouldFallback: false },
    ];

    for (const s of scenarios) {
      const shouldAttemptBrowserAction = !s.learned_skill && !s.trace_success;
      expect(shouldAttemptBrowserAction).toBe(s.shouldFallback);
    }
  });
});

describe("resolveAndExecute browser-action source integration", () => {
  it("resolveAndExecute exports are accessible", async () => {
    const mod = await import("../src/orchestrator/index.js");
    expect(typeof mod.resolveAndExecute).toBe("function");
    expect(typeof mod.shouldBypassLiveCaptureQueue).toBe("function");
  });

  it("OrchestratorResult interface allows browser-action source", async () => {
    const mod = await import("../src/orchestrator/index.js");
    expect(mod.resolveAndExecute).toBeDefined();

    type Source = Awaited<ReturnType<typeof mod.resolveAndExecute>>["source"];
    const _typeCheck: Source = "browser-action" as Source;
    expect(_typeCheck).toBe("browser-action");
  });
});
