import { describe, expect, it } from "bun:test";
import {
  buildAgentExecuteCliArgs,
  deriveEndpointSignals,
  endpointMatchesExpectation,
  evaluateRetrievalExpectation,
  fallbackEndpointOrder,
  normalizeHarnessCases,
} from "../evals/codex-harness-lib.js";

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

  it("keeps a high-confidence page artifact ahead of third-party negative-score adtech", () => {
    const ordered = fallbackEndpointOrder([
      {
        endpoint_id: "page",
        score: 492,
        url: "https://www.allrecipes.com/search?q={q}",
        trigger_url: "https://www.allrecipes.com/search?q=lasagna",
        schema_summary: { title: "string", url: "string", rating: "string" },
        description: "Captured page artifact for search recipes",
      } as any,
      {
        endpoint_id: "dv",
        score: -21.6,
        url: "https://pub.doubleverify.com/dvtag/signals/vlp/pub.json?ctx={ctx}&url={url}",
        trigger_url: "https://www.allrecipes.com/search?q=lasagna",
        schema_summary: { VLP: "array", TVP: "array" },
        description: "Returns resource details with vlp and tvp",
      } as any,
    ]);

    expect(ordered[0]).toBe("page");
    expect(ordered[1]).toBe("dv");
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

  it("normalizes auth metadata and richer validation options", () => {
    const normalized = normalizeHarnessCases({
      cases: [
        {
          id: "notes-create",
          intent: "create note",
          url: "https://practice.expandtesting.com/notes/app",
          auth: {
            domain: "practice.expandtesting.com",
            persona: "qa-user",
            role: "editor",
            session: "primary",
          },
          params: { title: "hello", description: "world" },
          expected_fields: ["id", "title", "description"],
          validate: {
            entity_type: "document",
            min_rows: 1,
            side_effect: "created",
            echo_params: ["title", "description"],
            terminal_ok: ["pass", "blocked"],
            retrieval: {
              max_rank: 2,
              any_of: [
                {
                  url_includes: ["/notes/app"],
                  required_signals: ["concrete_url"],
                },
              ],
            },
            selection: {
              any_of: [
                {
                  url_includes: ["/notes/app"],
                  forbidden_signals: ["tracking_or_adtech"],
                },
              ],
            },
          },
        },
      ],
    });

    expect(normalized).toEqual([{
      id: "notes-create",
      intent: "create note",
      url: "https://practice.expandtesting.com/notes/app",
      auth: "practice.expandtesting.com",
      auth_context: {
        domain: "practice.expandtesting.com",
        persona: "qa-user",
        role: "editor",
        session: "primary",
      },
      params: { title: "hello", description: "world" },
      expected_fields: ["id", "title", "description"],
      validate: {
        entity_type: "document",
        min_rows: 1,
        side_effect: "created",
        echo_params: ["title", "description"],
        terminal_ok: ["pass", "blocked"],
        retrieval: {
          max_rank: 2,
          any_of: [
            {
              url_includes: ["/notes/app"],
              required_signals: ["concrete_url"],
            },
          ],
        },
        selection: {
          any_of: [
            {
              url_includes: ["/notes/app"],
              forbidden_signals: ["tracking_or_adtech"],
            },
          ],
        },
      },
    }]);
  });

  it("matches endpoint expectations against url, description, and signals", () => {
    expect(endpointMatchesExpectation({
      endpoint_id: "inventory",
      url: "https://www.saucedemo.com/inventory.html",
      trigger_url: "https://www.saucedemo.com/inventory.html",
      description: "Captured page artifact for get products",
    }, {
      endpoint_id: "inventory",
      url_includes: ["/inventory.html"],
      description_includes: ["get products"],
      required_signals: ["concrete_url", "page_artifact_risk"],
      forbidden_signals: ["tracking_or_adtech"],
    })).toBe(true);
  });

  it("enforces retrieval expectations within a max rank window", () => {
    const retrieval = evaluateRetrievalExpectation([
      {
        endpoint_id: "people-search",
        url: "https://www.linkedin.com/search/results/people/?keywords={keywords}",
        description: "Captured page artifact for search people",
      },
      {
        endpoint_id: "feed-main",
        url: "https://www.linkedin.com/voyager/api/voyagerFeedDashMainFeed",
        description: "Structured replay for get feed posts",
      },
    ], {
      max_rank: 2,
      any_of: [
        {
          url_includes: ["voyagerFeedDashMainFeed"],
          required_signals: ["concrete_url"],
        },
      ],
    });

    expect(retrieval).toEqual({
      ok: true,
      reason: "retrieval_match",
      matched_rank: 2,
      matched_endpoint_id: "feed-main",
      max_rank: 2,
    });
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

    expect(deriveEndpointSignals({
      endpoint_id: "dv",
      url: "https://pub.doubleverify.com/dvtag/signals/vlp/pub.json?ctx={ctx}&url={url}",
      trigger_url: "https://www.allrecipes.com/search?q=lasagna",
      schema_summary: { VLP: [] },
      description: "Returns resource details with vlp and tvp",
    })).toEqual([
      "schema",
      "templated_url",
      "trigger_url",
      "api_like",
      "third_party",
      "tracking_or_adtech",
    ]);
  });
});
