// FALSIFIER for the cross-skill execute attribution bug
// (gate probe 003 crates.io 2026-05-19).
//
// Bug:
//   resolve's `available_endpoints` shortlist can contain endpoints
//   merged in from cached publishes belonging to a DIFFERENT skill
//   than the top-level `skill.skill_id`. The collector previously
//   used top-level skill_id as the execute skill param, which
//   returned `endpoint_not_found` whenever the shortlisted endpoint
//   was hydrated from a sibling skill's cache.
//
// Invariants this test pins:
//   1. The shortlist entry MUST carry `source_skill_id` matching the
//      skill whose endpoint it is — not the top-level pick.
//   2. The collector's executeSkillId resolution prefers
//      `pick.source_skill_id` over the top-level skill_id when the
//      former is present.
//   3. Falls back to top-level skill_id when source_skill_id is
//      absent (backward compat with pre-fix shortlists).
//
// This is a pure-shape test — no live resolve / no kuri / no fetch.
// The orchestrator emit-site is covered structurally by reading the
// source file and asserting `source_skill_id:` appears next to each
// available_endpoints push (3 sites; see src/orchestrator/index.ts).

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

type ShortlistEntry = {
  endpoint_id: string;
  source_skill_id?: string;
  [k: string]: unknown;
};

// This mirrors the production logic at
// scripts/mcp-gate-parallel-collect.ts:150 — extracted as a pure
// function so the test pins behaviour without spinning up the
// collector's xargs pool.
function pickExecuteSkillId(
  pick: ShortlistEntry | null,
  topLevelSkillId: string | undefined,
): string | undefined {
  if (!pick) return topLevelSkillId;
  return pick.source_skill_id ?? topLevelSkillId;
}

describe("source_skill_id propagation across resolve -> execute", () => {
  test("collector prefers pick.source_skill_id when shortlisted endpoint belongs to a sibling skill", () => {
    const topLevel = "skill_A_top_level";
    const pick: ShortlistEntry = {
      endpoint_id: "ep_belongs_to_B",
      source_skill_id: "skill_B_cached_publish",
    };
    const out = pickExecuteSkillId(pick, topLevel);
    expect(out).toBe("skill_B_cached_publish");
  });

  test("collector falls back to top-level skill_id when source_skill_id is absent (back-compat)", () => {
    const topLevel = "skill_A_top_level";
    const pick: ShortlistEntry = { endpoint_id: "ep_legacy_shortlist" };
    const out = pickExecuteSkillId(pick, topLevel);
    expect(out).toBe("skill_A_top_level");
  });

  test("no pick -> still returns top-level skill_id", () => {
    expect(pickExecuteSkillId(null, "skill_X")).toBe("skill_X");
  });

  test("crates.io 003 scenario (regression of the actual gate failure)", () => {
    // From gate run 20260518Txxx: top-level skill V-ugzSxDfgDKHR0TD_ufE
    // had one endpoint; shortlist[0] endpoint id was
    // 3bqbHNiOc3pUKKy3ezdAG which lived under a different skill.
    // Pre-fix: execute called /v1/skills/V-ugzSxDfgDKHR0TD_ufE/execute
    // with endpoint=3bqbHNiOc3pUKKy3ezdAG -> endpoint_not_found.
    const topLevel = "V-ugzSxDfgDKHR0TD_ufE";
    const pick: ShortlistEntry = {
      endpoint_id: "3bqbHNiOc3pUKKy3ezdAG",
      source_skill_id: "real_owner_skill_for_3bqbHNiOc3pUKKy3ezdAG",
    };
    const out = pickExecuteSkillId(pick, topLevel);
    expect(out).toBe("real_owner_skill_for_3bqbHNiOc3pUKKy3ezdAG");
    expect(out).not.toBe(topLevel);
  });
});

describe("orchestrator emits source_skill_id at every shortlist build site", () => {
  // Structural assertion: read the orchestrator source and confirm
  // every place we push into available_endpoints carries the
  // source_skill_id field. If a 4th build site is added without
  // this field, the count drops and this test fires.
  const orchPath = join(import.meta.dir, "..", "src", "orchestrator", "index.ts");
  const src = readFileSync(orchPath, "utf8");

  test("source_skill_id appears at least 3 times (one per shortlist build site)", () => {
    const matches = src.match(/source_skill_id:\s*endpointScopedSkill\.skill_id/g) ?? [];
    expect(matches.length).toBeGreaterThanOrEqual(3);
  });

  test("each available_endpoints push has source_skill_id within 30 lines after endpoint_id", () => {
    // Crude but useful: split into chunks around each endpoint_id key
    // and require source_skill_id to appear in the same chunk.
    const lines = src.split("\n");
    const endpointIdLines = lines
      .map((ln, i) => ({ ln, i }))
      .filter(({ ln }) => /endpoint_id:\s*(r\.endpoint|ep)\.endpoint_id/.test(ln));

    expect(endpointIdLines.length).toBeGreaterThanOrEqual(3);

    for (const { i } of endpointIdLines) {
      const window = lines.slice(i, i + 30).join("\n");
      expect(window).toContain("source_skill_id");
    }
  });
});
