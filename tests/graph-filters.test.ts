import { describe, expect, it } from "bun:test";
import { buildSkillOperationGraph, getEndpointDescriptionMetadata, getSkillChunk, inferEndpointSemantic, isOperationHardExcluded, operationSoftPenalty } from "../src/lib/graph-core/index.js";
import type { EndpointDescriptor, SkillManifest } from "../src/types/index.js";

function endpoint(
  endpoint_id: string,
  url_template: string,
  description: string,
  example_fields: string[],
  semantic?: EndpointDescriptor["semantic"],
): EndpointDescriptor {
  return {
    endpoint_id,
    method: "GET",
    url_template,
    description,
    idempotency: "safe",
    verification_status: "verified",
    reliability_score: 0.9,
    response_schema: {
      type: "object",
      inferred_from_samples: 1,
      properties: Object.fromEntries(
        example_fields.map((field) => [
          field.replace(/\[\].*$/, "").split(".").pop() ?? field,
          { type: "string", inferred_from_samples: 1 },
        ]),
      ),
    },
    semantic,
  };
}

describe("graph filter mechanism", () => {
  it("hard-excludes telemetry and experiment/status junk for data intents", () => {
    const telemetry = buildSkillOperationGraph([
      endpoint("track", "https://x.com/i/api/1.1/promoted_content/log.json", "tracks promoted content beacon", ["log", "tracking"]),
    ]).operations[0]!;
    const experiment = buildSkillOperationGraph([
      endpoint("experiments", "https://discord.com/api/v9/experiments", "returns fingerprint and guild experiments", ["fingerprint", "guild_experiments"]),
    ]).operations[0]!;
    const status = buildSkillOperationGraph([
      endpoint("status", "https://www.githubstatus.com/api/v2/status.json", "returns system status", ["status.indicator"]),
    ]).operations[0]!;

    expect(isOperationHardExcluded(telemetry, "search repositories")).toBe(true);
    expect(isOperationHardExcluded(experiment, "get guild channels")).toBe(true);
    expect(isOperationHardExcluded(status, "search repositories")).toBe(true);
    expect(isOperationHardExcluded(status, "get status")).toBe(false);
  });

  it("soft-penalizes helper/settings style endpoints", () => {
    const helper = buildSkillOperationGraph([
      endpoint("helper", "https://x.com/i/api/graphql/useVerifiedOrgIdentityVerificationConfigQuery", "verified org helper settings query", ["settings", "helper"]),
    ]).operations[0]!;
    expect(operationSoftPenalty(helper, "get trending topics")).toBeGreaterThan(0);
  });

  it("synthesizes semantic descriptions for discord referral noise instead of generic message labels", () => {
    const semantic = inferEndpointSemantic({
      endpoint_id: "referrals",
      method: "GET",
      url_template: "https://discord.com/api/v9/users/@me/referrals/eligibility",
      description: "Returns details for Message with data",
      idempotency: "safe",
      verification_status: "verified",
      reliability_score: 0.9,
      response_schema: {
        type: "object",
        inferred_from_samples: 1,
        properties: {
          referral_status: { type: "string", inferred_from_samples: 1 },
          referral_id: { type: "string", inferred_from_samples: 1 },
        },
      },
    } as any);

    expect(semantic.description_out).toContain("referral");
    expect(semantic.description_out).not.toContain("message");
    expect(semantic.negative_tags).toContain("adjacent");
    expect(semantic.description_source).toBe("auto");
    expect(semantic.description_needs_review).toBe(true);
  });

  it("marks captured artifact descriptions as auto and surfaces the generated display description", () => {
    const endpoint = {
      endpoint_id: "feed-page",
      method: "GET",
      url_template: "https://www.linkedin.com/feed/",
      description: "Captured search form artifact for get linkedin feed posts",
      idempotency: "safe",
      verification_status: "verified",
      reliability_score: 0.9,
      response_schema: {
        type: "array",
        inferred_from_samples: 1,
        items: {
          type: "object",
          inferred_from_samples: 1,
          properties: {
            text: { type: "string", inferred_from_samples: 1 },
            url: { type: "string", inferred_from_samples: 1 },
          },
        },
      },
      dom_extraction: { extraction_method: "repeated-elements", confidence: 0.9 },
    } as any;
    const semantic = inferEndpointSemantic(endpoint);
    const meta = getEndpointDescriptionMetadata({ ...endpoint, semantic });

    expect(meta.source).toBe("auto");
    expect(meta.needs_review).toBe(false); // schema-grounded auto descriptions pass review
    expect(meta.display).not.toContain("Captured search form artifact");
    expect(meta.warning).toBeUndefined(); // schema-grounded: no warning
  });

  it("treats local DOM fallback descriptions as auto-generated", () => {
    const endpoint = {
      endpoint_id: "feed-form",
      method: "GET",
      url_template: "https://www.linkedin.com/feed/",
      description: "Search form for www.linkedin.com",
      idempotency: "safe",
      verification_status: "verified",
      reliability_score: 0.385,
      response_schema: {
        type: "array",
        inferred_from_samples: 1,
        items: {
          type: "object",
          inferred_from_samples: 1,
          properties: {
            type: { type: "string", inferred_from_samples: 1 },
            data: { type: "array", inferred_from_samples: 1, items: { type: "string", inferred_from_samples: 1 } },
            relevance_score: { type: "number", inferred_from_samples: 1 },
          },
        },
      },
      dom_extraction: { extraction_method: "multiple", confidence: 0.385 },
    } as any;
    const semantic = inferEndpointSemantic(endpoint);
    const meta = getEndpointDescriptionMetadata({ ...endpoint, semantic });

    expect(semantic.description_source).toBe("auto");
    expect(semantic.description_needs_review).toBe(true);
    expect(meta.source).toBe("auto");
    expect(meta.needs_review).toBe(false); // schema-grounded auto descriptions pass review
    expect(meta.display).not.toBe("Search form for www.linkedin.com");
  });

  it("does not treat linkedin feed pagination tokens as auth-only", () => {
    const feed = buildSkillOperationGraph([
      endpoint(
        "main-feed",
        "https://www.linkedin.com/voyager/api/graphql?queryId=voyagerFeedDashMainFeed.923020905727c01516495a0ac90bb475",
        "Returns details for Voyager with data using variables, queryId",
        [
          "data.data.feedDashMainFeedByMainFeed.metadata.paginationToken",
          "data.data.feedDashMainFeedByMainFeed.paging.count",
          "included[].entityUrn",
        ],
      ),
    ]).operations[0]!;

    expect(feed.negative_tags ?? []).not.toContain("auth");
    expect(isOperationHardExcluded(feed, "get feed posts")).toBe(false);
  });

  it("drops hard-excluded ops from graph chunks when a better data op exists", () => {
    const endpoints = [
      endpoint("timeline", "https://x.com/i/api/graphql/GenericTimelineById", "returns trending timeline topics", ["timeline.instructions", "entries", "topic"]),
      endpoint("settings", "https://api.x.com/1.1/account/settings.json", "returns account config settings", ["settings", "account"]),
      endpoint("helper", "https://x.com/i/api/graphql/useVerifiedOrgIdentityVerificationConfigQuery", "verified org helper settings query", ["settings", "helper"]),
    ];
    const skill: SkillManifest = {
      skill_id: "skill-x",
      version: "2.0.0",
      schema_version: "2",
      name: "x.com",
      intent_signature: "get trending topics",
      domain: "x.com",
      description: "x fixture",
      owner_type: "agent",
      execution_type: "http",
      endpoints,
      operation_graph: buildSkillOperationGraph(endpoints),
      lifecycle: "active",
      created_at: "2026-03-06T00:00:00.000Z",
      updated_at: "2026-03-06T00:00:00.000Z",
      intents: [],
    };

    const chunk = getSkillChunk(skill, { intent: "get trending topics", max_operations: 5 });
    expect(chunk.operations.some((operation) => operation.operation_id === "timeline")).toBe(true);
    expect(chunk.operations.some((operation) => operation.operation_id === "settings")).toBe(false);
    expect(chunk.operations.some((operation) => operation.operation_id === "helper")).toBe(false);
  });

  it("surfaces linkedin main feed as a runnable operation for get feed posts", () => {
    const endpoints = [
      endpoint(
        "main-feed",
        "https://www.linkedin.com/voyager/api/graphql?queryId=voyagerFeedDashMainFeed.923020905727c01516495a0ac90bb475",
        "Returns details for Voyager with data",
        ["included[].entityUrn", "data.$type"],
        {
          action_kind: "search",
          resource_kind: "person",
          negative_tags: [],
          example_fields: ["included[].entityUrn", "data.$type"],
        } as any,
      ),
      endpoint(
        "client-signal",
        "https://www.linkedin.com/voyager/api/graphql?queryId=inSessionRelevanceVoyagerFeedDashClientSignal.d14b45e21b8bec350407b606edf9cba0",
        "Updates client signal state",
        ["data.result.__typename"],
        {
          action_kind: "detail",
          resource_kind: "post",
          negative_tags: [],
          example_fields: ["data.result.__typename"],
        } as any,
      ),
      endpoint(
        "notices",
        "https://www.linkedin.com/psettings/policy/notices?types={types}",
        "Returns policy notices",
        ["content.noticePolicy[].type"],
        {
          action_kind: "detail",
          resource_kind: "post",
          negative_tags: [],
          example_fields: ["content.noticePolicy[].type"],
        } as any,
      ),
    ];
    const skill: SkillManifest = {
      skill_id: "skill-linkedin-feed",
      version: "2.0.0",
      schema_version: "2",
      name: "linkedin.com",
      intent_signature: "get feed posts",
      domain: "www.linkedin.com",
      description: "linkedin fixture",
      owner_type: "agent",
      execution_type: "http",
      endpoints,
      operation_graph: buildSkillOperationGraph(endpoints),
      lifecycle: "active",
      created_at: "2026-03-08T00:00:00.000Z",
      updated_at: "2026-03-08T00:00:00.000Z",
      intents: [],
    };

    const chunk = getSkillChunk(skill, { intent: "get feed posts", max_operations: 5 });
    expect(chunk.available_operation_ids[0]).toBe("main-feed");
    expect(chunk.available_operation_ids).toContain("main-feed");
    expect(chunk.operations.some((operation) => operation.operation_id === "client-signal")).toBe(false);
  });

  it("rebuilds stale stored operation graphs from endpoint semantics", () => {
    const endpoints = [
      endpoint(
        "main-feed",
        "https://www.linkedin.com/voyager/api/graphql?queryId=voyagerFeedDashMainFeed.923020905727c01516495a0ac90bb475",
        "Returns details for Voyager with data using variables, queryId",
        [
          "data.data.feedDashMainFeedByMainFeed.metadata.paginationToken",
          "data.data.feedDashMainFeedByMainFeed.paging.count",
          "included[].entityUrn",
        ],
      ),
      endpoint(
        "notices",
        "https://www.linkedin.com/psettings/policy/notices?types={types}",
        "Returns policy notices",
        ["content.noticePolicy[].type"],
      ),
    ];
    const skill: SkillManifest = {
      skill_id: "skill-linkedin-stale-graph",
      version: "2.0.0",
      schema_version: "2",
      name: "linkedin.com",
      intent_signature: "get feed posts",
      domain: "www.linkedin.com",
      description: "linkedin fixture",
      owner_type: "agent",
      execution_type: "http",
      endpoints,
      operation_graph: {
        generated_at: "2026-03-08T00:00:00.000Z",
        entry_operation_ids: ["notices"],
        operations: [
          {
            operation_id: "notices",
            endpoint_id: "notices",
            method: "GET",
            url_template: endpoints[1]!.url_template,
            action_kind: "detail",
            resource_kind: "resource",
            requires: [],
            provides: [],
            negative_tags: [],
            confidence: 0.1,
          },
        ],
        edges: [],
      },
      lifecycle: "active",
      created_at: "2026-03-08T00:00:00.000Z",
      updated_at: "2026-03-08T00:00:00.000Z",
      intents: [],
    };

    const chunk = getSkillChunk(skill, { intent: "get feed posts", max_operations: 5 });
    expect(chunk.available_operation_ids[0]).toBe("main-feed");
    expect(chunk.operations.some((operation) => operation.operation_id === "main-feed")).toBe(true);
  });
});
