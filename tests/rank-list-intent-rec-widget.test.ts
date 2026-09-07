// Positive-control regression: for a generic LIST_INTENT like "find shoes
// on carousell" or "search products on example", the ranker must NOT promote
// a personalization/widget endpoint above the canonical search surface. These
// probes pin the current ranker behavior so a future change doesn't regress
// it. The actual root-cause fix for the 2026-05-14 carousell session lives
// at the text-extraction layer (see tests/browse-markdown-structured-header.test.ts
// and src/extraction/index.ts:buildStructuredDataHeader) — the ranker side
// only matters when the agent re-resolves and executes the captured skill.

import { describe, expect, test } from "bun:test";
import { rankEndpoints } from "../src/client/rank-server-first";
import type { EndpointDescriptor } from "../src/types/index.js";

function ep(over: Partial<EndpointDescriptor>): EndpointDescriptor {
  return {
    endpoint_id: "ep",
    method: "GET",
    url_template: "https://www.carousell.sg/",
    description: "",
    idempotency: "safe",
    verification_status: "verified",
    reliability_score: 0.9,
    response_schema: { type: "object", properties: { data: { type: "object" } } },
    ...over,
  } as EndpointDescriptor;
}

describe("LIST_INTENT — rec-widget endpoints lose to canonical search surface", () => {
  test("carousell shoes: dropped_in_price rec widget ranks below /search/shoes", () => {
    const recWidget = ep({
      endpoint_id: "rec_widget",
      method: "GET",
      url_template: "https://www.carousell.sg/ds/field-data-proto/cf/rec/1.0/dropped_in_price/?_path={path}&country_id={country_id}&l={l}&responseType={responseType}",
      description: "Returns form status with session, counts, and ids",
      response_schema: {
        type: "object",
        properties: {
          data: {
            type: "object",
            properties: {
              session: { type: "string" },
              results: { type: "array", items: { type: "object" } },
            },
          },
        },
      },
    });
    const searchPage = ep({
      endpoint_id: "search_page",
      method: "GET",
      url_template: "https://www.carousell.sg/search/shoes",
      description: "Search results page for shoes",
      response_schema: {
        type: "object",
        properties: {
          "@context": { type: "string" },
          "@type": { type: "string" },
          itemListElement: { type: "array", items: { type: "object" } },
        },
      },
    });

    const ranked = rankEndpoints(
      [recWidget, searchPage],
      "find me shoes on carousell",
      "carousell.sg",
      "https://www.carousell.sg/search/shoes/",
    );

    expect(ranked.length).toBe(2);
    expect(ranked[0].endpoint.endpoint_id).toBe("search_page");
  });

  test("generic search intent: a 'recommended' XHR ranks below /search?q=", () => {
    const recXhr = ep({
      endpoint_id: "recs",
      url_template: "https://example.com/api/v1/recommendations/for_you?session={session}",
      description: "Personalized recommendations feed",
      response_schema: {
        type: "object",
        properties: {
          items: { type: "array", items: { type: "object" } },
        },
      },
    });
    const search = ep({
      endpoint_id: "search",
      url_template: "https://example.com/api/v1/search?q={q}",
      description: "Search products by keyword",
      response_schema: {
        type: "object",
        properties: {
          results: { type: "array", items: { type: "object" } },
        },
      },
    });

    const ranked = rankEndpoints(
      [recXhr, search],
      "search products on example",
      "example.com",
      "https://example.com/search?q=widgets",
    );

    expect(ranked.length).toBe(2);
    expect(ranked[0].endpoint.endpoint_id).toBe("search");
  });

  test("real structured search API ranks above fallback page_fetch", () => {
    const apiSearch = ep({
      endpoint_id: "crates_api_search",
      url_template: "https://crates.io/api/v1/crates?page={page}&per_page={per_page}&sort={sort}&q={q}",
      description: "Searches Crates with crates, meta using page, per_page, sort, q",
      response_schema: {
        type: "object",
        properties: {
          crates: { type: "array", items: { type: "object" } },
          meta: { type: "object" },
        },
      },
      query: { page: "1", per_page: "10", sort: "relevance", q: "tokio" },
    });
    const pageFetch = ep({
      endpoint_id: "page_fetch",
      url_template: "https://crates.io/search?q={q}",
      description: "Returns the rendered HTML for \"search rust crates\"",
      response_schema: { type: "string", format: "html" },
      dom_extraction: { extraction_method: "page_fetch", confidence: 0.5 },
    });

    const ranked = rankEndpoints(
      [pageFetch, apiSearch],
      "search rust crates",
      "crates.io",
      "https://crates.io/search?q=tokio",
    );

    expect(ranked.length).toBe(2);
    expect(ranked[0].endpoint.endpoint_id).toBe("crates_api_search");
  });

  test("real structured search API ranks above legacy rendered-html fallback", () => {
    const apiSearch = ep({
      endpoint_id: "crates_api_search",
      url_template: "https://crates.io/api/v1/crates?page={page}&per_page={per_page}&sort={sort}&q={q}",
      description: "Searches Crates with crates, meta using page, per_page, sort, q",
      response_schema: {
        type: "object",
        properties: {
          crates: { type: "array", items: { type: "object" } },
          meta: { type: "object" },
        },
      },
      query: { page: "1", per_page: "10", sort: "relevance", q: "tokio" },
    });
    const legacyPageFetch = ep({
      endpoint_id: "legacy_page_fetch",
      url_template: "https://crates.io/search?q={q}",
      description: "Returns the rendered HTML for \"search rust crates\"",
      response_schema: { type: "string", format: "html" },
      dom_extraction: { extraction_method: "repeated-elements", confidence: 1 },
    });

    const ranked = rankEndpoints(
      [legacyPageFetch, apiSearch],
      "search rust crates",
      "crates.io",
      "https://crates.io/search?q=tokio",
    );

    expect(ranked[0].endpoint.endpoint_id).toBe("crates_api_search");
  });

  test("versioned public API ranks above page_fetch for tag retrieval", () => {
    const tagsApi = ep({
      endpoint_id: "docker_tags_api",
      url_template: "https://registry.hub.docker.com/v2/repositories/{namespace}/{repository}/tags?page_size={page_size}",
      path_params: { namespace: "library", repository: "nginx" },
      query: { page_size: "25" },
      description: "Public Docker Hub tags API for library/nginx",
      response_schema: {
        type: "object",
        properties: {
          results: {
            type: "array",
            items: { type: "object", properties: { name: { type: "string" }, last_updated: { type: "string" } } },
          },
        },
      },
    });
    const pageFetch = ep({
      endpoint_id: "docker_tags_page",
      url_template: "https://hub.docker.com/r/library/nginx/tags",
      description: "Returns the rendered HTML for \"get dockerhub image tags\"",
      response_schema: { type: "string", format: "html" },
      dom_extraction: { extraction_method: "page_fetch", confidence: 0.5 },
    });

    const ranked = rankEndpoints(
      [pageFetch, tagsApi],
      "get dockerhub image tags",
      "docker.com",
      "https://hub.docker.com/r/library/nginx/tags",
    );

    expect(ranked[0].endpoint.endpoint_id).toBe("docker_tags_api");
  });

  test("public DEV articles API ranks above profile-card page artifact", () => {
    const articlesApi = ep({
      endpoint_id: "devto_articles_api",
      url_template: "https://dev.to/api/articles?username={username}",
      query: { username: "anthropic" },
      description: "Public DEV articles API for anthropic",
      response_schema: {
        type: "array",
        items: {
          type: "object",
          properties: {
            title: { type: "string" },
            url: { type: "string" },
            published_at: { type: "string" },
          },
        },
      },
    });
    const profileArtifact = ep({
      endpoint_id: "profile_cards",
      url_template: "https://dev.to/anthropic",
      description: "Captured page artifact for get devto post",
      response_schema: {
        type: "array",
        items: { type: "object", properties: { title: { type: "string" }, image: { type: "string" } } },
      },
      dom_extraction: { extraction_method: "repeated-elements", confidence: 0.9 },
    });

    const ranked = rankEndpoints(
      [profileArtifact, articlesApi],
      "get devto post",
      "dev.to",
      "https://dev.to/anthropic",
    );

    expect(ranked[0].endpoint.endpoint_id).toBe("devto_articles_api");
  });

  test("public OpenLibrary work API ranks above incidental work page links", () => {
    const workApi = ep({
      endpoint_id: "openlibrary_work_api",
      url_template: "https://openlibrary.org/works/{work_id}.json",
      path_params: { work_id: "OL45804W" },
      description: "Public OpenLibrary work API for OL45804W",
      response_schema: {
        type: "object",
        properties: {
          title: { type: "string" },
          description: { type: "object" },
          authors: { type: "array", items: { type: "object" } },
        },
      },
    });
    const pageLinks = ep({
      endpoint_id: "publisher_language_links",
      url_template: "https://openlibrary.org/works/OL45804W/Fantastic_Mr_Fox",
      description: "Captured page artifact for get openlibrary work",
      response_schema: {
        type: "array",
        items: { type: "object", properties: { title: { type: "string" }, link: { type: "string" } } },
      },
      dom_extraction: { extraction_method: "repeated-elements", confidence: 0.9 },
    });

    const ranked = rankEndpoints(
      [pageLinks, workApi],
      "get openlibrary work",
      "openlibrary.org",
      "https://openlibrary.org/works/OL45804W",
    );

    expect(ranked[0].endpoint.endpoint_id).toBe("openlibrary_work_api");
  });

  test("public Stack Exchange question API ranks above tag-link extraction", () => {
    const questionApi = ep({
      endpoint_id: "stack_question_api",
      url_template: "https://api.stackexchange.com/2.3/questions/{question_id}?order={order}&sort={sort}&site={site}&filter={filter}",
      path_params: { question_id: "231767" },
      query: { order: "desc", sort: "activity", site: "stackoverflow", filter: "withbody" },
      description: "Public Stack Exchange question API for 231767",
      response_schema: {
        type: "object",
        properties: {
          items: {
            type: "array",
            items: { type: "object", properties: { title: { type: "string" }, body: { type: "string" } } },
          },
        },
      },
    });
    const tagLinks = ep({
      endpoint_id: "tag_links",
      url_template: "https://stackoverflow.com/questions/231767",
      description: "Captured page artifact for get stackoverflow question",
      response_schema: {
        type: "array",
        items: { type: "object", properties: { title: { type: "string" }, url: { type: "string" } } },
      },
      dom_extraction: { extraction_method: "repeated-elements", confidence: 0.9 },
    });

    const ranked = rankEndpoints(
      [tagLinks, questionApi],
      "get stackoverflow question",
      "stackoverflow.com",
      "https://stackoverflow.com/questions/231767",
    );

    expect(ranked[0].endpoint.endpoint_id).toBe("stack_question_api");
  });

  test("public ESPN scoreboard API ranks above players-to-watch page artifact", () => {
    const scoreboardApi = ep({
      endpoint_id: "espn_scoreboard_api",
      url_template: "https://site.api.espn.com/apis/site/v2/sports/basketball/nba/scoreboard",
      description: "Public ESPN NBA scoreboard API",
      response_schema: {
        type: "object",
        properties: {
          events: {
            type: "array",
            items: { type: "object", properties: { competitions: { type: "array" }, status: { type: "object" } } },
          },
        },
      },
    });
    const playersToWatch = ep({
      endpoint_id: "players_to_watch",
      url_template: "https://www.espn.com/nba/scoreboard",
      description: "Captured page artifact for get espn nba scoreboard",
      response_schema: {
        type: "array",
        items: { type: "object", properties: { title: { type: "string" }, link: { type: "string" } } },
      },
      dom_extraction: { extraction_method: "repeated-elements", confidence: 0.9 },
    });

    const ranked = rankEndpoints(
      [playersToWatch, scoreboardApi],
      "get espn nba scoreboard",
      "espn.com",
      "https://www.espn.com/nba/scoreboard",
    );

    expect(ranked[0].endpoint.endpoint_id).toBe("espn_scoreboard_api");
  });
});
