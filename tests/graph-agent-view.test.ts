import { describe, expect, it } from "bun:test";
import { getSkillChunk, toAgentSkillChunkView } from "../src/graph/index.js";
import { buildLocalHarnessFixtures } from "../src/graph/local-fixtures.js";

describe("agent skill chunk view", () => {
  const { skills } = buildLocalHarnessFixtures();
  const discord = skills.find((skill) => skill.skill_id === "fixture-discord");
  const htmlForm = skills.find((skill) => skill.skill_id === "fixture-form-html");

  it("shows only runnable operations before dependencies are satisfied", () => {
    if (!discord) throw new Error("fixture-discord missing");
    const raw = getSkillChunk(discord, { intent: "get guild channels", known_bindings: {} });
    const view = toAgentSkillChunkView(raw);

    expect(view.available_operations.map((operation) => operation.operation_id)).toEqual(["discord-guilds"]);
    expect(view.suggested_next_operation_id).toBe("discord-guilds");
    expect(view.missing_bindings).toEqual(["guild_id", "channel_id"]);
    expect(view.available_operations[0]?.title).toBe("list guild");
    expect(view.available_operations[0]?.yields).toContain("guild_id");
  });

  it("promotes the dependent operation once its binding is known", () => {
    if (!discord) throw new Error("fixture-discord missing");
    const raw = getSkillChunk(discord, {
      intent: "get guild channels",
      known_bindings: { guild_id: "g1" },
    });
    const view = toAgentSkillChunkView(raw);

    expect(view.available_operations.map((operation) => operation.operation_id)).toEqual([
      "discord-channels",
      "discord-guilds",
    ]);
    expect(view.suggested_next_operation_id).toBe("discord-channels");
    expect(view.missing_bindings).toEqual(["channel_id"]);
    expect(view.available_operations[0]?.requires).toEqual(["guild_id"]);
    expect(view.available_operations[0]?.yields).toContain("channel_id");
  });

  it("surfaces DOM form nodes as runnable providers before downstream api calls", () => {
    if (!htmlForm) throw new Error("fixture-form-html missing");
    const raw = getSkillChunk(htmlForm, { intent: "search jobs", known_bindings: {} });
    const view = toAgentSkillChunkView(raw);

    expect(view.available_operations.map((operation) => operation.operation_id)).toEqual(["jobs-form-options"]);
    expect(view.available_operations[0]?.yields).toContain("department");
    expect(view.available_operations[0]?.yields).toContain("location");
    expect(view.missing_bindings).toEqual(["department", "location", "job_id"]);
  });
});
