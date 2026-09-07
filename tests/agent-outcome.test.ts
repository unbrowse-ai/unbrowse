import { describe, expect, it } from "bun:test";
import { attachAgentOutcomeHints, buildAgentImpact, buildNextActions } from "../src/agent-outcome.js";
import type { SkillManifest } from "../src/types/index.js";

const skill: SkillManifest = {
  skill_id: "skill-1",
  version: "1.0.0",
  schema_version: "1",
  name: "Example",
  intent_signature: "example",
  domain: "example.com",
  description: "Example skill",
  owner_type: "agent",
  execution_type: "http",
  lifecycle: "active",
  created_at: "2026-04-03T00:00:00.000Z",
  updated_at: "2026-04-03T00:00:00.000Z",
  endpoints: [
    {
      endpoint_id: "search",
      method: "GET",
      url_template: "https://example.com/search",
      idempotency: "safe",
      verification_status: "verified",
      reliability_score: 0.9,
      description: "Search results",
      semantic: { action_kind: "search", resource_kind: "item", requires: [], provides: [{ key: "item_id" }], confidence: 0.9 },
    },
    {
      endpoint_id: "detail",
      method: "GET",
      url_template: "https://example.com/detail/{item_id}",
      idempotency: "safe",
      verification_status: "verified",
      reliability_score: 0.95,
      description: "Item detail",
      semantic: { action_kind: "get", resource_kind: "item_detail", requires: [{ key: "item_id", required: true }], provides: [], confidence: 0.95 },
    },
  ],
  operation_graph: {
    generated_at: "2026-04-03T00:00:00.000Z",
    entry_operation_ids: ["op-search"],
    operations: [
      {
        operation_id: "op-search",
        endpoint_id: "search",
        method: "GET",
        url_template: "https://example.com/search",
        action_kind: "search",
        resource_kind: "item",
        requires: [],
        provides: [{ key: "item_id" }],
        confidence: 0.9,
      },
      {
        operation_id: "op-detail",
        endpoint_id: "detail",
        method: "GET",
        url_template: "https://example.com/detail/{item_id}",
        action_kind: "get",
        resource_kind: "item_detail",
        requires: [{ key: "item_id", required: true }],
        provides: [],
        confidence: 0.95,
      },
    ],
    edges: [
      {
        edge_id: "edge-1",
        from_operation_id: "op-search",
        to_operation_id: "op-detail",
        binding_key: "item_id",
        kind: "parent_child",
        confidence: 0.9,
      },
    ],
  },
};

describe("agent outcome hints", () => {
  it("builds a machine-readable impact summary", () => {
    expect(buildAgentImpact({
      source: "marketplace",
      cache_hit: true,
      baseline_total_ms: 20000,
      actual_total_ms: 400,
      time_saved_ms: 19600,
      time_saved_pct: 98,
      tokens_saved: 11800,
      tokens_saved_pct: 99,
      baseline_cost_uc: 30000,
      actual_cost_uc: 100,
      cost_saved_uc: 29900,
    })).toEqual({
      source: "marketplace",
      cache_hit: true,
      browser_avoided: true,
      baseline_total_ms: 20000,
      actual_total_ms: 400,
      time_saved_ms: 19600,
      time_saved_pct: 98,
      tokens_saved: 11800,
      tokens_saved_pct: 99,
      baseline_cost_uc: 30000,
      actual_cost_uc: 100,
      cost_saved_uc: 29900,
    });
  });

  it("suggests likely next actions from the operation graph", () => {
    const next = buildNextActions(skill, "search");
    expect(next).toHaveLength(1);
    expect(next[0]).toEqual({
      endpoint_id: "detail",
      operation_id: "op-detail",
      title: "get item detail",
      why: "Likely next detail step after this result. Exposes get item detail.",
      command: "unbrowse execute --skill skill-1 --endpoint detail",
    });
  });

  it("attaches impact and next actions together", () => {
    const payload = attachAgentOutcomeHints({
      trace: { endpoint_id: "search" },
    }, {
      skill,
      endpointId: "search",
      timing: {
        source: "marketplace",
        cache_hit: true,
        time_saved_ms: 1200,
        time_saved_pct: 80,
        tokens_saved: 600,
        tokens_saved_pct: 50,
      },
    });
    expect(payload.impact?.browser_avoided).toBe(true);
    expect(payload.next_actions?.[0]?.endpoint_id).toBe("detail");
  });
});
