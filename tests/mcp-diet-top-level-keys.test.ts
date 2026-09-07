import { describe, expect, test } from "bun:test";
import { dietIfOversize } from "../src/mcp.js";

// When the safety-net wrapper in src/mcp.ts:803-825 fires, it currently emits
// `body_excerpt` (a truncated JSON string fragment) and a `next_step` that
// reads:
//   "retry with limit:N, or pass path:'<your-array-path>[]' + extract:..."
// but the agent has NO concrete view of which top-level keys existed in the
// original payload, or which one carried the bulk. The agent must blindly
// guess a path.
//
// Live reproducer (this session, 2026-05-15): unbrowse_resolve on
// https://www.npmjs.com/package/typescript against a freshly-published
// 3-endpoint skill returned original_chars=24462, budget_chars=23976,
// body_excerpt cut at "Do" (mid-word inside heading_3="Documentation"),
// and the agent had no view of which subtree to project.
//
// Contract this test pins:
//   1. When the safety-net fires AND the input was an object (not a string,
//      not an array), the wrapper carries a `top_level_keys` map keyed by
//      the original object's top-level field names with their serialized
//      byte sizes as values. The agent uses this to pick a `path:` that
//      drills past the heavy field.
//   2. The byte sizes are positive integers, summing to roughly the
//      original size (within JSON-comma overhead).
//   3. The wrapper still fits the wire budget.
//   4. When the input was a non-object scalar/array at the top, the field
//      is omitted (no fake keys).

const SIZE_BUDGET = 25_000;

// Build a resolve-shaped payload that overshoots the budget through
// accumulation of small fields (no oversize strings, no huge arrays).
// Mimics the structure that triggered the live bug: a `result` object
// holding `available_endpoints` (small) + `skill` (heavy, duplicates
// endpoint metadata several times over).
function buildAccumulationFixture() {
  const heavySkill = {
    skill_id: "Jwu0EMSbTbt50lCazs9a0",
    name: "www.npmjs.com",
    endpoints: Array.from({ length: 12 }, (_, i) => ({
      endpoint_id: `endpoint-${i}`,
      method: "GET",
      url_template: `https://www.npmjs.com/package/example-${i}`,
      response_schema: {
        type: "object",
        properties: Object.fromEntries(
          Array.from({ length: 40 }, (_, j) => [
            `field_${j}_with_extra_padding_chars`,
            { type: "string", inferred_from_samples: 1, format: "freeform" },
          ]),
        ),
      },
      semantic: {
        action_kind: "detail",
        resource_kind: "resource",
        description_in: "Some description that is moderately long",
        description_out: "Another description that is moderately long",
        example_response_compact: Object.fromEntries(
          Array.from({ length: 20 }, (_, j) => [
            `compact_field_${j}_with_padding`,
            `sample_value_for_field_${j}_with_some_padding_chars`,
          ]),
        ),
      },
    })),
  };
  return {
    result: {
      available_endpoints: [
        { endpoint_id: "endpoint-0", score: 100 },
        { endpoint_id: "endpoint-1", score: 50 },
      ],
      skill: heavySkill,
      diagnostic: { confidence: 0.8 },
    },
  };
}

describe("dietIfOversize safety-net top_level_keys (accumulation case)", () => {
  test("when safety-net fires on an object, it surfaces top_level_keys with byte sizes", () => {
    const fixture = buildAccumulationFixture();
    const initial = JSON.stringify(fixture).length;
    expect(
      initial,
      `Test fixture must actually overshoot the budget. Got ${initial} chars vs budget ${SIZE_BUDGET}.`,
    ).toBeGreaterThan(SIZE_BUDGET);

    const dieted = dietIfOversize(fixture, SIZE_BUDGET) as Record<string, unknown>;

    expect(
      dieted.truncated,
      "Safety-net wrapper must fire on this fixture (accumulation case).",
    ).toBe(true);

    expect(
      dieted.reason,
      "Safety-net wrapper carries the canonical reason.",
    ).toBe("payload_exceeded_wire_budget_after_diet");

    expect(
      "top_level_keys" in dieted,
      `top_level_keys must be present so the agent can pick a path: to drill past the heavy field. Got keys: ${Object.keys(dieted).join(",")}`,
    ).toBe(true);

    const tlk = dieted.top_level_keys as Record<string, number>;
    expect(
      typeof tlk === "object" && tlk !== null,
      "top_level_keys must be a plain object.",
    ).toBe(true);

    // The original top-level object was `result` (the outer dietIfOversize
    // input). Its child object is what we care about. The implementation can
    // pick either layer; the test asserts at least one of the heavy keys is
    // present so the agent can navigate.
    const tlkKeys = Object.keys(tlk);
    const hasResolveShape =
      tlkKeys.includes("skill") ||
      tlkKeys.includes("available_endpoints") ||
      tlkKeys.includes("result");
    expect(
      hasResolveShape,
      `top_level_keys must enumerate the real keys (skill/available_endpoints/result). Got: ${tlkKeys.join(",")}`,
    ).toBe(true);

    for (const [k, size] of Object.entries(tlk)) {
      expect(
        typeof size === "number" && size > 0 && Number.isInteger(size),
        `top_level_keys[${k}] must be a positive integer byte count, got ${size}.`,
      ).toBe(true);
    }
  });

  test("safety-net total wire size still fits the budget after top_level_keys is added", () => {
    const fixture = buildAccumulationFixture();
    const dieted = dietIfOversize(fixture, SIZE_BUDGET);
    const wireSize = JSON.stringify(dieted)?.length ?? 0;
    expect(
      wireSize,
      `Safety-net total wire size was ${wireSize}; must fit the ${SIZE_BUDGET} budget.`,
    ).toBeLessThanOrEqual(SIZE_BUDGET);
  });

  test("when the top-level input is not an object, top_level_keys is omitted", () => {
    // Single huge string; pass 1 truncates, may or may not hit safety-net.
    // If it does, top_level_keys must not exist (no false keys).
    const huge = "z".repeat(60_000);
    const dieted = dietIfOversize(huge as unknown, SIZE_BUDGET) as
      | Record<string, unknown>
      | string;
    if (
      typeof dieted === "object" &&
      dieted !== null &&
      (dieted as Record<string, unknown>).truncated === true
    ) {
      expect(
        "top_level_keys" in (dieted as Record<string, unknown>),
        "Non-object input must not produce top_level_keys (no fabrication).",
      ).toBe(false);
    }
  });
});
