import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import app from "../src/index.js";
import type { Env, RoutingTelemetryEvent } from "../src/types.js";
import { statsKV } from "../src/services/kv.js";

const env: Env = {
  API_KEY: "admin",
  UNKEY_ROOT_KEY: "root",
  UNKEY_API_ID: "api",
  EMERGENTDB_API_KEY: "test",
  NEBIUS_API_KEY: "nebius",
  STATS_KV: {} as KVNamespace,
  ENVIRONMENT: "staging",
};

function createMockFetch(store: Map<string, string>) {
  return async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url);
    if (url.hostname !== "api.emergentdb.com") {
      throw new Error(`Unexpected fetch: ${url.toString()}`);
    }
    if (url.pathname === "/qdkv/set") {
      const body = JSON.parse(String(init?.body ?? "{}")) as { key: string; value: string };
      store.set(body.key, body.value);
      return Response.json({ ok: true });
    }
    if (url.pathname.startsWith("/qdkv/get/")) {
      const key = decodeURIComponent(url.pathname.replace("/qdkv/get/", ""));
      const value = store.get(key);
      return Response.json(value == null ? { found: false, value: null } : { found: true, value });
    }
    if (url.pathname.startsWith("/qdkv/del/")) {
      const key = decodeURIComponent(url.pathname.replace("/qdkv/del/", ""));
      store.delete(key);
      return Response.json({ ok: true });
    }
    throw new Error(`Unexpected fetch: ${url.toString()}`);
  };
}

function routingEvents(): RoutingTelemetryEvent[] {
  return [
    {
      event_id: "evt-session",
      event_type: "routing_session_started",
      session_id: "sess-1",
      created_at: new Date().toISOString(),
      trace_version: "trace-v1",
      anonymized_agent_id: "anon-1",
      top_level_intent: "search widgets",
      normalized_domains: ["example.com"],
      run_type: "long_running",
      context_buckets: {
        role: "general",
        cost_sensitivity: "medium",
        latency_sensitivity: "high",
        output_preference: "structured",
        task_horizon: "long",
        has_prior_history: true,
      },
    },
    {
      event_id: "evt-ranked",
      event_type: "routing_candidates_ranked",
      session_id: "sess-1",
      created_at: new Date().toISOString(),
      trace_version: "trace-v1",
      anonymized_agent_id: "anon-1",
      top_level_intent: "search widgets",
      normalized_domains: ["example.com"],
      run_type: "long_running",
      step_id: "sess-1:1",
      step_index: 1,
      source: "marketplace",
      state_hash_before: "before",
      candidate_count: 2,
      candidates: [
        {
          candidate_id: "cand-1",
          rank: 1,
          skill_id: "skill-1",
          endpoint_id: "search",
          operation_id: "op-search",
          route_fingerprint: "fp-search",
          score: 99,
          chosen: true,
          reachable: true,
          feature_snapshot: {
            method: "GET",
            has_response_schema: true,
            dom_extraction: false,
            verification_status: "verified",
            reliability_score: 0.9,
            unsafe_action_score: 0,
          },
        },
        {
          candidate_id: "cand-2",
          rank: 2,
          skill_id: "skill-1",
          endpoint_id: "detail",
          operation_id: "op-detail",
          route_fingerprint: "fp-detail",
          score: 73,
          chosen: false,
          reachable: false,
          rejection_reason: "dependency_missing",
          feature_snapshot: {
            method: "GET",
            has_response_schema: false,
            dom_extraction: false,
            verification_status: "verified",
            reliability_score: 0.8,
            unsafe_action_score: 0,
          },
        },
      ],
    },
    {
      event_id: "evt-step",
      event_type: "routing_step_executed",
      session_id: "sess-1",
      created_at: new Date().toISOString(),
      trace_version: "trace-v1",
      anonymized_agent_id: "anon-1",
      top_level_intent: "search widgets",
      normalized_domains: ["example.com"],
      run_type: "long_running",
      step_id: "sess-1:1",
      step_index: 1,
      source: "marketplace",
      state_hash_before: "before",
      state_hash_after: "after",
      selected_skill_id: "skill-1",
      selected_endpoint_id: "search",
      selected_operation_id: "op-search",
      candidate_count: 2,
      execution_latency_ms: 120,
      status_code: 200,
      success: true,
      response_hash: "resp-1",
      cross_domain_transition: false,
      retry_count: 0,
      user_override: false,
      did_step_unlock_next_step: true,
      required_recovery: false,
    },
    {
      event_id: "evt-done",
      event_type: "routing_session_completed",
      session_id: "sess-1",
      created_at: new Date().toISOString(),
      completed_at: new Date().toISOString(),
      trace_version: "trace-v1",
      anonymized_agent_id: "anon-1",
      top_level_intent: "search widgets",
      normalized_domains: ["example.com"],
      run_type: "long_running",
      final_outcome: "success",
      final_success: true,
      total_steps: 1,
      total_candidates_ranked: 2,
      total_api_calls: 1,
      retry_count: 0,
      user_override: false,
      required_recovery: false,
    },
  ];
}

describe("routing telemetry routes", () => {
  const store = new Map<string, string>();
  const originalFetch = globalThis.fetch;

  beforeEach(async () => {
    globalThis.fetch = createMockFetch(store) as typeof fetch;
    store.clear();
    await statsKV(env).resetSplitIndex();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("stores routing events idempotently and serves derived analytics", async () => {
    const events = routingEvents();
    const first = await app.fetch(new Request("http://local.test/v1/telemetry/routing", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ events }),
    }), env);
    expect(first.status).toBe(200);
    expect(await first.json()).toEqual({ ok: true, stored: 4, duplicates: 0 });

    const second = await app.fetch(new Request("http://local.test/v1/telemetry/routing", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ events }),
    }), env);
    expect(second.status).toBe(200);
    expect(await second.json()).toEqual({ ok: true, stored: 0, duplicates: 4 });

    const analytics = await app.fetch(new Request("http://local.test/v1/analytics/routing?days=30", {
      headers: { Authorization: "Bearer admin" },
    }), env);
    expect(analytics.status).toBe(200);
    const body = await analytics.json() as {
      sessions: number;
      long_running_sessions: number;
      successful_sessions: number;
      avg_steps_per_session: number;
      avg_candidates_per_step: number;
      total_api_calls: number;
      outcomes: Array<{ outcome: string; count: number }>;
      sources: Array<{ source: string; count: number }>;
      source_performance: Array<{
        source: string;
        step_count: number;
        success_count: number;
        success_rate: number;
        avg_latency_ms: number;
        median_latency_ms: number;
      }>;
      top_intents: Array<{ intent: string; sessions: number; steps: number }>;
      top_domains: Array<{ domain: string; sessions: number; steps: number }>;
    };
    expect(body.sessions).toBe(1);
    expect(body.long_running_sessions).toBe(1);
    expect(body.successful_sessions).toBe(1);
    expect(body.avg_steps_per_session).toBe(1);
    expect(body.avg_candidates_per_step).toBe(2);
    expect(body.total_api_calls).toBe(1);
    expect(body.outcomes[0]).toEqual({ outcome: "success", count: 1 });
    expect(body.sources).toEqual([{ source: "marketplace", count: 2 }]);
    expect(body.source_performance).toEqual([{
      source: "marketplace",
      step_count: 1,
      success_count: 1,
      success_rate: 1,
      avg_latency_ms: 120,
      median_latency_ms: 120,
    }]);
    expect(body.top_intents).toEqual([{ intent: "search widgets", sessions: 1, steps: 1 }]);
    expect(body.top_domains).toEqual([{ domain: "example.com", sessions: 1, steps: 1 }]);
  });

  it("rejects blocked payloads", async () => {
    const events = routingEvents();
    const bad = structuredClone(events);
    if (bad[1]?.event_type === "routing_candidates_ranked") {
      bad[1].candidates[0]!.feature_snapshot = {
        ...bad[1].candidates[0]!.feature_snapshot,
        email: "lewis@getfoundry.app",
      } as typeof bad[1].candidates[0]!.feature_snapshot;
    }
    const res = await app.fetch(new Request("http://local.test/v1/telemetry/routing", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ events: bad }),
    }), env);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual(expect.objectContaining({
      error: expect.stringContaining("blocked_routing_payload"),
    }));
  });
});
