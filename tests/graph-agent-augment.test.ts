import { describe, expect, it } from "bun:test";
import { augmentEndpointsWithAgent } from "../src/graph/agent-augment.js";
import type { EndpointDescriptor } from "../src/types/index.js";

describe("agent semantic augmentation", () => {
  it("refines descriptions and semantic types without inventing new keys", async () => {
    const endpoint: EndpointDescriptor = {
      endpoint_id: "repo-search",
      method: "GET",
      url_template: "https://api.example.com/search/repositories?q={q}",
      description: "Returns resource details",
      query: { q: "" },
      idempotency: "safe",
      verification_status: "verified",
      reliability_score: 0.9,
      semantic: {
        action_kind: "detail",
        resource_kind: "resource",
        description_out: "Returns resource details",
        requires: [{ key: "q", required: false, source: "query", semantic_type: "input" }],
        provides: [
          { key: "owner", source: "response", semantic_type: "input" },
          { key: "repo", source: "response", semantic_type: "input" },
        ],
        negative_tags: [],
        confidence: 0.7,
        example_request: { q: "openai" },
        example_response_compact: { items: [{ owner: "openai", repo: "openai-node" }] },
        example_fields: ["items[].owner", "items[].repo"],
      },
    };

    const augmented = await augmentEndpointsWithAgent([endpoint], {
      intent: "get repository details",
      domain: "example.com",
      provider: { url: "https://example.test/v1/chat/completions", key: "test-key", model: "gpt-test" },
      fetchImpl: async () =>
        new Response(JSON.stringify({
          choices: [{
            message: {
              content: JSON.stringify({
                endpoints: [{
                  endpoint_id: "repo-search",
                  action_kind: "search",
                  resource_kind: "repository",
                  description_out: "Searches repositories and returns owner and repo names",
                  requires: [{ key: "q", semantic_type: "query_text", required: true, source: "query" }],
                  provides: [
                    { key: "owner", semantic_type: "repository_owner" },
                    { key: "repo", semantic_type: "repository_name" },
                    { key: "repo_id", semantic_type: "repository_identifier" },
                  ],
                }],
              }),
            },
          }],
        })),
    });

    const semantic = augmented[0]?.semantic;
    expect(augmented[0]?.description).toBe("Searches repositories and returns owner and repo names");
    expect(semantic?.action_kind).toBe("search");
    expect(semantic?.resource_kind).toBe("repository");
    expect(semantic?.requires?.find((binding) => binding.key === "q")?.semantic_type).toBe("query_text");
    expect(semantic?.provides?.find((binding) => binding.key === "owner")?.semantic_type).toBe("repository_owner");
    expect(semantic?.provides?.find((binding) => binding.key === "repo")?.semantic_type).toBe("repository_name");
    expect(semantic?.provides?.find((binding) => binding.key === "repo_id")).toBeUndefined();
  });

  it("only sends the highest-signal endpoints to the model", async () => {
    const endpoints: EndpointDescriptor[] = [
      {
        endpoint_id: "noise-1",
        method: "POST",
        url_template: "https://pbs.yahoo.com/cookie_sync",
        description: "Returns post status with bidder status",
        idempotency: "unsafe",
        verification_status: "unverified",
        reliability_score: 0.5,
        semantic: {
          action_kind: "status",
          resource_kind: "post",
          description_out: "Returns post status with bidder status",
          requires: [],
          provides: [],
          negative_tags: ["status"],
          confidence: 0.7,
        },
      },
      {
        endpoint_id: "noise-2",
        method: "GET",
        url_template: "https://guce.yahoo.com/consent?done={done}",
        description: "Returns consent data",
        query: { done: "" },
        idempotency: "safe",
        verification_status: "pending",
        reliability_score: 0.5,
        semantic: {
          action_kind: "detail",
          resource_kind: "resource",
          description_out: "Returns consent data",
          requires: [{ key: "done", required: false, source: "query", semantic_type: "input" }],
          provides: [],
          negative_tags: [],
          confidence: 0.7,
        },
      },
      {
        endpoint_id: "quote",
        method: "GET",
        url_template: "https://query1.finance.yahoo.com/v7/finance/quote?symbols={symbols}",
        description: "Returns quote data. fields: quoteResponse:{result,error}",
        query: { symbols: "" },
        idempotency: "safe",
        verification_status: "verified",
        reliability_score: 0.9,
        response_schema: { type: "object", properties: { quoteResponse: { type: "object" } } },
        semantic: {
          action_kind: "detail",
          resource_kind: "resource",
          description_out: "Returns quote data",
          requires: [{ key: "symbols", required: false, source: "query", semantic_type: "input" }],
          provides: [{ key: "symbol", source: "response", semantic_type: "input" }],
          negative_tags: [],
          confidence: 0.7,
          example_fields: ["quoteResponse.result[].symbol", "quoteResponse.result[].regularMarketPrice"],
        },
      },
      {
        endpoint_id: "chart",
        method: "GET",
        url_template: "https://query2.finance.yahoo.com/v8/finance/chart/{symbol}",
        description: "Returns chart details with price history",
        path_params: { symbol: "" },
        idempotency: "safe",
        verification_status: "verified",
        reliability_score: 0.9,
        response_schema: { type: "object", properties: { chart: { type: "object" } } },
        semantic: {
          action_kind: "detail",
          resource_kind: "quote",
          description_out: "Returns chart details",
          requires: [{ key: "symbol", required: true, source: "path_params", semantic_type: "ticker_symbol" }],
          provides: [{ key: "symbol", source: "response", semantic_type: "ticker_symbol" }],
          negative_tags: [],
          confidence: 0.7,
          example_fields: ["chart.result[].meta.symbol", "chart.result[].meta.currency"],
        },
      },
    ];

    let sentEndpointIds: string[] = [];
    await augmentEndpointsWithAgent(endpoints, {
      intent: "get stock quote",
      domain: "finance.yahoo.com",
      provider: { url: "https://example.test/v1/chat/completions", key: "test-key", model: "gpt-test" },
      fetchImpl: async (_url, init) => {
        const body = JSON.parse(String(init?.body)) as { messages: Array<{ content: string }> };
        const payload = JSON.parse(body.messages[1]?.content ?? "{}") as { endpoints?: Array<{ endpoint_id: string }> };
        sentEndpointIds = (payload.endpoints ?? []).map((endpoint) => endpoint.endpoint_id);
        return new Response(JSON.stringify({
          choices: [{
            message: {
              content: JSON.stringify({ endpoints: [] }),
            },
          }],
        }));
      },
    });

    expect(sentEndpointIds).toContain("quote");
    expect(sentEndpointIds).toContain("chart");
    expect(sentEndpointIds).not.toContain("noise-1");
    expect(sentEndpointIds).not.toContain("noise-2");
  });

  it("pins deterministic sampling params so same capture yields same labels", async () => {
    // Regression: cold-start-bench caught HN homepage endpoint getting
    // resource_kind=comment on one run and resource_kind=post on another.
    // Root cause: the chat-completions request was missing temperature/seed,
    // so OpenAI defaulted to temperature=1 and returned different labels for
    // identical inputs. Fix pins temperature=0, top_p=0, seed=1.
    const endpoint: EndpointDescriptor = {
      endpoint_id: "deterministic-check",
      method: "GET",
      url_template: "https://news.ycombinator.com/",
      description: "Returns stories",
      idempotency: "safe",
      verification_status: "verified",
      reliability_score: 0.9,
      semantic: {
        action_kind: "list",
        resource_kind: "post",
        description_out: "Returns stories",
        requires: [],
        provides: [{ key: "title", source: "response", semantic_type: "input" }],
        negative_tags: [],
        confidence: 0.7,
      },
    };

    let sentBody: Record<string, unknown> | null = null;
    await augmentEndpointsWithAgent([endpoint], {
      intent: "list top stories",
      domain: "news.ycombinator.com",
      provider: { url: "https://example.test/v1/chat/completions", key: "test-key", model: "gpt-test" },
      fetchImpl: async (_url, init) => {
        sentBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return new Response(JSON.stringify({
          choices: [{ message: { content: JSON.stringify({ endpoints: [] }) } }],
        }));
      },
    });

    expect(sentBody).not.toBeNull();
    expect(sentBody?.temperature).toBe(0);
    expect(sentBody?.top_p).toBe(0);
    expect(sentBody?.seed).toBe(1);
    expect(sentBody?.response_format).toEqual({ type: "json_object" });
  });
});
