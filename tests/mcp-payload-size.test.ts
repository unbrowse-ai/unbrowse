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

describe("MCP payload size cap — Day 9 emergence holes (huge arrays, deep nesting, unicode)", () => {
  const fn = (mcp as Record<string, unknown>).maybePostProcessResult as
    | ((r: Record<string, unknown>, a: Record<string, unknown>) => unknown)
    | undefined;

  test("huge array of small objects is capped below wire budget", () => {
    const items = Array.from({ length: 100_000 }, (_, i) => ({
      id: i,
      label: `item-${i}`,
      score: i / 100_000,
    }));
    const fat = { result: items } as Record<string, unknown>;
    const processed = typeof fn === "function" ? fn(fat, {}) : fat;
    const size = bodySize(processed);
    expect(
      size,
      `100K small-object array yielded ${size} chars; diet must cap arrays.`,
    ).toBeLessThanOrEqual(SIZE_BUDGET_CHARS);
  });

  test("deeply nested arrays-of-arrays are capped below wire budget", () => {
    // 4 levels deep, fan-out 10, 50-char leaves — naive serialize is well
    // over 25KB and stresses both the string pass and the array cap.
    const leaf = "y".repeat(50);
    const build = (depth: number): unknown =>
      depth === 0 ? leaf : Array.from({ length: 10 }, () => build(depth - 1));
    const fat = { result: build(4) } as Record<string, unknown>;
    const processed = typeof fn === "function" ? fn(fat, {}) : fat;
    const size = bodySize(processed);
    expect(
      size,
      `deep nested fixture yielded ${size} chars; diet must cap arrays at each level.`,
    ).toBeLessThanOrEqual(SIZE_BUDGET_CHARS);
  });

  test("unicode truncation never leaves orphan surrogates", () => {
    const emoji = "\u{1F600}"; // 😀 — single code point, two UTF-16 units
    const big = emoji.repeat(3000);
    const fat = { result: { x: big } } as Record<string, unknown>;
    const processed = typeof fn === "function" ? fn(fat, {}) : fat;
    // Round-trip through JSON to prove the wire shape is well-formed.
    const roundTrip = JSON.parse(JSON.stringify(processed)) as {
      result: { x: string };
    };
    const body = roundTrip.result.x;
    // Strip the trailing "...[truncated N chars]" marker before checking
    // for orphan surrogates in the truncated body.
    const markerIdx = body.indexOf("...[truncated ");
    const truncatedBody = markerIdx >= 0 ? body.slice(0, markerIdx) : body;
    // Every iterated code point must be either length 1 (BMP) or length 2
    // (full surrogate pair). A length-1 high or low surrogate would be an
    // orphan — that is the bug Day 8 caught.
    const ok = [...truncatedBody].every((c) => c.length === 2 || c.length === 1);
    expect(ok, "truncated unicode body contains orphan surrogate halves").toBe(true);
    // And it should be all emoji (length-2 code units when iterated).
    expect(
      [...truncatedBody].every((c) => c === emoji),
      "truncated body should preserve whole emoji glyphs only",
    ).toBe(true);
  });
});
