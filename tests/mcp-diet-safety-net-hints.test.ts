import { describe, expect, test } from "bun:test";
import { dietIfOversize } from "../src/mcp.js";

// AC3 from docs/mcp-issues-2026-05-13.md: when even pass-2 array-cap overshoots
// the wire budget, the safety-net wrapper at src/mcp.ts:802-822 falls back to
// `{truncated:true, reason, budget_chars, original_chars, body_excerpt}` with
// NO actionable recovery hint. The agent loses the array AND has no way to
// pick a smaller `limit` for the retry.
//
// Live reproducer (this session, 2026-05-15): unbrowse_resolve on
// https://x.com/search?q=AI+agents&src=typed_query against a freshly-published
// 21-endpoint skill returned `original_chars: 1_315_757`, `budget_chars: 25_000`,
// `body_excerpt: "{...truncated...}"`, no `next_step`, no `suggested_limit`.
//
// Contract this test pins:
//   1. When the safety-net fires, the return object carries a non-empty
//      `next_step` string telling the agent how to recover.
//   2. The return object carries a `suggested_limit` number derived from the
//      overshoot ratio so the agent can retry with a concrete limit.
//   3. The body_excerpt field is still present (no behavior loss).
//   4. The total wire size still fits the budget (no regression on the
//      core invariant).

const SIZE_BUDGET = 25_000;
const ARRAY_MAX_ELEMENTS = 50;

// Build an array large enough that even after pass-2 array-cap to 50 items,
// the serialized result overshoots 25KB. Each item is ~830 chars JSON, below
// the STRING_TRUNCATE_THRESHOLD of 2000 so pass-1 leaves strings alone.
// 50 capped items × ~830 chars = ~41KB > 25KB budget.
function buildSafetyNetTriggerFixture(count: number = 200) {
  const bodyChunk = "x".repeat(800);
  const items = Array.from({ length: count }, (_, i) => ({
    id: `item-${i}`,
    title: `Listing ${i}`,
    body: bodyChunk,
  }));
  return {
    result: { items },
  };
}

describe("dietIfOversize safety-net wrapper (AC3)", () => {
  test("when pass-2 array-cap overshoots, safety-net carries next_step + suggested_limit", () => {
    const fixture = buildSafetyNetTriggerFixture(200);
    const dieted = dietIfOversize(fixture, SIZE_BUDGET) as Record<string, unknown>;

    expect(
      typeof dieted === "object" && dieted !== null,
      "Safety-net must return an object wrapper.",
    ).toBe(true);

    expect(
      dieted.truncated,
      "Safety-net wrapper must carry truncated:true.",
    ).toBe(true);

    expect(
      dieted.reason,
      "Safety-net wrapper must carry the canonical reason string.",
    ).toBe("payload_exceeded_wire_budget_after_diet");

    expect(
      typeof dieted.next_step === "string" && (dieted.next_step as string).length > 0,
      `AC3: safety-net must surface a non-empty next_step string. Got: ${JSON.stringify(dieted.next_step)}`,
    ).toBe(true);

    expect(
      typeof dieted.suggested_limit === "number" && (dieted.suggested_limit as number) > 0,
      `AC3: safety-net must surface a positive suggested_limit derived from the overshoot ratio. Got: ${JSON.stringify(dieted.suggested_limit)}`,
    ).toBe(true);

    expect(
      (dieted.suggested_limit as number) < ARRAY_MAX_ELEMENTS,
      `suggested_limit (${dieted.suggested_limit}) must be smaller than the failed array-cap (${ARRAY_MAX_ELEMENTS}). The whole point is it must be a tighter retry.`,
    ).toBe(true);

    expect(
      "body_excerpt" in dieted,
      "Safety-net wrapper must still carry body_excerpt for diagnostic visibility.",
    ).toBe(true);
  });

  test("safety-net wire size still fits the budget after the new fields are added", () => {
    const fixture = buildSafetyNetTriggerFixture(200);
    const dieted = dietIfOversize(fixture, SIZE_BUDGET);
    const wireSize = JSON.stringify(dieted)?.length ?? 0;
    expect(
      wireSize,
      `Safety-net total wire size was ${wireSize}; must fit the ${SIZE_BUDGET} budget.`,
    ).toBeLessThanOrEqual(SIZE_BUDGET);
  });

  test("when value is not array-shaped, suggested_limit is still defined (number or null), next_step still present", () => {
    // One huge string in a single-field object. Pass 1 truncates the string,
    // pass 2 cannot help (no array). May or may not hit safety-net depending
    // on pass-1 effect. If it does hit safety-net, the new fields must exist.
    const huge = "y".repeat(40_000);
    const fixture = { result: { blob: huge } };
    const dieted = dietIfOversize(fixture, SIZE_BUDGET) as Record<string, unknown>;

    // If diet brought it under budget via pass-1, no truncation marker.
    // If safety-net fired, the new fields must exist.
    if (dieted && (dieted as Record<string, unknown>).truncated === true) {
      expect(
        "next_step" in dieted,
        "AC3: when safety-net fires on non-array shape, next_step still required.",
      ).toBe(true);
      expect(
        "suggested_limit" in dieted,
        "AC3: when safety-net fires on non-array shape, suggested_limit still emitted (may be null).",
      ).toBe(true);
    }
  });
});
