import { describe, expect, it } from "bun:test";

import { listCanonicalSkillsFromDomainIndex } from "../src/services/skill-catalog.js";

describe("listCanonicalSkillsFromDomainIndex", () => {
  it("hydrates unique canonical skills from durable domain index entries", async () => {
    const skills = await listCanonicalSkillsFromDomainIndex(
      [
        { name: "domain-idx:alpha.example.com", value: "skill-alpha" },
        { name: "domain-idx:www.alpha.example.com", value: "skill-alpha" },
        { name: "domain-idx:beta.example.com", value: "skill-beta" },
      ],
      async (skillId) => {
        if (skillId === "skill-alpha") {
          return {
            skill_id: "skill-alpha",
            version: "1.0.0",
            schema_version: "1",
            name: "alpha.example.com",
            intent_signature: "alpha.example.com",
            domain: "alpha.example.com",
            description: "Alpha skill",
            owner_type: "agent",
            lifecycle: "active",
            created_at: "2026-03-24T00:00:00Z",
            updated_at: "2026-03-24T00:00:00Z",
            endpoints: [],
          } as any;
        }
        if (skillId === "skill-beta") {
          return {
            skill_id: "skill-beta",
            version: "1.0.0",
            schema_version: "1",
            name: "beta.example.com",
            intent_signature: "beta.example.com",
            domain: "beta.example.com",
            description: "Beta skill",
            owner_type: "agent",
            execution_type: "http",
            lifecycle: "active",
            created_at: "2026-03-24T00:00:00Z",
            updated_at: "2026-03-24T00:00:00Z",
            endpoints: [],
          } as any;
        }
        return null;
      },
    );

    expect(skills.map((skill) => skill.skill_id)).toEqual(["skill-alpha", "skill-beta"]);
    expect(skills[0]?.execution_type).toBe("http");
  });

  it("drops missing or malformed skill reads", async () => {
    const skills = await listCanonicalSkillsFromDomainIndex(
      [
        { name: "domain-idx:alpha.example.com", value: "skill-alpha" },
        { name: "domain-idx:broken.example.com", value: "skill-broken" },
        { name: "domain-idx:missing.example.com", value: "skill-missing" },
      ],
      async (skillId) => {
        if (skillId === "skill-alpha") {
          return {
            skill_id: "skill-alpha",
            version: "1.0.0",
            schema_version: "1",
            name: "alpha.example.com",
            intent_signature: "alpha.example.com",
            domain: "alpha.example.com",
            description: "Alpha skill",
            owner_type: "agent",
            execution_type: "http",
            lifecycle: "active",
            created_at: "2026-03-24T00:00:00Z",
            updated_at: "2026-03-24T00:00:00Z",
            endpoints: [],
          } as any;
        }
        return null;
      },
    );

    expect(skills.map((skill) => skill.skill_id)).toEqual(["skill-alpha"]);
  });
});
