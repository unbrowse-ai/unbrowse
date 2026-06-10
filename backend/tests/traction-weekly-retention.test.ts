import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { AgentProfile, Env } from "../src/types.js";
import { computeWeeklyRetention } from "../src/services/traction.js";
import { statsKV, clearKVCacheForTests } from "../src/services/kv.js";

const env: Env = {
  API_KEY: "admin",
  EMERGENTDB_API_KEY: "test",
  NEBIUS_API_KEY: "nebius",
  STATS_KV: {} as KVNamespace,
  ENVIRONMENT: "local-dev",
};

function dateDaysAgo(days: number): string {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() - days);
  date.setUTCHours(12, 0, 0, 0);
  return date.toISOString().slice(0, 10);
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

async function seedRaw(key: string, value: string): Promise<void> {
  await statsKV(env).put(key, value);
}

function baseProfile(id: string, activityDates: string[]): AgentProfile {
  return {
    agent_id: id,
    name: id,
    created_at: dateDaysAgo(20) + "T12:00:00.000Z",
    skills_discovered: [],
    total_executions: activityDates.length,
    total_feedback_given: 0,
    tos_accepted_version: "2026-01-01",
    tos_accepted_at: dateDaysAgo(20) + "T12:00:00.000Z",
    activity_dates: activityDates,
  };
}

describe("computeWeeklyRetention", () => {
  const store = new Map<string, string>();
  const originalFetch = globalThis.fetch;

  beforeEach(async () => {
    globalThis.fetch = createMockFetch(store) as typeof fetch;
    store.clear();
    clearKVCacheForTests("stats");
    await statsKV(env).resetSplitIndex();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("returns 0 when no agents exist (guards div-by-zero)", async () => {
    const result = await computeWeeklyRetention(env);
    expect(result).toBe(0);
  });

  it("returns 1 when the only agent is active in both windows", async () => {
    await seedAgent(baseProfile("agent-loyal", [dateDaysAgo(10), dateDaysAgo(2)]));
    const result = await computeWeeklyRetention(env);
    expect(result).toBe(1);
  });

  it("returns 0 when prior-week agents do not overlap with current-week agents", async () => {
    await seedAgent(baseProfile("agent-prior-only", [dateDaysAgo(10)]));
    await seedAgent(baseProfile("agent-current-only", [dateDaysAgo(2)]));
    const result = await computeWeeklyRetention(env);
    expect(result).toBe(0);
  });

  it("returns 0.5 when one of two prior-week agents is also active in the current week", async () => {
    await seedAgent(baseProfile("agent-prior-only", [dateDaysAgo(10)]));
    await seedAgent(baseProfile("agent-both", [dateDaysAgo(10), dateDaysAgo(2)]));
    const result = await computeWeeklyRetention(env);
    expect(result).toBe(0.5);
  });

  it("skips malformed agent:* values without throwing and without affecting other agents", async () => {
    await seedRaw("agent:bad", "{not json");
    await seedAgent(baseProfile("agent-loyal", [dateDaysAgo(10), dateDaysAgo(2)]));
    const result = await computeWeeklyRetention(env);
    expect(result).toBe(1);
  });
});
