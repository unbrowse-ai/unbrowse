import { afterEach, describe, expect, it } from "bun:test";
import { rmSync } from "node:fs";
import { join } from "node:path";
import app from "../backend/src/index.js";
import { skillsKV, statsKV } from "../backend/src/services/kv.js";
import { CURRENT_TOS_VERSION } from "../backend/src/tos.js";
import type { AgentProfile, Env, SkillManifest } from "../backend/src/types.js";

const env: Env = {
  API_KEY: "admin",
  UNKEY_ROOT_KEY: "root",
  UNKEY_API_ID: "api",
  EMERGENTDB_API_KEY: "test",
  NEBIUS_API_KEY: "nebius",
  STATS_KV: {} as KVNamespace,
  ENVIRONMENT: "staging",
};

const execCtx = {
  waitUntil(_promise: Promise<unknown>) {},
  passThroughOnException() {},
};

const touchedEnvKeys = [
  "HOST",
  "PORT",
  "TRACES_DIR",
  "UNBROWSE_API_KEY",
  "UNBROWSE_BACKEND_URL",
  "UNBROWSE_CONFIG_DIR",
  "UNBROWSE_SKILL_CACHE_DIR",
  "UNBROWSE_LOCAL_ONLY",
  "UNBROWSE_NON_INTERACTIVE",
  "UNBROWSE_TOS_ACCEPTED",
];

function isoNow(): string {
  return new Date().toISOString();
}

function buildAgentId(apiKey: string): string {
  return `staging_${apiKey.slice(0, 8)}`;
}

function createMockFetch(store: Map<string, string>, passthrough: typeof fetch) {
  return async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const requestUrl = typeof input === "string"
      ? input
      : input instanceof URL
        ? input.toString()
        : input.url;
    const url = new URL(requestUrl);

    if (url.hostname !== "api.emergentdb.com") {
      return passthrough(input as RequestInfo, init);
    }

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

async function seedSkill(skill: SkillManifest): Promise<void> {
  await skillsKV(env).put(`skill:${skill.skill_id}`, JSON.stringify(skill));
}

describe("analytics e2e", () => {
  const originalFetch = globalThis.fetch;
  const originalEnv = new Map<string, string | undefined>();

  afterEach(() => {
    globalThis.fetch = originalFetch;
    for (const key of touchedEnvKeys) {
      const value = originalEnv.get(key);
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    originalEnv.clear();
  });

  it("records manual execute sessions and exposes them through the restored analytics surface", async () => {
    const store = new Map<string, string>();
    globalThis.fetch = createMockFetch(store, originalFetch) as typeof fetch;
    await Promise.all([
      statsKV(env).resetSplitIndex(),
      skillsKV(env).resetSplitIndex(),
    ]);

    const backendPort = 8788;
    const targetPort = 8790;
    const localPort = 6971;
    const apiKey = "e2e-token-analytics";
    const agentId = buildAgentId(apiKey);
    const tempRoot = join(
      "/tmp",
      `unbrowse-analytics-e2e-${process.pid}-${Date.now()}`,
    );

    for (const key of touchedEnvKeys) {
      originalEnv.set(key, process.env[key]);
    }
    process.env.UNBROWSE_BACKEND_URL = `http://127.0.0.1:${backendPort}`;
    process.env.UNBROWSE_API_KEY = apiKey;
    process.env.UNBROWSE_CONFIG_DIR = join(tempRoot, "config");
    process.env.UNBROWSE_SKILL_CACHE_DIR = join(tempRoot, "skill-cache");
    process.env.TRACES_DIR = join(tempRoot, "traces");
    process.env.UNBROWSE_LOCAL_ONLY = "0";
    process.env.UNBROWSE_NON_INTERACTIVE = "1";
    process.env.UNBROWSE_TOS_ACCEPTED = "1";
    process.env.HOST = "127.0.0.1";
    process.env.PORT = String(localPort);

    const now = isoNow();
    const skill: SkillManifest = {
      skill_id: "local:analytics-e2e",
      version: "1.0.0",
      schema_version: "1",
      name: "analytics-e2e",
      intent_signature: "analytics-e2e",
      domain: "127.0.0.1",
      description: "analytics e2e skill",
      owner_type: "agent",
      execution_type: "http",
      lifecycle: "active",
      created_at: now,
      updated_at: now,
      endpoints: [
        {
          endpoint_id: "items",
          method: "GET",
          url_template: `http://127.0.0.1:${targetPort}/items`,
          description: "Fetch items",
          idempotency: "safe",
          verification_status: "verified",
          reliability_score: 1,
        },
      ],
    };

    await seedAgent({
      agent_id: agentId,
      name: "e2e-agent",
      created_at: now,
      profile_origin: "registered",
      skills_discovered: [skill.skill_id],
      total_executions: 0,
      total_feedback_given: 0,
      tos_accepted_version: CURRENT_TOS_VERSION,
      tos_accepted_at: now,
      activity_dates: [],
    });
    await seedSkill(skill);

    const backendServer = Bun.serve({
      port: backendPort,
      fetch(request) {
        return app.fetch(request, env, execCtx);
      },
    });

    const targetServer = Bun.serve({
      port: targetPort,
      fetch() {
        return Response.json({
          items: [
            { id: 1, title: "alpha" },
            { id: 2, title: "beta" },
          ],
        });
      },
    });

    const { cachePublishedSkill } = await import("../src/client/index.js");
    const { startUnbrowseServer } = await import("../src/server.js");
    cachePublishedSkill(skill);

    const unbrowse = await startUnbrowseServer({
      host: "127.0.0.1",
      port: localPort,
      logger: false,
      scheduleVerification: false,
    });

    try {
      for (let i = 0; i < 2; i++) {
        const executeRes = await fetch(`http://127.0.0.1:${localPort}/v1/skills/${encodeURIComponent(skill.skill_id)}/execute`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ params: {} }),
        });
        const rawBody = await executeRes.text();
        expect({ status: executeRes.status, rawBody }).toEqual({
          status: 200,
          rawBody: expect.any(String),
        });
        const body = JSON.parse(rawBody) as {
          trace: { success: boolean; endpoint_id?: string };
          result: { items: Array<{ id: number; title: string }> };
        };
        expect(body.trace.success).toBe(true);
        expect(body.trace.endpoint_id).toBe("items");
        expect(body.result.items).toHaveLength(2);
      }

      const auth = { Authorization: "Bearer admin" };
      const usageResponse = await fetch(`http://127.0.0.1:${backendPort}/v1/analytics/usage`, { headers: auth });
      expect(usageResponse.headers.get("cache-control")).toBe("private, no-store");
      expect(usageResponse.headers.get("vary")).toBe("Authorization");
      const usage = await usageResponse.json() as {
        total_sessions_30d: number;
        unique_agents_30d: number;
        api_calls_per_session: number;
        version_breakdown_30d: Array<{ trace_version: string }>;
      };
      const [funnel, network, economics, dashboard] = await Promise.all([
        fetch(`http://127.0.0.1:${backendPort}/v1/analytics/funnel?days=30`, { headers: auth }).then((res) => res.json()),
        fetch(`http://127.0.0.1:${backendPort}/v1/analytics/network`, { headers: auth }).then((res) => res.json()),
        fetch(`http://127.0.0.1:${backendPort}/v1/analytics/economics`, { headers: auth }).then((res) => res.json()),
        fetch(`http://127.0.0.1:${backendPort}/v1/analytics/dashboard`, { headers: auth }).then((res) => res.json()),
      ]) as [
        {
          recovered_profiles_excluded: number;
          stages: Array<{ key: string; users: number }>;
        },
        {
          total_indexed_skills: number;
          indexed_skill_calls: number;
          fresh_index_calls: number;
        },
        {
          route_calls_30d: number;
          discovery_queries_30d: number;
        },
        Record<string, unknown>,
      ];

      const stages = Object.fromEntries(funnel.stages.map((stage) => [stage.key, stage.users]));
      expect(usage.total_sessions_30d).toBe(2);
      expect(usage.unique_agents_30d).toBe(1);
      expect(usage.api_calls_per_session).toBe(1);
      expect(usage.version_breakdown_30d.length).toBeGreaterThan(0);
      expect(funnel.recovered_profiles_excluded).toBe(0);
      expect(stages.registered).toBe(1);
      expect(stages.activated).toBe(1);
      expect(stages.aha).toBe(1);
      expect(stages.repeat).toBe(1);
      expect(network.total_indexed_skills).toBe(1);
      expect(network.indexed_skill_calls).toBe(2);
      expect(network.fresh_index_calls).toBe(0);
      expect(economics.route_calls_30d).toBe(2);
      expect(economics.discovery_queries_30d).toBe(0);
      expect(Object.keys(dashboard)).toEqual(expect.arrayContaining([
        "growth",
        "engagement",
        "usage",
        "funnel",
        "activation",
        "network",
        "economics",
        "pricing",
        "agent_health",
        "bottleneck",
      ]));
    } finally {
      await unbrowse.close({ shutdownBrowsers: false });
      backendServer.stop(true);
      targetServer.stop(true);
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });
});
