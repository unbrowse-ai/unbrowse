import { describe, expect, test } from "bun:test";
import * as mcp from "../src/mcp.js";

// Day 3 (Land) seed test for Unbrowse MCP audit 6.10.0 → 6.13.0.
//
// Acceptance criterion #1 (audit §1):
//   Every MCP tool result body returned to the calling agent must be
//   <= 25_000 characters when JSON-serialized. Oversize sessions
//   observed: google-maps (79,865), shopee.sg (116,718), carousell
//   (83,163), eatigo (64,416), eatigo --debug (55,422).
//
// Hook point (audit §inventory, src/mcp.ts:710-737):
//   `maybePostProcessResult` already shapes the value the four
//   affected tools (unbrowse_resolve, unbrowse_run, unbrowse_execute)
//   return to MCP. The Day 4 diet lives there.
//
// This test FAILS today (the function is not exported AND/OR does no
// capping). After Day 4 exports a capped post-processor, it passes.

const SIZE_BUDGET_CHARS = 25_000;

// A realistic fat fixture: ~120KB of nested HTML/JSON like the
// shopee.sg session captured in the audit.
function buildFatResult(label: string) {
  const big = "x".repeat(120_000);
  return {
    trace: { decision_path: ["probe", "decision", "server_fetch"] },
    result: {
      description: `Captured ${label} endpoint`,
      available_endpoints: Array.from({ length: 8 }, (_, i) => ({
        endpoint_id: `ep_${label}_${i}`,
        url: `https://${label}.example/api/v1/items?page=${i}`,
        score: 0.8 - i * 0.05,
        sample_response_excerpt: big.slice(0, 15_000),
      })),
      raw_html: big,
      response_body: big,
    },
  } as Record<string, unknown>;
}

function bodySize(value: unknown): number {
  return JSON.stringify(value).length;
}

describe("MCP payload size cap — wire-shape invariant (Day 3 Land seed)", () => {
  test("the diet hook is exported from src/mcp.ts", () => {
    // Day 4 will export the capped post-processor. Today it is internal,
    // so this assertion fails red. Name kept minimal — Day 4 picks the
    // final symbol name; this test will be updated to match in that PR.
    expect(
      typeof (mcp as Record<string, unknown>).maybePostProcessResult,
      "src/mcp.ts must export the result post-processor (the diet hook) so callers and tests can prove the size cap.",
    ).toBe("function");
  });

  for (const toolName of ["unbrowse_resolve", "unbrowse_run", "unbrowse_execute"] as const) {
    test(`${toolName}: post-processed body is <= ${SIZE_BUDGET_CHARS} chars on fat fixture`, () => {
      const fat = buildFatResult(toolName);
      const fn = (mcp as Record<string, unknown>).maybePostProcessResult as
        | ((r: Record<string, unknown>, a: Record<string, unknown>) => unknown)
        | undefined;

      // The function must exist (Day 4 contract). If it does not, the
      // assertion above already failed; we still exercise the wire-shape
      // invariant by JSON-stringifying the un-capped fixture, which is
      // guaranteed to exceed the budget.
      const processed = typeof fn === "function" ? fn(fat, {}) : fat;
      const size = bodySize(processed);
      expect(
        size,
        `Tool ${toolName} returned ${size} chars (budget ${SIZE_BUDGET_CHARS}). The post-processor must truncate large fields (raw_html, response_body, sample_response_excerpt) and/or drop noise to fit the budget.`,
      ).toBeLessThanOrEqual(SIZE_BUDGET_CHARS);
    });
  }
});
