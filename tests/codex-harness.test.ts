import { describe, expect, it } from "bun:test";
import { buildAgentExecuteCliArgs, deriveEndpointSignals, fallbackEndpointOrder, normalizeHarnessCases } from "../evals/codex-harness-lib.js";

describe("codex harness helpers", () => {
  it("pushes page artifacts behind schema-backed endpoints in fallback ordering", () => {
    const ordered = fallbackEndpointOrder([
      { endpoint_id: "page", score: 500, url: "https://discord.com/channels/@me" },
      { endpoint_id: "guilds", score: 100, url: "https://discord.com/api/v9/users/@me/guilds", schema_summary: { id: "string" } },
      { endpoint_id: "referrals", score: 200, url: "https://discord.com/api/v9/users/@me/referrals/eligibility", schema_summary: { message: "string" } },
    ]);

    expect(ordered.indexOf("page")).toBeGreaterThan(ordered.indexOf("guilds"));
    expect(ordered.indexOf("page")).toBeGreaterThan(ordered.indexOf("referrals"));
  });

  it("prefers replay and api endpoints over page artifacts even when the page has schema", () => {
    const ordered = fallbackEndpointOrder([
      {
        endpoint_id: "page",
        score: 453.3,
        url: "https://github.com",
        trigger_url: "https://github.com",
        schema_summary: { full_name: "string", url: "string" },
        description: "Captured page artifact for search repositories",
      } as any,
      {
        endpoint_id: "search",
        score: 322.1,
        url: "https://api.github.com/search/repositories?q={q}",
        trigger_url: "https://github.com/search?q=openai&type=repositories",
        schema_summary: { items: [] },
        description: "Structured replay for search repositories",
      } as any,
      {
        endpoint_id: "doc",
        score: 360.7,
        url: "https://gitlab.com/explore/projects?name=openai",
        trigger_url: "https://gitlab.com/explore/projects?name=openai",
        schema_summary: { id: "integer", name: "string" },
        description: "Canonical document replay for search projects",
      } as any,
    ]);

    expect(ordered[0]).toBe("search");
    expect(ordered[1]).toBe("doc");
    expect(ordered[2]).toBe("page");
  });

  it("normalizes case files from array or {cases}", () => {
    const normalized = normalizeHarnessCases({
      cases: [
        {
          name: "discord-servers",
          intent: "list my discord servers",
          url: "https://discord.com/channels/@me",
          validate: { expected_fields: ["id", "name"], require_auth: true },
        },
      ],
    });

    expect(normalized).toEqual([{
      id: "discord-servers",
      intent: "list my discord servers",
      url: "https://discord.com/channels/@me",
      auth: "discord.com",
      expected_fields: ["id", "name"],
    }]);
  });

  it("preserves explicit params for query-seeded cases", () => {
    const normalized = normalizeHarnessCases({
      cases: [
        {
          id: "hn-search-param-seeded",
          intent: "search hacker news",
          url: "https://hn.algolia.com/",
          params: { q: "openai" },
          expected_fields: ["title"],
        },
      ],
    });

    expect(normalized).toEqual([{
      id: "hn-search-param-seeded",
      intent: "search hacker news",
      url: "https://hn.algolia.com/",
      params: { q: "openai" },
      expected_fields: ["title"],
    }]);
  });

  it("builds explicit agent execute args for deferred review", () => {
    expect(buildAgentExecuteCliArgs("skill-1", "endpoint-1", {
      intent: "search hacker news",
      url: "https://hn.algolia.com/",
      params: { q: "openai" },
    })).toEqual([
      "bun",
      "src/cli.ts",
      "execute",
      "--skill",
      "skill-1",
      "--endpoint",
      "endpoint-1",
      "--intent",
      "search hacker news",
      "--url",
      "https://hn.algolia.com/",
      "--params",
      "{\"q\":\"openai\"}",
      "--raw",
    ]);
  });

  it("adds compact review signals for shortlist judging", () => {
    expect(deriveEndpointSignals({
      endpoint_id: "search",
      url: "https://hn.algolia.com/api/v1/search?query={q}&tags=story",
      trigger_url: "https://hn.algolia.com/",
      schema_summary: { hits: [] },
      description: "Structured replay for search hacker news",
    })).toEqual([
      "schema",
      "templated_url",
      "trigger_url",
      "structured_replay",
      "api_like",
    ]);

    expect(deriveEndpointSignals({
      endpoint_id: "page",
      url: "https://x.com/search?q=openai&src=typed_query",
      description: "Captured page artifact for search tweets",
    })).toEqual([
      "concrete_url",
      "page_artifact_risk",
    ]);
  });
});
