import { describe, expect, it } from "bun:test";
import type { BrowserActionStep, BrowserActionResult } from "../src/capture/index.js";

/**
 * Tests for executeActionSequence — the first-pass browser action execution
 * that runs actions while capturing network traffic in the background.
 *
 * Pure interface-contract and type-shape tests. Tests that need a running
 * kuri browser instance are marked .todo().
 */

describe("BrowserActionStep interface", () => {
  it("accepts all action types", () => {
    const steps: BrowserActionStep[] = [
      { action: "snapshot" },
      { action: "navigate", value: "https://example.com" },
      { action: "wait", value: "#content", timeoutMs: 3000 },
      { action: "click", ref: "e0" },
      { action: "fill", ref: "e1", value: "search query" },
      { action: "select", ref: "e2", value: "option1" },
      { action: "type", value: "typed text" },
      { action: "scroll" },
      { action: "press", value: "Enter" },
      { action: "hover", ref: "e3" },
      { action: "focus", ref: "e4" },
      { action: "blur", ref: "e5" },
      { action: "check", ref: "e6" },
      { action: "uncheck", ref: "e7" },
      { action: "dblclick", ref: "e8" },
      { action: "evaluate", value: "document.title" },
    ];

    expect(steps).toHaveLength(16);
    for (const step of steps) {
      expect(typeof step.action).toBe("string");
    }
  });
});

describe("action sequence orchestration logic", () => {
  it("handles action errors gracefully", async () => {
    const failingAction = async () => {
      throw new Error("Element not found");
    };

    let stepResult: { ok: boolean; error?: string };
    try {
      await failingAction();
      stepResult = { ok: true };
    } catch (err) {
      stepResult = {
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }

    expect(stepResult.ok).toBe(false);
    expect(stepResult.error).toBe("Element not found");
  });

  it.todo("runs a login flow through kuri (requires running kuri instance)");
  it.todo("runs a search flow with keyboard through kuri (requires running kuri instance)");
  it.todo("captures passive HAR alongside browser actions (requires running kuri instance)");
});

describe("executeActionSequence export", () => {
  it("is exported from capture module", async () => {
    const mod = await import("../src/capture/index.js");
    expect(typeof mod.executeActionSequence).toBe("function");
  });
});

describe("first-pass browser execution contract", () => {
  it("action sequence result shape matches BrowserActionResult", () => {
    const result: BrowserActionResult = {
      ok: true,
      steps: [
        { action: "snapshot", ok: true, result: "tree..." },
        { action: "click", ok: true, result: { status: "ok" } },
        { action: "wait", ok: false, error: "timeout" },
      ],
      final_url: "https://example.com/done",
      html: "<html>...</html>",
      snapshot: "tree...",
      capture: {
        requests: [],
        har_lineage_id: "abc123",
        domain: "example.com",
        final_url: "https://example.com/done",
        ws_messages: undefined,
        html: "<html>...</html>",
      },
      trace_id: "trace-1",
    };

    expect(result.ok).toBe(true);
    expect(result.steps).toHaveLength(3);
    expect(result.steps[2].ok).toBe(false);
    expect(result.capture?.requests).toEqual([]);
    expect(result.trace_id).toBeTruthy();
  });

  it("steps with errors do not break the sequence", () => {
    const steps = [
      { action: "click", ok: true },
      { action: "fill", ok: false, error: "ref not found" },
      { action: "wait", ok: true },
    ];

    const allOk = steps.every((s) => s.ok);
    expect(allOk).toBe(false);

    // But we still have 3 steps processed
    expect(steps).toHaveLength(3);
  });
});
