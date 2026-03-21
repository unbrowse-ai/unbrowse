import { describe, it, expect } from "bun:test";
import { buildArgs, toolParamsFromCall, TOOL_DEFINITIONS } from "../src/tools.js";

describe("TOOL_DEFINITIONS", () => {
  it("registers all 7 tools", () => {
    const names = Object.keys(TOOL_DEFINITIONS);
    expect(names).toEqual([
      "unbrowse_resolve",
      "unbrowse_search",
      "unbrowse_execute",
      "unbrowse_login",
      "unbrowse_skills",
      "unbrowse_skill",
      "unbrowse_health",
    ]);
  });

  it("each tool has description and inputSchema", () => {
    for (const def of Object.values(TOOL_DEFINITIONS)) {
      expect(typeof def.description).toBe("string");
      expect(def.inputSchema).toBeDefined();
      expect(def.inputSchema.type).toBe("object");
    }
  });
});

describe("buildArgs", () => {
  it("resolve builds correct args", () => {
    expect(buildArgs({ action: "resolve", intent: "get posts", url: "https://example.com" }))
      .toEqual(["resolve", "--intent", "get posts", "--url", "https://example.com"]);
  });

  it("resolve with optional flags", () => {
    expect(buildArgs({ action: "resolve", intent: "x", url: "https://a.com", limit: 10, pretty: true, dryRun: true }))
      .toEqual(["resolve", "--intent", "x", "--url", "https://a.com", "--limit", "10", "--pretty", "--dry-run"]);
  });

  it("search builds correct args", () => {
    expect(buildArgs({ action: "search", intent: "weather", domain: "api.weather.com" }))
      .toEqual(["search", "--intent", "weather", "--domain", "api.weather.com"]);
  });

  it("execute builds correct args", () => {
    expect(buildArgs({ action: "execute", skillId: "s1", endpointId: "e1" }))
      .toEqual(["execute", "--skill", "s1", "--endpoint", "e1"]);
  });

  it("login builds correct args", () => {
    expect(buildArgs({ action: "login", url: "https://example.com/login" }))
      .toEqual(["login", "--url", "https://example.com/login"]);
  });

  it("skills returns simple command", () => {
    expect(buildArgs({ action: "skills" })).toEqual(["skills"]);
  });

  it("skill requires skillId", () => {
    expect(() => buildArgs({ action: "skill" })).toThrow("skillId required");
  });

  it("health returns simple command", () => {
    expect(buildArgs({ action: "health" })).toEqual(["health"]);
  });
});

describe("toolParamsFromCall", () => {
  it("maps unbrowse_resolve to resolve action", () => {
    const params = toolParamsFromCall("unbrowse_resolve", { intent: "get data", url: "https://x.com" });
    expect(params.action).toBe("resolve");
    expect(params.intent).toBe("get data");
    expect(params.url).toBe("https://x.com");
  });

  it("maps unbrowse_search to search action", () => {
    const params = toolParamsFromCall("unbrowse_search", { intent: "weather" });
    expect(params.action).toBe("search");
  });

  it("maps unbrowse_execute to execute action", () => {
    const params = toolParamsFromCall("unbrowse_execute", { skillId: "s", endpointId: "e" });
    expect(params.action).toBe("execute");
    expect(params.skillId).toBe("s");
  });

  it("maps unbrowse_health to health action", () => {
    const params = toolParamsFromCall("unbrowse_health", {});
    expect(params.action).toBe("health");
  });

  it("throws for unknown tool", () => {
    expect(() => toolParamsFromCall("unknown_tool", {})).toThrow("Unknown tool");
  });
});
