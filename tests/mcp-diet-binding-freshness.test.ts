// Day 4 (Luminaries) Worker 1 — AC3 freshness-survival contract pin.
//
// This test pins three falsifiable invariants on `dietIfOversize` for the
// new `OperationBinding` freshness fields (`ttl_ms`, `single_use`,
// `observed_at`) — see src/types/skill.ts:87-101 (commit 34779c22).
//
// Pin 1: pass-1 (truncateOversizeStrings) + pass-2 (capOversizeArrays)
//   leave scalar freshness fields untouched on fits-in-budget fixtures.
// Pin 2: the safety-net wrapper at src/mcp.ts:786-807 still carries the
//   `suggested_limit` + `next_step` hint fields (regression-pin from
//   main-branch commit 01a06867; NOT YET ON jl/default — this test
//   intentionally FAILS until that fix lands here). Plus the body_excerpt,
//   when non-empty, must contain at least one of the freshness field
//   NAMES — a diet that strategically stripped them would falsify this.
// Pin 3: type-identity round-trip — a fits-in-budget projection can be
//   cast back to `Array<{ semantic?: { provides?: OperationBinding[] } }>`
//   with freshness fields readable in their declared scalar types.
//
// Fixture pattern mirrors tests/mcp-payload-projection.test.ts:25
// (buildFatItemsFixture) so this slots into the existing diet test family.

import { describe, expect, test } from "bun:test";
import { dietIfOversize } from "../src/mcp.js";
import type { OperationBinding } from "../src/types/skill.js";

const WIRE_BUDGET_CHARS = 25_000;

// Deterministic freshness values so any field-stripping diet falsifies
// the equality check (vs. tolerating drift from a randomized fixture).
const FRESHNESS_TTL_MS = 600_000;
const FRESHNESS_SINGLE_USE = false;
const FRESHNESS_OBSERVED_AT = "2026-05-15T09:00:00.000Z";

// Binding key names vary so a reader (and the body_excerpt key-name
// check) can grep them. None of these strings exceed 2000 chars so
// pass-1's per-string truncation cannot rewrite them.
const BINDING_KEY_NAMES = ["csrf_token", "session_id", "access_token", "cursor"] as const;

type FixtureEndpoint = {
  endpoint_id: string;
  method: string;
  url_template: string;
  description?: string;
  semantic?: {
    action_kind: string;
    resource_kind: string;
    provides?: OperationBinding[];
  };
};

type FixtureSkill = {
  skill_id: string;
  version: string;
  endpoints: FixtureEndpoint[];
};

function buildSkillWithFreshnessBindings(opts: {
  endpointCount: number;
  bindingsPerEndpoint: number;
  fillerCharsPerEndpoint?: number;
}): FixtureSkill {
  const { endpointCount, bindingsPerEndpoint, fillerCharsPerEndpoint = 0 } = opts;
  const endpoints: FixtureEndpoint[] = [];
  for (let i = 0; i < endpointCount; i++) {
    const provides: OperationBinding[] = [];
    for (let b = 0; b < bindingsPerEndpoint; b++) {
      const keyName = BINDING_KEY_NAMES[b % BINDING_KEY_NAMES.length];
      provides.push({
        key: `${keyName}_${i}_${b}`,
        description: `Binding ${b} provided by endpoint ${i}`,
        type: "string",
        semantic_type: keyName,
        required: false,
        source: "response_header",
        example_value: `eg-${i}-${b}`,
        // The fields under test:
        ttl_ms: FRESHNESS_TTL_MS,
        single_use: FRESHNESS_SINGLE_USE,
        observed_at: FRESHNESS_OBSERVED_AT,
      });
    }
    endpoints.push({
      endpoint_id: `ep_${i}`,
      method: "GET",
      url_template: `https://example.test/api/resource/${i}`,
      description:
        fillerCharsPerEndpoint > 0
          ? "filler:" + "x".repeat(fillerCharsPerEndpoint)
          : `endpoint ${i}`,
      semantic: {
        action_kind: "read",
        resource_kind: "resource",
        provides,
      },
    });
  }
  return {
    skill_id: "freshness-fixture",
    version: "1.0.0",
    endpoints,
  };
}

function pickBinding(fixture: FixtureSkill, endpointIdx: number, bindingIdx: number): OperationBinding {
  const ep = fixture.endpoints[endpointIdx];
  expect(ep, "Fixture endpoint missing").toBeDefined();
  const binding = ep.semantic?.provides?.[bindingIdx];
  expect(binding, "Fixture binding missing").toBeDefined();
  return binding as OperationBinding;
}

describe("MCP diet preserves OperationBinding freshness fields (AC3)", () => {
  test("freshness fields survive pass-1 and pass-2 on a fits-in-budget fixture (10 endpoints x 3 bindings)", () => {
    const fixture = buildSkillWithFreshnessBindings({
      endpointCount: 10,
      bindingsPerEndpoint: 3,
    });

    const initialSize = JSON.stringify(fixture).length;
    expect(
      initialSize,
      `Small fixture must fit under ${WIRE_BUDGET_CHARS}-char budget (so we test pass-1+pass-2 untouched-survival, not safety-net). Got ${initialSize}.`,
    ).toBeLessThan(WIRE_BUDGET_CHARS);

    const dieted = dietIfOversize(fixture) as FixtureSkill;

    // Random sample within deterministic range — every binding is identical
    // by construction, so any sample falsifies a per-field stripping diet.
    const sample = pickBinding(dieted, 4, 1);

    expect(
      sample.ttl_ms,
      "Pass-1+pass-2 must preserve OperationBinding.ttl_ms verbatim (number).",
    ).toBe(FRESHNESS_TTL_MS);
    expect(
      sample.single_use,
      "Pass-1+pass-2 must preserve OperationBinding.single_use verbatim (boolean).",
    ).toBe(FRESHNESS_SINGLE_USE);
    expect(
      sample.observed_at,
      "Pass-1+pass-2 must preserve OperationBinding.observed_at verbatim (ISO string).",
    ).toBe(FRESHNESS_OBSERVED_AT);
  });

  test("freshness fields survive into safety-net body_excerpt (200 endpoints x 5 bindings + filler)", () => {
    const fixture = buildSkillWithFreshnessBindings({
      endpointCount: 200,
      bindingsPerEndpoint: 5,
      fillerCharsPerEndpoint: 500, // bulks every endpoint past array-cap rescue
    });

    const initialSize = JSON.stringify(fixture).length;
    expect(
      initialSize,
      `Large fixture must exceed budget (so the safety-net branch fires, not pass-1/pass-2). Got ${initialSize}.`,
    ).toBeGreaterThan(WIRE_BUDGET_CHARS);

    const dieted = dietIfOversize(fixture) as {
      truncated: boolean;
      reason: string;
      budget_chars: number;
      original_chars: number;
      suggested_limit?: number;
      next_step?: string;
      body_excerpt: string;
    };

    expect(
      dieted.truncated,
      "Safety-net wrapper must signal truncation=true so the agent knows the body was capped.",
    ).toBe(true);
    expect(
      dieted.reason,
      "Safety-net wrapper reason must match the documented constant.",
    ).toBe("payload_exceeded_wire_budget_after_diet");

    // Regression pin from main-branch commit 01a06867 (NOT YET on jl/default).
    // These assertions FAIL until that fix is cherry-picked here.
    expect(
      typeof dieted.suggested_limit,
      "Safety-net wrapper must carry `suggested_limit:number` so the agent has a concrete retry value (commit 01a06867).",
    ).toBe("number");
    expect(
      (dieted.suggested_limit ?? 0) > 0,
      `Safety-net suggested_limit must be a positive number; got ${dieted.suggested_limit}.`,
    ).toBe(true);
    expect(
      typeof dieted.next_step,
      "Safety-net wrapper must carry `next_step:string` so the agent has a concrete recovery instruction (commit 01a06867).",
    ).toBe("string");
    expect(
      (dieted.next_step ?? "").length > 0,
      "Safety-net next_step must be a non-empty string.",
    ).toBe(true);

    // Soft check: if the body_excerpt is non-empty, the JSON-prefix slice
    // should naturally carry at least one freshness field name. A diet
    // implementation that explicitly stripped them at JSON-serialize time
    // would falsify this; the current implementation does not.
    if (dieted.body_excerpt.length > 0) {
      const carriesFreshnessName =
        dieted.body_excerpt.includes("ttl_ms") ||
        dieted.body_excerpt.includes("single_use") ||
        dieted.body_excerpt.includes("observed_at");
      expect(
        carriesFreshnessName,
        "Safety-net body_excerpt is non-empty but contains none of `ttl_ms`/`single_use`/`observed_at`. A diet that strategically truncated AT the freshness fields would falsify this. Expected at least one field-name JSON key in the prefix slice.",
      ).toBe(true);
    }
  });

  test("safety-net wire size still fits the 25KB budget with the new fields present", () => {
    const fixture = buildSkillWithFreshnessBindings({
      endpointCount: 200,
      bindingsPerEndpoint: 5,
      fillerCharsPerEndpoint: 500,
    });

    const dieted = dietIfOversize(fixture);
    const wireSize = JSON.stringify(dieted)?.length ?? 0;

    expect(
      wireSize,
      `Safety-net output was ${wireSize} chars; even with the new suggested_limit + next_step + body_excerpt fields it must still fit the ${WIRE_BUDGET_CHARS}-char wire budget. The diet must never ship oversize.`,
    ).toBeLessThanOrEqual(WIRE_BUDGET_CHARS);
  });

  test("type-identity: fits-in-budget projection casts back to OperationBinding[] with scalar field types intact", () => {
    const fixture = buildSkillWithFreshnessBindings({
      endpointCount: 10,
      bindingsPerEndpoint: 3,
    });

    const dieted = dietIfOversize(fixture) as Array<unknown> extends never
      ? never
      : { endpoints: Array<{ semantic?: { provides?: OperationBinding[] } }> };

    const provides = dieted.endpoints[0]?.semantic?.provides;
    expect(
      Array.isArray(provides),
      "Type-identity: endpoints[0].semantic.provides must round-trip as an array of OperationBinding.",
    ).toBe(true);

    const first = provides?.[0];
    expect(first, "First binding must exist after diet.").toBeDefined();
    expect(
      typeof first?.ttl_ms,
      "Type-identity: OperationBinding.ttl_ms must read back as `number`.",
    ).toBe("number");
    expect(
      typeof first?.single_use,
      "Type-identity: OperationBinding.single_use must read back as `boolean`.",
    ).toBe("boolean");
    expect(
      typeof first?.observed_at,
      "Type-identity: OperationBinding.observed_at must read back as `string`.",
    ).toBe("string");
  });
});
