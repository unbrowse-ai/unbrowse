import { describe, expect, test } from "bun:test";
import { maybePostProcessResult } from "../src/mcp.js";

// Day 4 (Luminaries) Worker B — Phase 0b projection-bypass contract.
//
// These tests FAIL today (src/mcp.ts:809-816 has `if (false)` as the
// projection-bypass seed, so the diet at L836 still runs on projected
// results and clamps them). Day 5 (Creatures) flips the predicate to
// detect caller-supplied path/extract/limit and skip the diet on already
// projected output. After that change every assertion below goes green.
//
// Contract (Phase 0b):
//   `unbrowse_execute` accepts `path`, `extract`, and `limit` flags that
//   project the response BEFORE the 25KB wire-budget diet fires. A 565KB
//   fixture with `limit:297` must return all 297 items unmodified (no
//   `truncated:true`, no `payload_exceeded_wire_budget_after_diet`).
//   Without projection the diet still fires (regression guard).
//   Projection substitutes for the diet, it does not exempt the final
//   wire size from the 25KB budget.

const SIZE_BUDGET_CHARS = 25_000;

// Each item is ~1.9KB JSON-serialized; 297 items ≈ 565KB total. Mirrors
// the shopee.sg / google-maps oversize sessions in the audit.
function buildFatItemsFixture(count: number = 297) {
  const bodyChunk = "x".repeat(1_800);
  const items = Array.from({ length: count }, (_, i) => ({
    id: `item-${i}`,
    title: `Listing ${i}`,
    body: bodyChunk,
  }));
  return {
    trace: { decision_path: ["probe", "decision", "server_fetch"] },
    result: {
      description: "Captured listings endpoint",
      data: { items },
    },
  } as Record<string, unknown>;
}

function hasTruncationMarker(value: unknown): boolean {
  const serialized = JSON.stringify(value);
  if (!serialized) return false;
  return (
    serialized.includes('"truncated":true') ||
    serialized.includes("payload_exceeded_wire_budget_after_diet") ||
    serialized.includes("[truncated ")
  );
}

describe("MCP payload projection bypass (Phase 0b)", () => {
  test("execute with limit:297 against a 565KB fixture returns 297 items and no truncated marker", () => {
    const fixture = buildFatItemsFixture(297);
    const processed = maybePostProcessResult(fixture, {
      path: "data.items[]",
      limit: 297,
    }) as { result?: unknown[] } | undefined;

    const projected = (processed as { result?: unknown })?.result;
    expect(
      Array.isArray(projected),
      "Expected `result` to be the projected array; got " + typeof projected,
    ).toBe(true);
    expect(
      (projected as unknown[]).length,
      "Caller explicitly asked for limit:297. Projection-bypass must return all 297 items unmodified.",
    ).toBe(297);

    expect(
      hasTruncationMarker(processed),
      "Projected result contains a truncation marker. Caller-supplied path/limit must bypass the wire-budget diet (Phase 0b).",
    ).toBe(false);

    const serialized = JSON.stringify(processed) ?? "";
    expect(
      serialized.includes("payload_exceeded_wire_budget_after_diet"),
      "Saw `payload_exceeded_wire_budget_after_diet` reason. The diet should not run on projected payloads.",
    ).toBe(false);
  });

  test("execute with no projection on same fixture DOES truncate (diet fires, truncated:true present)", () => {
    const fixture = buildFatItemsFixture(297);
    const processed = maybePostProcessResult(fixture, {});

    // Un-projected fat fixture must trigger the diet — this guards
    // against a Day 5 fix that accidentally disables the diet entirely.
    expect(
      hasTruncationMarker(processed),
      "Un-projected 565KB fixture must trigger the diet and emit a truncated:true marker.",
    ).toBe(true);

    const size = JSON.stringify(processed)?.length ?? 0;
    expect(
      size,
      `Un-projected diet output was ${size} chars; must fit the ${SIZE_BUDGET_CHARS} wire budget.`,
    ).toBeLessThanOrEqual(SIZE_BUDGET_CHARS);
  });

  test('execute with path:"data.items[].id" projects only scalars and stays under wire budget', () => {
    const fixture = buildFatItemsFixture(297);
    const processed = maybePostProcessResult(fixture, {
      path: "data.items[].id",
    });

    const projected = (processed as { result?: unknown })?.result;
    expect(
      Array.isArray(projected),
      "Scalar projection must return an array of ids.",
    ).toBe(true);

    const arr = projected as unknown[];
    expect(
      arr.length,
      "Scalar projection on 297-item fixture must yield 297 ids.",
    ).toBe(297);

    // Every element must be a scalar id, not the full row.
    const allScalarStrings = arr.every((v) => typeof v === "string");
    expect(
      allScalarStrings,
      "Projected array must contain only scalar ids, not the original objects.",
    ).toBe(true);

    expect(
      hasTruncationMarker(processed),
      "Scalar-projected payload is small; the diet must not have fired.",
    ).toBe(false);
  });

  test("projected result body stays under 25KB wire size (projection substitutes for diet, not exempts)", () => {
    const fixture = buildFatItemsFixture(297);
    const processed = maybePostProcessResult(fixture, {
      path: "data.items[].id",
    });

    const size = JSON.stringify(processed)?.length ?? 0;
    expect(
      size,
      `Scalar-projected payload was ${size} chars; must fit the ${SIZE_BUDGET_CHARS} wire budget. Projection substitutes for the diet, it does not exempt the wire size invariant.`,
    ).toBeLessThan(SIZE_BUDGET_CHARS);
  });
});
