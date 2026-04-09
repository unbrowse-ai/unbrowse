import { describe, expect, test } from "bun:test";
import { rankEndpoints } from "../src/execution/index.js";

describe("rankEndpoints semantic intent adjustment", () => {
  test("prefers person search endpoints over company/config endpoints for people search", () => {
    const ranked = rankEndpoints([
      {
        endpoint_id: "company",
        method: "GET",
        url_template: "https://www.linkedin.com/voyager/api/graphql?queryId=voyagerOrganizationDashCompanies",
        idempotency: "safe",
        verification_status: "verified",
        reliability_score: 0.9,
        semantic: { action_kind: "detail", resource_kind: "company" },
      } as any,
      {
        endpoint_id: "people",
        method: "GET",
        url_template: "https://www.linkedin.com/search/results/people/?keywords={keywords}",
        idempotency: "safe",
        verification_status: "verified",
        reliability_score: 0.8,
        dom_extraction: { extraction_method: "repeated-elements", confidence: 0.9 },
        semantic: { action_kind: "search", resource_kind: "person" },
      } as any,
      {
        endpoint_id: "sharebox",
        method: "GET",
        url_template: "https://www.linkedin.com/voyager/api/voyagerContentcreationDashClosedSharebox",
        idempotency: "safe",
        verification_status: "verified",
        reliability_score: 0.8,
        semantic: { action_kind: "list", resource_kind: "topic" },
      } as any,
    ], "search people", "www.linkedin.com", "https://www.linkedin.com/search/results/people/?keywords=openai");

    expect(ranked[0]?.endpoint.endpoint_id).toBe("people");
    expect(ranked[ranked.length - 1]?.endpoint.endpoint_id).toBe("sharebox");
  });

  test("prefers observed company api over captured page artifact for company info", () => {
    const ranked = rankEndpoints([
      {
        endpoint_id: "page-artifact",
        method: "GET",
        url_template: "https://www.linkedin.com/company/openai/about/",
        idempotency: "safe",
        verification_status: "verified",
        reliability_score: 0.95,
        description: "Captured page artifact for get company info",
        semantic: { action_kind: "detail", resource_kind: "company" },
      } as any,
      {
        endpoint_id: "company-api",
        method: "GET",
        url_template: "https://www.linkedin.com/voyager/api/graphql?queryId=voyagerOrganizationDashCompanies",
        idempotency: "safe",
        verification_status: "verified",
        reliability_score: 0.9,
        description: "Returns company profile data",
        semantic: { action_kind: "detail", resource_kind: "company" },
      } as any,
      {
        endpoint_id: "mailbox",
        method: "GET",
        url_template: "https://www.linkedin.com/voyager/api/graphql?queryId=voyagerOrganizationDashPageMailbox",
        idempotency: "safe",
        verification_status: "verified",
        reliability_score: 0.9,
        description: "Returns page mailbox metadata",
        semantic: { action_kind: "detail", resource_kind: "company" },
      } as any,
    ], "get company info", "www.linkedin.com", "https://www.linkedin.com/company/openai/about/");

    expect(ranked[0]?.endpoint.endpoint_id).toBe("company-api");
    expect(ranked[ranked.length - 1]?.endpoint.endpoint_id).toBe("page-artifact");
    expect(ranked.findIndex((candidate) => candidate.endpoint.endpoint_id === "company-api")).toBeLessThan(
      ranked.findIndex((candidate) => candidate.endpoint.endpoint_id === "page-artifact"),
    );
  });

  test("prefers direct profile api over page artifact and sidebar recommendations for user profile", () => {
    const ranked = rankEndpoints([
      {
        endpoint_id: "page-artifact",
        method: "GET",
        url_template: "https://x.com/OpenAI",
        idempotency: "safe",
        verification_status: "verified",
        reliability_score: 0.95,
        description: "Captured page artifact for get user profile",
      } as any,
      {
        endpoint_id: "profile-api",
        method: "GET",
        url_template: "https://x.com/i/api/graphql/pLsOiyHJ1eFwPJlNmLp4Bg/UserByScreenName",
        idempotency: "safe",
        verification_status: "verified",
        reliability_score: 0.9,
        description: "Returns user profile data by screen name",
        semantic: { example_request: { screen_name: "openai" } },
      } as any,
      {
        endpoint_id: "users-by-rest-ids",
        method: "GET",
        url_template: "https://x.com/i/api/graphql/8OKmcyotfczJb44QTTu5tQ/UsersByRestIds",
        idempotency: "safe",
        verification_status: "verified",
        reliability_score: 0.9,
        description: "Returns users by rest ids",
        semantic: { example_request: { userIds: ["1886257062709207041"] } },
      } as any,
      {
        endpoint_id: "sidebar",
        method: "GET",
        url_template: "https://x.com/i/api/graphql/TDtrShaKKs-vFLCuz2jLdA/SidebarUserRecommendations",
        idempotency: "safe",
        verification_status: "verified",
        reliability_score: 0.9,
        description: "Returns sidebar user recommendations",
      } as any,
    ], "get user profile", "x.com", "https://x.com/OpenAI");

    expect(ranked[0]?.endpoint.endpoint_id).toBe("profile-api");
    expect(ranked[ranked.length - 1]?.endpoint.endpoint_id).toBe("page-artifact");
    expect(ranked.findIndex((candidate) => candidate.endpoint.endpoint_id === "users-by-rest-ids")).toBeLessThan(
      ranked.findIndex((candidate) => candidate.endpoint.endpoint_id === "sidebar"),
    );
  });

  test("prefers timeline api over page artifact for post search intents", () => {
    const ranked = rankEndpoints([
      {
        endpoint_id: "page-artifact",
        method: "GET",
        url_template: "https://x.com/search?q={q}&src={src}&f={f}",
        idempotency: "safe",
        verification_status: "verified",
        reliability_score: 0.95,
        description: "Captured page artifact for search posts",
        trigger_url: "https://x.com/search?q=openai&src=typed_query&f=live",
        dom_extraction: { extraction_method: "repeated-elements", confidence: 0.92 },
        response_schema: {
          type: "array",
          items: {
            type: "object",
            properties: {
              id: { type: "string" },
              username: { type: "string" },
              text: { type: "string" },
              url: { type: "string" },
            },
          },
        },
      } as any,
      {
        endpoint_id: "timeline-api",
        method: "GET",
        url_template: "https://x.com/i/api/graphql/N624Yk5dI3CB6SDnSnm5cg/SearchTimeline?variables={variables}&features={features}",
        idempotency: "safe",
        verification_status: "verified",
        reliability_score: 0.9,
        description: "Returns posts timeline with search by raw query, component, and controllerdata",
        trigger_url: "https://x.com/search?q=openai&src=typed_query&f=live",
        response_schema: {
          type: "object",
          properties: {
            data: { type: "object" },
          },
        },
      } as any,
      {
        endpoint_id: "users-by-rest-ids",
        method: "GET",
        url_template: "https://x.com/i/api/graphql/8OKmcyotfczJb44QTTu5tQ/UsersByRestIds?variables={variables}&features={features}",
        idempotency: "safe",
        verification_status: "verified",
        reliability_score: 0.9,
        description: "Returns user details with users, image url, and timestamps",
        trigger_url: "https://x.com/search?q=openai&src=typed_query&f=live",
        response_schema: {
          type: "object",
          properties: {
            data: { type: "object" },
          },
        },
      } as any,
    ], "search posts", "x.com", "https://x.com/search?q=openai&src=typed_query&f=live");

    expect(ranked[0]?.endpoint.endpoint_id).toBe("timeline-api");
    expect(ranked.findIndex((candidate) => candidate.endpoint.endpoint_id === "timeline-api")).toBeLessThan(
      ranked.findIndex((candidate) => candidate.endpoint.endpoint_id === "page-artifact"),
    );
    expect(ranked[ranked.length - 1]?.endpoint.endpoint_id).toBe("page-artifact");
    expect(ranked.findIndex((candidate) => candidate.endpoint.endpoint_id === "users-by-rest-ids")).toBeLessThan(
      ranked.findIndex((candidate) => candidate.endpoint.endpoint_id === "page-artifact"),
    );
  });

  test("prefers linkedin main feed over profile and storyline endpoints for get feed posts", () => {
    const ranked = rankEndpoints([
      {
        endpoint_id: "profile-api",
        method: "GET",
        url_template: "https://www.linkedin.com/voyager/api/graphql?queryId=voyagerIdentityDashProfiles.e9b0809465a07db1f02e70a82d455e10",
        idempotency: "safe",
        verification_status: "verified",
        reliability_score: 0.9,
        description: "Returns LinkedIn member profile data",
        semantic: { action_kind: "list", resource_kind: "post" },
      } as any,
      {
        endpoint_id: "feed-api",
        method: "GET",
        url_template: "https://www.linkedin.com/voyager/api/graphql?queryId=voyagerFeedDashMainFeed.923020905727c01516495a0ac90bb475",
        idempotency: "safe",
        verification_status: "verified",
        reliability_score: 0.9,
        description: "Returns the main member feed updates",
        semantic: { action_kind: "search", resource_kind: "person" },
      } as any,
      {
        endpoint_id: "storylines",
        method: "GET",
        url_template: "https://www.linkedin.com/voyager/api/graphql?queryId=voyagerNewsDashStorylines.c042ce89aeaa19a94ba27cf715164f46",
        idempotency: "safe",
        verification_status: "verified",
        reliability_score: 0.9,
        description: "Returns storyline cards and news highlights",
        semantic: { action_kind: "list", resource_kind: "topic" },
      } as any,
      {
        endpoint_id: "notices",
        method: "GET",
        url_template: "https://www.linkedin.com/psettings/policy/notices?types={types}",
        idempotency: "safe",
        verification_status: "verified",
        reliability_score: 0.9,
        description: "Returns policy notices",
        semantic: { action_kind: "detail", resource_kind: "post" },
      } as any,
    ], "get feed posts", "www.linkedin.com", "https://www.linkedin.com/feed/");

    expect(ranked[0]?.endpoint.endpoint_id).toBe("feed-api");
    expect(ranked.findIndex((candidate) => candidate.endpoint.endpoint_id === "feed-api")).toBeLessThan(
      ranked.findIndex((candidate) => candidate.endpoint.endpoint_id === "profile-api"),
    );
    expect(ranked.findIndex((candidate) => candidate.endpoint.endpoint_id === "feed-api")).toBeLessThan(
      ranked.findIndex((candidate) => candidate.endpoint.endpoint_id === "storylines"),
    );
    expect(ranked.findIndex((candidate) => candidate.endpoint.endpoint_id === "feed-api")).toBeLessThan(
      ranked.findIndex((candidate) => candidate.endpoint.endpoint_id === "notices"),
    );
  });

  test("does not let generic captured feed descriptions beat reviewed api endpoints", () => {
    const ranked = rankEndpoints([
      {
        endpoint_id: "captured-feed-page",
        method: "GET",
        url_template: "https://www.linkedin.com/feed/",
        trigger_url: "https://www.linkedin.com/feed/",
        idempotency: "safe",
        verification_status: "verified",
        reliability_score: 0.95,
        description: "Captured search form artifact for get linkedin feed posts",
        dom_extraction: { extraction_method: "repeated-elements", confidence: 0.92 },
        response_schema: {
          type: "array",
          items: {
            type: "object",
            properties: {
              text: { type: "string" },
              url: { type: "string" },
            },
          },
        },
      } as any,
      {
        endpoint_id: "feed-api",
        method: "GET",
        url_template: "https://www.linkedin.com/voyager/api/graphql?queryId=voyagerFeedDashMainFeed.923020905727c01516495a0ac90bb475",
        trigger_url: "https://www.linkedin.com/feed/",
        idempotency: "safe",
        verification_status: "verified",
        reliability_score: 0.9,
        description: "Returns the main member feed updates",
        response_schema: {
          type: "object",
          properties: {
            data: { type: "object" },
          },
        },
        semantic: {
          action_kind: "timeline",
          resource_kind: "post",
          description_out: "Returns the main member feed updates",
          description_source: "agent",
          description_needs_review: false,
        },
      } as any,
    ], "get linkedin feed posts", "www.linkedin.com", "https://www.linkedin.com/feed/");

    expect(ranked[0]?.endpoint.endpoint_id).toBe("feed-api");
    expect(ranked[1]?.endpoint.endpoint_id).toBe("captured-feed-page");
  });

  test("penalizes linkedin sharebox ui payloads even when they mention search-like fields", () => {
    const ranked = rankEndpoints([
      {
        endpoint_id: "sharebox",
        method: "GET",
        url_template: "https://www.linkedin.com/voyager/api/voyagerContentcreationDashClosedSharebox?feedType={feedType}&q={q}&decorationId={decorationId}",
        idempotency: "safe",
        verification_status: "verified",
        reliability_score: 0.8,
        description: "Searches VoyagerContentcreationDashClosedSharebox with entityUrn, elements, primaryShareboxEntrypointCtaText, shareboxMediaButtons",
        semantic: {
          action_kind: "search",
          resource_kind: "person",
          description_out: "Searches VoyagerContentcreationDashClosedSharebox with primaryShareboxEntrypointCtaText and shareboxMediaButtons",
          response_summary: "data.elements[].primaryShareboxEntrypointCtaText.text, data.elements[].shareboxMediaButtons[]",
        },
      } as any,
      {
        endpoint_id: "people-page",
        method: "GET",
        url_template: "https://www.linkedin.com/search/results/people/?keywords={keywords}",
        idempotency: "safe",
        verification_status: "verified",
        reliability_score: 0.8,
        description: "Captured page artifact for search people",
        dom_extraction: { extraction_method: "repeated-elements", confidence: 0.9 },
        semantic: { action_kind: "search", resource_kind: "person" },
        response_schema: {
          type: "array",
          items: {
            type: "object",
            properties: {
              name: { type: "string" },
              url: { type: "string" },
              public_identifier: { type: "string" },
              headline: { type: "string" },
            },
          },
        },
      } as any,
    ], "search people", "www.linkedin.com", "https://www.linkedin.com/search/results/people/?keywords=openai");

    expect(ranked[0]?.endpoint.endpoint_id).toBe("people-page");
    expect(ranked[ranked.length - 1]?.endpoint.endpoint_id).toBe("sharebox");
  });

  test("prefers discord guild list over referral eligibility for server intents", () => {
    const ranked = rankEndpoints([
      {
        endpoint_id: "page-artifact",
        method: "GET",
        url_template: "https://discord.com/channels/@me",
        idempotency: "safe",
        verification_status: "verified",
        reliability_score: 0.95,
        description: "Captured page artifact for list my discord servers",
        dom_extraction: { extraction_method: "repeated-elements", confidence: 0.9 },
      } as any,
      {
        endpoint_id: "referrals",
        method: "GET",
        url_template: "https://discord.com/api/v9/users/@me/referrals/eligibility",
        idempotency: "safe",
        verification_status: "verified",
        reliability_score: 0.9,
        description: "Returns referral eligibility with ids and status",
        semantic: {
          action_kind: "detail",
          resource_kind: "referral",
          description_out: "Returns referral details with ids and status",
          negative_tags: ["adjacent"],
        },
      } as any,
      {
        endpoint_id: "guilds",
        method: "GET",
        url_template: "https://discord.com/api/v9/users/@me/guilds",
        idempotency: "safe",
        verification_status: "verified",
        reliability_score: 0.9,
        description: "Returns guilds with ids and names",
        semantic: {
          action_kind: "list",
          resource_kind: "guild",
          description_out: "Returns guilds with ids and names",
          negative_tags: [],
        },
      } as any,
      {
        endpoint_id: "gateway",
        method: "WS",
        url_template: "wss://gateway.discord.gg/?encoding=json&v=9&compress=zlib-stream",
        idempotency: "safe",
        verification_status: "verified",
        reliability_score: 0.7,
        description: "Returns gateway events",
        semantic: {
          action_kind: "fetch",
          resource_kind: "event",
          negative_tags: [],
        },
      } as any,
    ], "list my discord servers", "discord.com", "https://discord.com/channels/@me");

    expect(ranked[0]?.endpoint.endpoint_id).toBe("guilds");
    expect(ranked.some((candidate) => candidate.endpoint.endpoint_id === "referrals")).toBe(false);
    expect(ranked.some((candidate) => candidate.endpoint.endpoint_id === "page-artifact")).toBe(false);
  });

  test("filters discord affinity and preview endpoints when no real server list is present", () => {
    const ranked = rankEndpoints([
      {
        endpoint_id: "connections",
        method: "GET",
        url_template: "https://discord.com/api/v9/users/@me/connections",
        idempotency: "safe",
        verification_status: "verified",
        reliability_score: 0.9,
        description: "Returns user details with ids, names, and friend sync",
        response_schema: {
          type: "array",
          items: {
            type: "object",
            properties: {
              id: { type: "string" },
              name: { type: "string" },
              type: { type: "string" },
            },
          },
        },
      } as any,
      {
        endpoint_id: "affinities",
        method: "GET",
        url_template: "https://discord.com/api/v9/users/@me/affinities/guilds",
        idempotency: "safe",
        verification_status: "verified",
        reliability_score: 0.9,
        description: "Returns guilds with guild affinities, ids, and affinity",
        response_schema: {
          type: "object",
          properties: {
            guild_affinities: { type: "array" },
          },
        },
      } as any,
      {
        endpoint_id: "preview",
        method: "GET",
        url_template: "https://discord.com/api/v9/streams/guild%3A123%3A456/preview",
        idempotency: "safe",
        verification_status: "verified",
        reliability_score: 0.8,
        description: "Returns guild details with url",
        response_schema: {
          type: "object",
          properties: {
            url: { type: "string" },
          },
        },
      } as any,
    ], "list my discord servers", "discord.com", "https://discord.com/channels/@me");

    expect(ranked).toHaveLength(0);
  });

  test("drops negative-score discord page artifacts when they are the only remaining candidates", () => {
    const ranked = rankEndpoints([
      {
        endpoint_id: "page-artifact",
        method: "GET",
        url_template: "https://discord.com",
        idempotency: "safe",
        verification_status: "verified",
        reliability_score: 0.63,
        description: "Captured page artifact for get guild channels",
        dom_extraction: { extraction_method: "repeated-elements", confidence: 0.9 },
        response_schema: {
          type: "array",
          items: {
            type: "object",
            properties: {
              type: { type: "string" },
              data: { type: "object" },
              relevance_score: { type: "number" },
            },
          },
        },
      } as any,
    ], "list my discord servers", "discord.com", "https://discord.com/channels/@me");

    expect(ranked).toHaveLength(0);
  });

  test("filters bootstrap-heavy product scaffolds from product search intents", () => {
    const ranked = rankEndpoints([
      {
        endpoint_id: "bootstrap-page",
        method: "GET",
        url_template: "https://www.walmart.com/search?q={q}",
        idempotency: "safe",
        verification_status: "verified",
        reliability_score: 0.95,
        description: "Captured page artifact for search products",
        dom_extraction: { extraction_method: "repeated-elements", confidence: 0.9 },
        response_schema: {
          type: "object",
          properties: {
            initialData: { type: "object" },
            bootstrapData: { type: "object" },
            nonce: { type: "string" },
            traceParents: { type: "array" },
            psych: { type: "object" },
          },
        },
      } as any,
      {
        endpoint_id: "home-page",
        method: "GET",
        url_template: "https://walmart.com",
        idempotency: "safe",
        verification_status: "verified",
        reliability_score: 0.8,
        description: "Captured page artifact for search products",
        dom_extraction: { extraction_method: "repeated-elements", confidence: 0.9 },
        response_schema: {
          type: "object",
          properties: {
            initialTempoData: { type: "object" },
            nonce: { type: "string" },
          },
        },
      } as any,
    ], "search products", "walmart.com", "https://www.walmart.com/search?q=wireless+headphones");

    expect(ranked).toHaveLength(0);
  });

  test("rejects mismatched captured product pages for concrete detail urls", () => {
    const ranked = rankEndpoints([
      {
        endpoint_id: "inventory-page",
        method: "GET",
        url_template: "https://www.saucedemo.com/inventory.html",
        trigger_url: "https://www.saucedemo.com/inventory.html",
        idempotency: "safe",
        verification_status: "verified",
        reliability_score: 0.95,
        description: "Captured page artifact for get products",
        dom_extraction: { extraction_method: "repeated-elements", confidence: 0.9 },
        response_schema: {
          type: "array",
          items: {
            type: "object",
            properties: {
              title: { type: "string" },
              description: { type: "string" },
              price: { type: "string" },
            },
          },
        },
      } as any,
      {
        endpoint_id: "detail-page",
        method: "GET",
        url_template: "https://www.saucedemo.com/inventory-item.html?id=4",
        trigger_url: "https://www.saucedemo.com/inventory-item.html?id=4",
        idempotency: "safe",
        verification_status: "verified",
        reliability_score: 0.8,
        description: "Captured page artifact for get product details",
        dom_extraction: { extraction_method: "key-value", confidence: 0.8 },
        response_schema: {
          type: "object",
          properties: {
            title: { type: "string" },
            description: { type: "string" },
            price: { type: "string" },
          },
        },
      } as any,
    ], "get product details", "www.saucedemo.com", "https://www.saucedemo.com/inventory-item.html?id=4");

    expect(ranked[0]?.endpoint.endpoint_id).toBe("detail-page");
    expect(ranked[ranked.length - 1]?.endpoint.endpoint_id).toBe("inventory-page");
  });

  test("filters news-style candidates for stock quote intents and keeps real quote endpoints", () => {
    const ranked = rankEndpoints([
      {
        endpoint_id: "news-page",
        method: "GET",
        url_template: "https://finance.yahoo.com/quote/AAPL/",
        idempotency: "safe",
        verification_status: "verified",
        reliability_score: 0.9,
        description: "Captured page artifact for get stock quote",
        dom_extraction: { extraction_method: "repeated-elements", confidence: 0.9 },
        response_schema: {
          type: "array",
          items: {
            type: "object",
            properties: {
              title: { type: "string" },
              url: { type: "string" },
              image: { type: "string" },
            },
          },
        },
      } as any,
      {
        endpoint_id: "quote-api",
        method: "GET",
        url_template: "https://query1.finance.yahoo.com/v7/finance/quote?symbols={symbols}",
        idempotency: "safe",
        verification_status: "verified",
        reliability_score: 0.9,
        description: "Returns quote data with symbol, regular market price, and currency",
        response_schema: {
          type: "object",
          properties: {
            quoteResponse: { type: "object" },
            symbol: { type: "string" },
            regularMarketPrice: { type: "number" },
            currency: { type: "string" },
          },
        },
      } as any,
    ], "get stock quote", "finance.yahoo.com", "https://finance.yahoo.com/quote/AAPL");

    expect(ranked).toHaveLength(1);
    expect(ranked[0]?.endpoint.endpoint_id).toBe("quote-api");
  });

  test("prefers public chart quote endpoints over crumb-bound quote urls", () => {
    const ranked = rankEndpoints([
      {
        endpoint_id: "crumb-quote",
        method: "GET",
        url_template: "https://query1.finance.yahoo.com/v7/finance/quote?symbols={symbols}&crumb={crumb}",
        idempotency: "safe",
        verification_status: "verified",
        reliability_score: 0.9,
        description: "Returns quote data with symbol and regular market price",
        response_schema: {
          type: "object",
          properties: {
            quoteResponse: { type: "object" },
          },
        },
      } as any,
      {
        endpoint_id: "chart-quote",
        method: "GET",
        url_template: "https://query2.finance.yahoo.com/v8/finance/chart/{symbol}?interval={interval}",
        idempotency: "safe",
        verification_status: "verified",
        reliability_score: 0.9,
        description: "Returns chart details with regularMarketPrice and current price",
        response_schema: {
          type: "object",
          properties: {
            chart: { type: "object" },
          },
        },
      } as any,
    ], "get stock quote", "finance.yahoo.com", "https://finance.yahoo.com/quote/AAPL");

    expect(ranked[0]?.endpoint.endpoint_id).toBe("chart-quote");
  });

  test("prefers structured replay over sibling dom artifact for public search pages", () => {
    const ranked = rankEndpoints([
      {
        endpoint_id: "dom-page",
        method: "GET",
        url_template: "https://huggingface.co/models?search={search}",
        idempotency: "safe",
        verification_status: "verified",
        reliability_score: 0.95,
        description: "Captured page artifact for search models",
        dom_extraction: { extraction_method: "repeated-elements", confidence: 0.9 },
        trigger_url: "https://huggingface.co/models?search=openai",
      } as any,
      {
        endpoint_id: "replay",
        method: "GET",
        url_template: "https://huggingface.co/api/models?search=openai&limit=20",
        idempotency: "safe",
        verification_status: "verified",
        reliability_score: 0.9,
        description: "Structured replay for search models",
        trigger_url: "https://huggingface.co/models?search=openai",
      } as any,
    ], "search models", "huggingface.co", "https://huggingface.co/models?search=openai");

    expect(ranked[0]?.endpoint.endpoint_id).toBe("replay");
  });

  test("demotes bundle-inferred ghost routes below observed structured endpoints", () => {
    const ranked = rankEndpoints([
      {
        endpoint_id: "bundle-ghost",
        method: "GET",
        url_template: "https://pub.dev/api/account/likes",
        idempotency: "safe",
        verification_status: "pending",
        reliability_score: 0.2,
        description: "Inferred from JS bundle (string_literal). Not observed in network traffic.",
      } as any,
      {
        endpoint_id: "observed-search",
        method: "GET",
        url_template: "https://registry.npmjs.org/-/v1/search?text={q}&size=20",
        idempotency: "safe",
        verification_status: "verified",
        reliability_score: 0.9,
        description: "Structured replay for search packages",
        response_schema: {
          type: "object",
          properties: {
            objects: { type: "array" },
          },
        },
      } as any,
    ], "search packages", "pub.dev", "https://pub.dev/packages/http");

    expect(ranked[0]?.endpoint.endpoint_id).toBe("observed-search");
    expect(ranked[ranked.length - 1]?.endpoint.endpoint_id).toBe("bundle-ghost");
  });

  test("prefers temu product search api over ad-tracking and fingerprint endpoints", () => {
    const ranked = rankEndpoints([
      {
        endpoint_id: "ad-tracking",
        method: "GET",
        url_template: "https://www.temu.com/api/bg/bg-temu-activity-oversea-fe/activity/common/adx/cm/ttc",
        idempotency: "safe",
        verification_status: "verified",
        reliability_score: 0.8,
        description: "Ad tracking endpoint for TTClid campaign measurement",
      } as any,
      {
        endpoint_id: "fingerprint",
        method: "POST",
        url_template: "https://www.temu.com/api/phantom/pfb",
        idempotency: "unsafe",
        verification_status: "verified",
        reliability_score: 0.8,
        description: "Browser fingerprint collection endpoint",
      } as any,
      {
        endpoint_id: "timestamp",
        method: "GET",
        url_template: "https://www.temu.com/server/_stm",
        idempotency: "safe",
        verification_status: "verified",
        reliability_score: 0.9,
        description: "Server timestamp endpoint",
      } as any,
      {
        endpoint_id: "product-search",
        method: "GET",
        url_template: "https://www.temu.com/api/poppy/v1/search?q={q}&page_sn={page_sn}",
        idempotency: "safe",
        verification_status: "verified",
        reliability_score: 0.85,
        description: "Returns product search results with goods_list, price, and ratings",
        response_schema: {
          type: "object",
          properties: {
            goods_list: { type: "array" },
            total: { type: "number" },
          },
        },
      } as any,
    ], "search products on temu", "www.temu.com", "https://www.temu.com/search_result.html?search_key=shoes");

    expect(ranked[0]?.endpoint.endpoint_id).toBe("product-search");
    // ad-tracking, fingerprint, and timestamp should all rank below product-search
    const productIdx = ranked.findIndex((c) => c.endpoint.endpoint_id === "product-search");
    const adIdx = ranked.findIndex((c) => c.endpoint.endpoint_id === "ad-tracking");
    const fpIdx = ranked.findIndex((c) => c.endpoint.endpoint_id === "fingerprint");
    const stmIdx = ranked.findIndex((c) => c.endpoint.endpoint_id === "timestamp");
    if (adIdx !== -1) expect(productIdx).toBeLessThan(adIdx);
    if (fpIdx !== -1) expect(productIdx).toBeLessThan(fpIdx);
    if (stmIdx !== -1) expect(productIdx).toBeLessThan(stmIdx);
  });

  test("prefers nike product search api over privacy-consent and i18n navigation endpoints", () => {
    const ranked = rankEndpoints([
      {
        endpoint_id: "privacy-compliance",
        method: "GET",
        url_template: "https://www.nike.com/api/privacy_compliance",
        idempotency: "safe",
        verification_status: "verified",
        reliability_score: 0.9,
        description: "Privacy compliance settings endpoint",
      } as any,
      {
        endpoint_id: "i18n-navigation",
        method: "GET",
        url_template: "https://www.nike.com/i18n/en/navigation.json",
        idempotency: "safe",
        verification_status: "verified",
        reliability_score: 0.9,
        description: "Internationalization navigation config",
      } as any,
      {
        endpoint_id: "privacy-consent",
        method: "GET",
        url_template: "https://www.nike.com/api/privacy-consent",
        idempotency: "safe",
        verification_status: "verified",
        reliability_score: 0.8,
        description: "User privacy consent endpoint",
      } as any,
      {
        endpoint_id: "product-search",
        method: "GET",
        url_template: "https://api.nike.com/crs/products/v4/search?queryid={queryid}&endpoint=product&search={search}",
        idempotency: "safe",
        verification_status: "verified",
        reliability_score: 0.85,
        description: "Returns product search results with title, price, and colorways",
        response_schema: {
          type: "object",
          properties: {
            products: { type: "array" },
            pages: { type: "object" },
          },
        },
      } as any,
    ], "search shoes on nike", "www.nike.com", "https://www.nike.com/w/shoes-y7ok?q=shoes");

    expect(ranked[0]?.endpoint.endpoint_id).toBe("product-search");
    const productIdx = ranked.findIndex((c) => c.endpoint.endpoint_id === "product-search");
    const privacyIdx = ranked.findIndex((c) => c.endpoint.endpoint_id === "privacy-compliance");
    const i18nIdx = ranked.findIndex((c) => c.endpoint.endpoint_id === "i18n-navigation");
    if (privacyIdx !== -1) expect(productIdx).toBeLessThan(privacyIdx);
    if (i18nIdx !== -1) expect(productIdx).toBeLessThan(i18nIdx);
  });

  test("filters x.com videoads and fleets avatar endpoints below data apis for tweet search", () => {
    const ranked = rankEndpoints([
      {
        endpoint_id: "videoads",
        method: "GET",
        url_template: "https://x.com/i/api/1.1/ads/videoads/prerolls.json",
        idempotency: "safe",
        verification_status: "verified",
        reliability_score: 0.8,
        description: "Video preroll ads endpoint",
      } as any,
      {
        endpoint_id: "fleets-avatar",
        method: "GET",
        url_template: "https://x.com/i/api/fleets/v1/avatar_content?user_ids={user_ids}",
        idempotency: "safe",
        verification_status: "verified",
        reliability_score: 0.8,
        description: "Fleets avatar content for user ids",
      } as any,
      {
        endpoint_id: "search-timeline",
        method: "GET",
        url_template: "https://x.com/i/api/graphql/N624Yk5dI3CB6SDnSnm5cg/SearchTimeline?variables={variables}",
        idempotency: "safe",
        verification_status: "verified",
        reliability_score: 0.9,
        description: "Returns tweet search results with tweet text and author",
        response_schema: {
          type: "object",
          properties: {
            data: { type: "object" },
          },
        },
      } as any,
    ], "search tweets", "x.com", "https://x.com/search?q=openai");

    expect(ranked[0]?.endpoint.endpoint_id).toBe("search-timeline");
    const searchIdx = ranked.findIndex((c) => c.endpoint.endpoint_id === "search-timeline");
    const adsIdx = ranked.findIndex((c) => c.endpoint.endpoint_id === "videoads");
    const fleetsIdx = ranked.findIndex((c) => c.endpoint.endpoint_id === "fleets-avatar");
    if (adsIdx !== -1) expect(searchIdx).toBeLessThan(adsIdx);
    if (fleetsIdx !== -1) expect(searchIdx).toBeLessThan(fleetsIdx);
  });

  test("filters coinmarketcap locales and whitepaper endpoints below token info api", () => {
    const ranked = rankEndpoints([
      {
        endpoint_id: "locales",
        method: "GET",
        url_template: "https://coinmarketcap.com/locales/Community.json",
        idempotency: "safe",
        verification_status: "verified",
        reliability_score: 0.9,
        description: "Community localization strings",
      } as any,
      {
        endpoint_id: "whitepaper",
        method: "GET",
        url_template: "https://coinmarketcap.com/currencies/bitcoin/whitepaper/summaries",
        idempotency: "safe",
        verification_status: "verified",
        reliability_score: 0.85,
        description: "Whitepaper summaries for token",
      } as any,
      {
        endpoint_id: "token-info",
        method: "GET",
        url_template: "https://api.coinmarketcap.com/data-api/v3/cryptocurrency/detail?id={id}&convertId={convertId}",
        idempotency: "safe",
        verification_status: "verified",
        reliability_score: 0.9,
        description: "Returns token details with price, market cap, and 24h change",
        response_schema: {
          type: "object",
          properties: {
            data: { type: "object" },
            price: { type: "number" },
            marketCap: { type: "number" },
          },
        },
      } as any,
    ], "get bitcoin token info", "coinmarketcap.com", "https://coinmarketcap.com/currencies/bitcoin/");

    expect(ranked[0]?.endpoint.endpoint_id).toBe("token-info");
    const tokenIdx = ranked.findIndex((c) => c.endpoint.endpoint_id === "token-info");
    const localesIdx = ranked.findIndex((c) => c.endpoint.endpoint_id === "locales");
    if (localesIdx !== -1) expect(tokenIdx).toBeLessThan(localesIdx);
  });
});
