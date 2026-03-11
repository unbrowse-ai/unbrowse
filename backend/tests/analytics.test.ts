import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { AgentProfile, Env } from "../src/types.js";
import { getAgent, recordAgentExecution } from "../src/services/agents.js";
import { getEngagement, getRetention } from "../src/services/analytics.js";
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

function isoDaysAgo(days: number): string {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() - days);
  date.setUTCHours(12, 0, 0, 0);
  return date.toISOString();
}

function dateDaysAgo(days: number): string {
  return isoDaysAgo(days).slice(0, 10);
}

function createMockFetch(store: Map<string, string>) {
  return async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url);

    if (url.pathname === "/qdkv/set") {
      const body = JSON.parse(String(init?.body ?? "{}")) as { key: string; value: string };
      store.set(body.key, body.value);
      return Response.json({ ok: true });
    }

    if (url.pathname.startsWith("/qdkv/get/")) {
      const key = decodeURIComponent(url.pathname.replace("/qdkv/get/", ""));
      const value = store.get(key);
      return Response.json(value == null
        ? { found: false, value: null }
        : { found: true, value });
    }

    if (url.pathname.startsWith("/qdkv/del/")) {
      const key = decodeURIComponent(url.pathname.replace("/qdkv/del/", ""));
      store.delete(key);
      return Response.json({ ok: true });
    }

    throw new Error(`Unexpected fetch: ${url.toString()}`);
  };
}

async function seedAgent(profile: AgentProfile): Promise<void> {
  await statsKV(env).put(`agent:${profile.agent_id}`, JSON.stringify(profile));
}

describe("analytics telemetry", () => {
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

  it("serializes concurrent execution telemetry writes per agent", async () => {
    await seedAgent({
      agent_id: "agent-1",
      name: "agent-1",
      created_at: isoDaysAgo(2),
      skills_discovered: [],
      total_executions: 0,
      total_feedback_given: 0,
      tos_accepted_version: "2026-01-01",
      tos_accepted_at: isoDaysAgo(2),
      activity_dates: [],
    });

    await Promise.all(Array.from({ length: 25 }, () => recordAgentExecution(env, "agent-1")));

    const profile = await getAgent(env, "agent-1");
    expect(profile?.total_executions).toBe(25);
    expect(profile?.activity_dates).toEqual([dateDaysAgo(0)]);
    expect(profile?.first_execution_at).toBeString();
    expect(profile?.last_active_at).toBeString();
  });

  it("derives engagement and retention from profile activity history", async () => {
    await seedAgent({
      agent_id: "retained-agent",
      name: "retained-agent",
      created_at: isoDaysAgo(7),
      skills_discovered: ["skill-a"],
      total_executions: 6,
      total_feedback_given: 1,
      tos_accepted_version: "2026-01-01",
      tos_accepted_at: isoDaysAgo(7),
      first_execution_at: isoDaysAgo(7),
      last_active_at: isoDaysAgo(4),
      activity_dates: [dateDaysAgo(6), dateDaysAgo(4)],
    });

    await seedAgent({
      agent_id: "new-agent",
      name: "new-agent",
      created_at: isoDaysAgo(3),
      skills_discovered: [],
      total_executions: 1,
      total_feedback_given: 0,
      tos_accepted_version: "2026-01-01",
      tos_accepted_at: isoDaysAgo(3),
      first_execution_at: isoDaysAgo(0),
      last_active_at: isoDaysAgo(0),
      activity_dates: [dateDaysAgo(0)],
    });

    const engagement = await getEngagement(env);
    expect(engagement.dau).toBe(1);
    expect(engagement.wau).toBe(2);
    expect(engagement.mau).toBe(2);

    const cohorts = await getRetention(env, 10);
    const sevenDayCohort = cohorts.find((cohort) => cohort.cohort_date === dateDaysAgo(7));
    expect(sevenDayCohort).toBeDefined();
    expect(sevenDayCohort?.cohort_size).toBe(1);
    expect(sevenDayCohort?.retention.d1).toBe(1);
    expect(sevenDayCohort?.retention.d3).toBe(1);
    expect(sevenDayCohort?.retention.d7).toBe(0);
  });
});
