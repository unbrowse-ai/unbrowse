import { describe, expect, it } from "bun:test";
import { marketplaceSkillMatchesContext } from "../src/orchestrator/index.js";

function skill(name: string, endpoints: Array<Record<string, unknown>>): any {
  return {
    skill_id: name,
    version: "1.0.0",
    schema_version: "1",
    lifecycle: "active",
    execution_type: "http",
    created_at: "2026-06-23T00:00:00.000Z",
    updated_at: "2026-06-23T00:00:00.000Z",
    name,
    intent_signature: name,
    domain: "api.github.com",
    description: `API skill for ${name}`,
    owner_type: "agent",
    endpoints,
    intents: ["fetch"],
    index_status: "ok",
  };
}

function ep(id: string, urlTemplate: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    endpoint_id: id,
    method: "GET",
    url_template: urlTemplate,
    idempotency: "safe",
    verification_status: "verified",
    reliability_score: 0.9,
    description: `endpoint ${id}`,
    ...extra,
  };
}

describe("marketplaceSkillMatchesContext concrete-path coherence", () => {
  it("rejects a broad same-host skill when no endpoint is path-coherent with /zen", () => {
    // Broad github skill: api-like endpoints, but none matching /zen.
    const githubBroadSkill = skill("github-copilot-broad", [
      ep("repos", "https://api.github.com/repos/{owner}/{repo}", { response_schema: { type: "object" } }),
      ep("issues", "https://api.github.com/repos/{owner}/{repo}/issues", { response_schema: { type: "object" } }),
    ]);
    expect(
      marketplaceSkillMatchesContext(githubBroadSkill, "fetch the zen quote", "https://api.github.com/zen"),
    ).toBe(false);
  });

  it("admits a skill whose endpoint template literally matches /zen", () => {
    const zenSkill = skill("github-zen", [ep("zen", "https://api.github.com/zen")]);
    expect(
      marketplaceSkillMatchesContext(zenSkill, "fetch the zen quote", "https://api.github.com/zen"),
    ).toBe(true);
  });

  it("admits a skill whose /users/{name} template is coherent with /users/octocat", () => {
    const usersSkill = skill("github-users", [
      ep("user", "https://api.github.com/users/{name}", { response_schema: { type: "object" } }),
    ]);
    expect(
      marketplaceSkillMatchesContext(usersSkill, "get user details", "https://api.github.com/users/octocat"),
    ).toBe(true);
  });

  it("rejects a /users/{name} template against a concrete /zen path (hole arity differs)", () => {
    const usersSkill = skill("github-users", [
      ep("user", "https://api.github.com/users/{name}", { response_schema: { type: "object" } }),
    ]);
    expect(
      marketplaceSkillMatchesContext(usersSkill, "fetch the zen quote", "https://api.github.com/zen"),
    ).toBe(false);
  });

  it("still admits any same-host skill for a root URL (no concrete path, no regression)", () => {
    const githubBroadSkill = skill("github-copilot-broad", [
      ep("repos", "https://api.github.com/repos/{owner}/{repo}", { response_schema: { type: "object" } }),
    ]);
    expect(
      marketplaceSkillMatchesContext(githubBroadSkill, "fetch the zen quote", "https://api.github.com/"),
    ).toBe(true);
  });

  it("still admits a listing-leaf URL like /search (no regression)", () => {
    const githubBroadSkill = skill("github-search", [
      ep("repos", "https://github.com/{owner}/{repo}"),
    ]);
    // host differs from endpoints; origin gate would reject. Use same-host search.
    const sameHost = skill("github-search", [ep("anything", "https://github.com/explore")]);
    expect(
      marketplaceSkillMatchesContext(sameHost, "fetch search results", "https://github.com/search"),
    ).toBe(true);
  });
});
