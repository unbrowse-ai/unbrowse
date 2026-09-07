import { describe, expect, test } from "bun:test";
import { rankEndpoints } from "../src/client/rank-server-first.js";

// Fix 1 (contract e6dc4aa8): axios.com homepage intent should rank
// /articles and /stories (editorial content) ABOVE /audiences/newsletters
// (CRM/subscription management). HOMEPAGE_INTENT + HOMEPAGE_META_PATHS
// pair demotes admin paths by -200 so the agent never gets handed the
// newsletter-admin endpoint as the front page.
describe("rankEndpoints HOMEPAGE_INTENT meta demotion", () => {
  test("demotes /audiences/newsletters below /articles for axios homepage intent", () => {
    const ranked = rankEndpoints([
      {
        endpoint_id: "audiences-newsletters",
        method: "GET",
        url_template: "https://www.axios.com/api/audiences/newsletters",
        idempotency: "safe",
        verification_status: "verified",
        reliability_score: 0.9,
        description: "Returns newsletter audiences for management",
        response_schema: {
          type: "object",
          properties: {
            data: {
              type: "array",
              items: {
                type: "object",
                properties: { id: { type: "string" }, name: { type: "string" }, subscribers: { type: "number" } },
              },
            },
          },
        },
      } as any,
      {
        endpoint_id: "articles",
        method: "GET",
        url_template: "https://www.axios.com/api/articles",
        idempotency: "safe",
        verification_status: "verified",
        reliability_score: 0.9,
        description: "Returns the latest axios articles for the homepage feed",
        response_schema: {
          type: "object",
          properties: {
            results: {
              type: "array",
              items: {
                type: "object",
                properties: { title: { type: "string" }, url: { type: "string" }, published: { type: "string" } },
              },
            },
          },
        },
      } as any,
      {
        endpoint_id: "stories",
        method: "GET",
        url_template: "https://www.axios.com/api/stories",
        idempotency: "safe",
        verification_status: "verified",
        reliability_score: 0.9,
        description: "Returns axios story feed",
        response_schema: {
          type: "object",
          properties: {
            results: {
              type: "array",
              items: {
                type: "object",
                properties: { title: { type: "string" }, url: { type: "string" } },
              },
            },
          },
        },
      } as any,
    ], "axios homepage", "www.axios.com", "https://www.axios.com/");

    const idxAudiences = ranked.findIndex((r) => r.endpoint.endpoint_id === "audiences-newsletters");
    const idxArticles = ranked.findIndex((r) => r.endpoint.endpoint_id === "articles");
    const idxStories = ranked.findIndex((r) => r.endpoint.endpoint_id === "stories");

    expect(idxAudiences).toBeGreaterThan(-1);
    expect(idxArticles).toBeGreaterThan(-1);
    expect(idxStories).toBeGreaterThan(-1);
    // /articles AND /stories must outrank /audiences/newsletters.
    expect(idxArticles).toBeLessThan(idxAudiences);
    expect(idxStories).toBeLessThan(idxAudiences);
    // /audiences/newsletters must end up last in the homepage shortlist.
    expect(ranked[ranked.length - 1]?.endpoint.endpoint_id).toBe("audiences-newsletters");
  });

  test("does NOT demote /audiences when intent is explicitly newsletter management (not homepage)", () => {
    const ranked = rankEndpoints([
      {
        endpoint_id: "audiences",
        method: "GET",
        url_template: "https://www.axios.com/api/audiences/newsletters",
        idempotency: "safe",
        verification_status: "verified",
        reliability_score: 0.9,
        description: "Returns newsletter audiences for management",
        response_schema: {
          type: "object",
          properties: {
            data: {
              type: "array",
              items: { type: "object", properties: { id: { type: "string" } } },
            },
          },
        },
      } as any,
      {
        endpoint_id: "articles",
        method: "GET",
        url_template: "https://www.axios.com/api/articles",
        idempotency: "safe",
        verification_status: "verified",
        reliability_score: 0.9,
        description: "Returns the latest articles for the homepage feed",
        response_schema: {
          type: "object",
          properties: {
            results: { type: "array", items: { type: "object" } },
          },
        },
      } as any,
    ], "manage newsletter audiences subscriptions", "www.axios.com", "https://www.axios.com/admin");

    const idxAudiences = ranked.findIndex((r) => r.endpoint.endpoint_id === "audiences");
    const idxArticles = ranked.findIndex((r) => r.endpoint.endpoint_id === "articles");
    expect(idxAudiences).toBeGreaterThan(-1);
    expect(idxArticles).toBeGreaterThan(-1);
    // For "manage newsletter audiences subscriptions" intent the audiences
    // endpoint should NOT be hard-demoted by the homepage rule (HOMEPAGE_INTENT
    // does not match "manage").
    expect(idxAudiences).toBeLessThan(idxArticles);
  });

  test("homepage demotion fires for landing/frontpage/main-page synonyms", () => {
    const intents = ["axios landing page", "axios front page", "axios main page"];
    for (const intent of intents) {
      const ranked = rankEndpoints([
        {
          endpoint_id: "subscriptions",
          method: "GET",
          url_template: "https://www.example.com/api/subscriptions",
          idempotency: "safe",
          verification_status: "verified",
          reliability_score: 0.9,
          description: "Returns user subscriptions for billing",
          response_schema: {
            type: "object",
            properties: {
              data: { type: "array", items: { type: "object" } },
            },
          },
        } as any,
        {
          endpoint_id: "posts",
          method: "GET",
          url_template: "https://www.example.com/api/posts",
          idempotency: "safe",
          verification_status: "verified",
          reliability_score: 0.9,
          description: "Returns latest posts for the homepage",
          response_schema: {
            type: "object",
            properties: {
              results: { type: "array", items: { type: "object" } },
            },
          },
        } as any,
      ], intent, "www.example.com", "https://www.example.com/");

      const idxSub = ranked.findIndex((r) => r.endpoint.endpoint_id === "subscriptions");
      const idxPosts = ranked.findIndex((r) => r.endpoint.endpoint_id === "posts");
      expect(idxPosts).toBeLessThan(idxSub);
    }
  });
});
