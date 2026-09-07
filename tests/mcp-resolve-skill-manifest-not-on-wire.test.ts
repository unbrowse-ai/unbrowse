// The resolve MCP response must surface the DECLARED agent decision
// surface (the ranked shortlist available_endpoints + skill_id) and not
// serialize the full internal SkillManifest object onto the wire.
//
// Live regression (in-thread real MCP, 2026-05-16): unbrowse_resolve
// "search beatsaver for camellia" post-capture returned top_level_keys
// {result:16257, trace:377, source:13, skill:91468, timing:442,
// impact:265, available_endpoints:12485} — total 121389 vs 25000 wire
// budget. The 91KB `skill` subtree is the full manifest (every
// endpoint's schema+samples), redundant with the 12KB
// available_endpoints shortlist the agent actually picks from. The diet
// is string+array-only so a heavy OBJECT falls straight to the
// truncated-envelope safety net: the agent loses the shortlist entirely
// and gets {truncated:true} instead of endpoints to choose.
//
// resolveSkillId / executeResolvedEndpoint already consume skill.skill_id
// BEFORE maybePostProcessResult runs (mcp.ts:1327 vs 1334), and skill_id
// is also at result.result.skill_id, so the full manifest body is dead
// weight on the agent wire. Contract: when a resolve-shaped result
// carries BOTH the full manifest (skill.endpoints[]) AND the shortlist
// that supersedes it, the manifest is compacted to its identity so the
// response fits the budget and the agent still gets its shortlist.
//
// Real-runtime: direct call of the exported maybePostProcessResult (the
// actual code path the resolve handler uses, no mocks) — same pattern
// as mcp-diet-top-level-keys.test.ts which calls dietIfOversize directly.

import { describe, test, expect } from "bun:test";
import { maybePostProcessResult } from "../src/mcp.js";

const WIRE_BUDGET = 25_000;

// Resolve-shaped backend response mirroring the live top_level_keys:
// a top-level `skill` full manifest (heavy) sibling to the
// `available_endpoints` shortlist, `result` (carries skill_id), trace,
// timing, impact, source.
function buildResolveResponse() {
  const heavySkill = {
    skill_id: "4KAz1h6I9IwMhtsfUaWZy",
    name: "beatsaver.com",
    domain: "beatsaver.com",
    endpoints: Array.from({ length: 13 }, (_, i) => ({
      endpoint_id: `ep-${i}`,
      method: "GET",
      url_template: `https://beatsaver.com/api/route-${i}?q={q}`,
      response_schema: {
        type: "object",
        properties: Object.fromEntries(
          Array.from({ length: 60 }, (_, j) => [
            `field_${j}_with_padding_to_inflate_the_manifest`,
            { type: "string", inferred_from_samples: 3, format: "freeform" },
          ]),
        ),
      },
      semantic: {
        action_kind: "search",
        resource_kind: "page",
        description_in: "A moderately long description of the input contract",
        description_out: "A moderately long description of the output contract",
        example_response_compact: Object.fromEntries(
          Array.from({ length: 30 }, (_, j) => [
            `sample_key_${j}_with_padding`,
            `sample_value_${j}_with_some_more_padding_characters_here`,
          ]),
        ),
      },
    })),
  };
  return {
    result: {
      skill_id: "4KAz1h6I9IwMhtsfUaWZy",
      message: "Found 13 endpoint(s). Pick one and execute.",
    },
    trace: { trace_id: "t-1", success: false },
    source: "live-capture",
    skill: heavySkill,
    timing: { total_ms: 6432 },
    impact: { source: "live-capture" },
    available_endpoints: Array.from({ length: 13 }, (_, i) => ({
      endpoint_id: `ep-${i}`,
      score: 100 - i,
      url_template: `https://beatsaver.com/api/route-${i}?q={q}`,
      action_kind: "search",
    })),
  };
}

describe("resolve response: full skill manifest must not blow the wire budget", () => {
  test("oversize resolve with redundant skill manifest still returns the shortlist (not a truncated envelope)", () => {
    const resp = buildResolveResponse();
    // Sanity: the fixture must actually overshoot, like the live repro.
    expect(JSON.stringify(resp).length).toBeGreaterThan(WIRE_BUDGET);

    // Non-projected path (no path/extract/limit/schema args) — the exact
    // path that did `return dietIfOversize(result)` and truncated.
    const out = maybePostProcessResult(resp, {}) as Record<string, unknown>;

    // Pre-fix: out is { truncated:true, reason:"payload_exceeded_..." }
    // and the agent has lost its shortlist. Post-fix: the response fits
    // the budget AND still carries the ranked shortlist.
    expect(JSON.stringify(out).length).toBeLessThanOrEqual(WIRE_BUDGET);
    expect(out.truncated).not.toBe(true);

    const endpoints = (out.available_endpoints
      ?? (out.result as Record<string, unknown> | undefined)?.available_endpoints) as unknown;
    expect(Array.isArray(endpoints)).toBe(true);
    expect((endpoints as unknown[]).length).toBeGreaterThan(0);

    // skill_id must remain recoverable so the agent's next
    // unbrowse_execute call still works (result.result.skill_id and/or
    // the compacted skill identity).
    const skillNode = out.skill as Record<string, unknown> | undefined;
    const resultNode = out.result as Record<string, unknown> | undefined;
    const skillId =
      (skillNode && typeof skillNode.skill_id === "string" && skillNode.skill_id) ||
      (resultNode && typeof resultNode.skill_id === "string" && resultNode.skill_id);
    expect(skillId).toBe("4KAz1h6I9IwMhtsfUaWZy");

    // The dead-weight full manifest must not be on the wire: if `skill`
    // survives it must be compact (no full endpoints[] array).
    if (skillNode && "endpoints" in skillNode) {
      expect(Array.isArray(skillNode.endpoints)).toBe(false);
    }
  });

  test("scoping guard: oversize WITHOUT a redundant manifest still diets normally (diet primitive untouched)", () => {
    // No `skill` manifest, no shortlist — a generic oversize object.
    // This must still hit the diet safety-net (we only special-case the
    // redundant-manifest shape, we did not disable the diet).
    const bulky = {
      result: Object.fromEntries(
        Array.from({ length: 4000 }, (_, i) => [
          `k_${i}_padded_key_name`,
          `v_${i}_padded_value_to_inflate_well_past_the_wire_budget`,
        ]),
      ),
    };
    expect(JSON.stringify(bulky).length).toBeGreaterThan(WIRE_BUDGET);
    const out = maybePostProcessResult(bulky, {}) as Record<string, unknown>;
    expect(JSON.stringify(out).length).toBeLessThanOrEqual(WIRE_BUDGET);
    expect(out.truncated).toBe(true);
    expect(out.reason).toBe("payload_exceeded_wire_budget_after_diet");
  });
});
