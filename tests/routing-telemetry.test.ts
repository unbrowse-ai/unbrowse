import { describe, expect, it } from "bun:test";
import type { SkillManifest } from "../src/types/index.js";
import {
  buildRoutingCandidateSnapshots,
  buildRoutingContextBuckets,
  createRoutingTelemetryCollector,
  hashRoutingState,
  sanitizeRoutingEventBatch,
} from "../src/routing-telemetry.js";

const skill: SkillManifest = {
  skill_id: "skill-routing",
  version: "1.0.0",
  schema_version: "1",
  name: "routing",
  intent_signature: "search widgets",
  domain: "example.com",
  description: "Routing telemetry test skill",
  owner_type: "agent",
  execution_type: "http",
  lifecycle: "active",
  created_at: "2026-04-03T00:00:00.000Z",
  updated_at: "2026-04-03T00:00:00.000Z",
  endpoints: [
    {
      endpoint_id: "search",
      method: "GET",
      url_template: "https://example.com/api/search?q={query}",
      idempotency: "safe",
      verification_status: "verified",
      reliability_score: 0.9,
      response_schema: { type: "object", inferred_from_samples: 1 },
      description: "search widgets",
    },
    {
      endpoint_id: "detail",
      method: "GET",
      url_template: "https://example.com/api/items/{id}",
      idempotency: "safe",
      verification_status: "verified",
      reliability_score: 0.8,
      description: "item detail",
    },
  ],
  operation_graph: {
    entry_operation_ids: ["op-search"],
    operations: [
      {
        operation_id: "op-search",
        endpoint_id: "search",
        method: "GET",
        url_template: "https://example.com/api/search?q={query}",
        requires: [],
        provides: [{ key: "id", required: false }],
      },
      {
        operation_id: "op-detail",
        endpoint_id: "detail",
        method: "GET",
        url_template: "https://example.com/api/items/{id}",
        requires: [{ key: "id", required: true }],
        provides: [],
      },
    ],
    edges: [{ from_operation_id: "op-search", to_operation_id: "op-detail", binding: "id" }],
  },
};

describe("routing telemetry helpers", () => {
  it("hashes state deterministically without exposing raw values", () => {
    const first = hashRoutingState({ query: "secret phrase", limit: 10 });
    const second = hashRoutingState({ limit: 10, query: "secret phrase" });
    expect(first).toBe(second);
    expect(first).not.toContain("secret phrase");
  });

  it("preserves candidate order and chosen flag", () => {
    const ranked = buildRoutingCandidateSnapshots(skill, [
      { endpoint: skill.endpoints[0], score: 98.2 },
      { endpoint: skill.endpoints[1], score: 74.4 },
    ], {
      selectedEndpointId: "detail",
      reachableEndpointIds: new Set(["search"]),
      rejectionReasons: { search: "schema_mismatch" },
    });

    expect(ranked.map((candidate) => candidate.rank)).toEqual([1, 2]);
    expect(ranked[0]?.reachable).toBe(true);
    expect(ranked[1]?.reachable).toBe(false);
    expect(ranked[1]?.chosen).toBe(true);
    expect(ranked[0]?.rejection_reason).toBe("schema_mismatch");
  });

  it("sanitizes blocked fields from event batches", () => {
    const collector = createRoutingTelemetryCollector({
      sessionId: "sess-1",
      startedAt: "2026-04-03T00:00:00.000Z",
      intent: "search widgets",
      traceVersion: "trace-v1",
      anonymizedAgentId: "anon-1",
      runType: "long_running",
      contextBuckets: buildRoutingContextBuckets("search widgets"),
      normalizedDomains: ["example.com"],
    });

    collector.recordCandidates({
      source: "marketplace",
      stateHashBefore: hashRoutingState({ query: "widgets" }),
      candidateCount: 1,
      candidates: [
        {
          candidate_id: "cand-1",
          rank: 1,
          endpoint_id: "search",
          route_fingerprint: "fp-1",
          score: 99,
          chosen: true,
          reachable: true,
          rejection_reason: "transcript leaked",
          feature_snapshot: {
            method: "GET",
            has_response_schema: true,
            dom_extraction: false,
            verification_status: "verified",
            reliability_score: 0.9,
            unsafe_action_score: 0,
          },
        },
      ],
    });

    collector.complete({
      outcome: "success",
      completedAt: "2026-04-03T00:00:01.000Z",
      totalApiCalls: 1,
      retryCount: 0,
      userOverride: false,
      requiredRecovery: false,
    });

    const sanitized = sanitizeRoutingEventBatch(collector.toBatch());
    const ranked = sanitized.find((event) => event.event_type === "routing_candidates_ranked");
    expect(ranked && ranked.event_type === "routing_candidates_ranked").toBe(true);
    if (ranked?.event_type === "routing_candidates_ranked") {
      expect(JSON.stringify(ranked)).not.toContain("email");
      expect(ranked.candidates[0]?.rejection_reason).toBe("transcript leaked");
    }
  });
});
