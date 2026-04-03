import { describe, expect, it } from "bun:test";
import { getRegistrySkillHref, parseSearchMetadata } from "../frontend/src/lib/registry-search";
import type { SkillManifest } from "../frontend/src/lib/api";

const liveSkill: SkillManifest = {
  skill_id: "live-skill",
  version: "1.0.0",
  name: "Live skill",
  intent_signature: "get live data",
  domain: "example.com",
  description: "Live registry skill",
  owner_type: "marketplace",
  execution_type: "http",
  endpoints: [],
  lifecycle: "active",
  created_at: "2026-04-03T00:00:00.000Z",
  updated_at: "2026-04-03T00:00:00.000Z",
};

describe("registry search links", () => {
  it("links only live registry skills", () => {
    expect(
      getRegistrySkillHref(
        { content: JSON.stringify({ skill_id: liveSkill.skill_id }) },
        [liveSkill],
      ),
    ).toBe(`/skills/${liveSkill.skill_id}`);

    expect(
      getRegistrySkillHref(
        { content: JSON.stringify({ skill_id: "stale-skill" }) },
        [liveSkill],
      ),
    ).toBeNull();
  });

  it("parses malformed metadata safely", () => {
    expect(parseSearchMetadata({ content: "{not-json" })).toEqual({});
    expect(parseSearchMetadata(undefined)).toEqual({});
  });
});
