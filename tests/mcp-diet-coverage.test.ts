// Day 4 (Luminaries) failing test for AC3 — diet coverage gap.
// FAILS today (successResult does not apply oversize cap; 6 sibling
// handlers bypass diet). Day 7 pours dietIfOversize into successResult;
// this test flips green for all 7 handlers.
//
// Context: src/mcp.ts has `maybePostProcessResult` which applies
// `dietIfOversize` — but it is only invoked for `unbrowse_resolve` and
// `unbrowse_execute`. The other 6 sibling handlers (unbrowse_snap,
// unbrowse_text, unbrowse_markdown, unbrowse_skills, unbrowse_trace,
// unbrowse_validate) all flow through the un-capped `successResult`
// (src/mcp.ts:141) which only previews the text channel but lets
// `structuredContent` carry the full oversize body to the wire.
//
// AC3 decision (boundary Day 7): pour `dietIfOversize` into
// `successResult` itself so every tool return inherits the cap.
//
// Two failing assertions today:
//   1. successResult is not exported from src/mcp.ts.
//   2. Even if we could reach it, it does not cap structuredContent.

import { describe, expect, test } from "bun:test";
import * as mcp from "../src/mcp.js";

const SIZE_BUDGET_CHARS = 25_000;

function buildOversizeValue(): Record<string, unknown> {
  const big = "x".repeat(120_000);
  return {
    description: "Oversize sibling-handler payload (e.g. unbrowse_snap a11y tree, unbrowse_markdown long page).",
    a11y_tree: big,
    markdown: big,
    text: big,
    skills: Array.from({ length: 12 }, (_, i) => ({
      id: `skill_${i}`,
      blob: big.slice(0, 8_000),
    })),
  };
}

function wireSize(result: unknown): number {
  // The wire body the agent sees is the full ToolResult — text preview
  // + structuredContent. Both must fit under the budget.
  return JSON.stringify(result).length;
}

describe("MCP diet coverage — successResult must apply dietIfOversize (AC3)", () => {
  test("src/mcp.ts must export successResult so the diet contract is testable", () => {
    expect(
      typeof (mcp as Record<string, unknown>).successResult,
      "src/mcp.ts must export `successResult` so callers and tests can prove every tool return (not just resolve/execute) inherits the oversize cap.",
    ).toBe("function");
  });

  test("successResult caps oversize payloads at <= 25_000 chars and emits a truncation marker", () => {
    const fn = (mcp as Record<string, unknown>).successResult as
      | ((value: unknown, summary?: string) => unknown)
      | undefined;

    // If the export does not exist, we still falsify the invariant by
    // constructing the un-capped wire body — the un-capped value is
    // guaranteed to blow the budget. Day 7 makes both pass.
    const oversize = buildOversizeValue();
    const result = typeof fn === "function" ? fn(oversize, "sibling-handler label") : { structuredContent: oversize };

    const size = wireSize(result);
    expect(
      size,
      `successResult returned ${size} chars (budget ${SIZE_BUDGET_CHARS}). It must call dietIfOversize on the value so all sibling handlers (unbrowse_snap, unbrowse_text, unbrowse_markdown, unbrowse_skills, unbrowse_trace, unbrowse_validate) inherit the cap.`,
    ).toBeLessThanOrEqual(SIZE_BUDGET_CHARS);

    const serialized = JSON.stringify(result);
    expect(
      serialized.includes("truncated") || serialized.includes("[truncated"),
      "Diet must leave a visible truncation marker (e.g. '...[truncated N chars]') so the calling agent knows the body was capped, not silently lost.",
    ).toBe(true);
  });
});
