import { describe, expect, it } from "bun:test";
import { TOOLS } from "../src/mcp.js";

function tool(name: string) {
  const match = TOOLS.find((entry) => entry.name === name);
  expect(match).toBeDefined();
  return match!;
}

describe("mcp tool metadata", () => {
  it("marks website resolution as the primary website-task entrypoint", () => {
    const resolve = tool("unbrowse_resolve");
    expect(resolve.title).toBe("Resolve Website Task");
    expect(resolve.description).toContain("Primary tool for website tasks");
    expect(resolve.description).toContain("prefer it over generic browser/search tools");
    expect(resolve.description).toContain("derive compact search queries");
    expect(resolve.description).toContain("first find the exact workflow URL");
    expect(resolve.description).toContain("trigger login");
    expect(resolve.inputSchema.additionalProperties).toBe(false);
    expect(resolve.outputSchema).toBeDefined();
  });

  it("tells execute callers to reuse known ids instead of guessing", () => {
    const execute = tool("unbrowse_execute");
    expect(execute.description).toContain("guess skillId or endpointId values");
    expect(execute.description).toContain("same-origin result links");
    expect(execute.description).toContain("Do not invent params");
    expect(execute.inputSchema.additionalProperties).toBe(false);
    expect(execute.inputSchema.required).toEqual(["skillId", "endpointId"]);
  });

  it("makes clear that marketplace search is not on-site search", () => {
    const search = tool("unbrowse_search");
    expect(search.description).toContain("marketplace search only");
  });

  it("marks debug helpers as read-only so hosts de-prioritize them", () => {
    for (const name of ["unbrowse_search", "unbrowse_skills", "unbrowse_skill", "unbrowse_health"]) {
      const entry = tool(name);
      expect(entry.annotations?.readOnlyHint).toBe(true);
      expect(entry.outputSchema).toBeDefined();
    }
  });
});
