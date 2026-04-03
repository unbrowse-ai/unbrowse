import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import app from "../backend/src/index.js";
import type { Env, SkillManifest } from "../backend/src/types.js";

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
  "UNBROWSE_API_KEY",
  "UNBROWSE_BACKEND_URL",
  "UNBROWSE_CONFIG_DIR",
  "UNBROWSE_SKILL_CACHE_DIR",
  "TRACES_DIR",
  "UNBROWSE_LOCAL_ONLY",
  "UNBROWSE_NON_INTERACTIVE",
  "UNBROWSE_TOS_ACCEPTED",
];

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

async function waitForDashboard(
  backendPort: number,
  apiKey: string,
  predicate: (body: any) => boolean,
): Promise<any> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const res = await fetch(`http://127.0.0.1:${backendPort}/v1/dashboard/me`, {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    if (res.ok) {
      const body = await res.json();
      if (predicate(body)) return body;
    }
    await Bun.sleep(100);
  }
  throw new Error("dashboard telemetry did not arrive in time");
}

describe("dashboard telemetry e2e", () => {
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

  it("flows orchestrator speed and cost savings into the dashboard read model", async () => {
    const store = new Map<string, string>();
    globalThis.fetch = createMockFetch(store, originalFetch) as typeof fetch;

    const backendPort = 8798;
    const targetPort = 8799;
    const apiKey = "telemetry-e2e-key";
    const tempRoot = join("/tmp", `unbrowse-dashboard-telemetry-${process.pid}-${Date.now()}`);
    const configDir = join(tempRoot, "config");
    const cacheDir = join(tempRoot, "skill-cache");
    const snapshotDir = join(homedir(), ".unbrowse", "skill-snapshots");
    const snapshotFile = join(snapshotDir, `dashboard-telemetry-${process.pid}-${Date.now()}.json`);

    for (const key of touchedEnvKeys) {
      originalEnv.set(key, process.env[key]);
    }
    process.env.UNBROWSE_BACKEND_URL = `http://127.0.0.1:${backendPort}`;
    process.env.UNBROWSE_API_KEY = apiKey;
    process.env.UNBROWSE_CONFIG_DIR = configDir;
    process.env.UNBROWSE_SKILL_CACHE_DIR = cacheDir;
    process.env.TRACES_DIR = join(tempRoot, "traces");
    process.env.UNBROWSE_LOCAL_ONLY = "0";
    process.env.UNBROWSE_NON_INTERACTIVE = "1";
    process.env.UNBROWSE_TOS_ACCEPTED = "1";

    mkdirSync(configDir, { recursive: true });
    mkdirSync(snapshotDir, { recursive: true });
    writeFileSync(join(configDir, "config.json"), JSON.stringify({
      api_key: apiKey,
      agent_id: "staging_telemetr",
      agent_name: "telemetry-e2e",
      registered_at: new Date().toISOString(),
      tos_accepted_version: "2026-01-01",
      tos_accepted_at: new Date().toISOString(),
    }));

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

    const now = new Date().toISOString();
    const skill: SkillManifest = {
      skill_id: "local:dashboard-telemetry",
      version: "1.0.0",
      schema_version: "1",
      name: "dashboard-telemetry",
      intent_signature: "fetch telemetry items",
      domain: "localhost",
      description: "dashboard telemetry e2e skill",
      owner_type: "agent",
      execution_type: "http",
      lifecycle: "active",
      created_at: now,
      updated_at: now,
      discovery_cost: {
        capture_ms: 12_400,
        capture_tokens: 18_500,
        response_bytes: 4096,
        captured_at: now,
      },
      endpoints: [
        {
          endpoint_id: "items",
          method: "GET",
          url_template: `http://localhost:${targetPort}/items`,
          description: "Fetch telemetry items",
          idempotency: "safe",
          verification_status: "verified",
          reliability_score: 1,
          response_schema: {
            type: "object",
            inferred_from_samples: 1,
            properties: {
              items: {
                type: "array",
                inferred_from_samples: 1,
                items: {
                  type: "object",
                  inferred_from_samples: 1,
                  properties: {
                    id: { type: "number", inferred_from_samples: 1 },
                    title: { type: "string", inferred_from_samples: 1 },
                  },
                },
              },
            },
          },
        },
      ],
    };

    const { cachePublishedSkill } = await import("../src/client/index.js");
    const { resolveAndExecute } = await import("../src/orchestrator/index.js");
    cachePublishedSkill(skill);
    writeFileSync(snapshotFile, JSON.stringify(skill));

    try {
      const result = await resolveAndExecute(
        "fetch telemetry items",
        {},
        { url: `http://localhost:${targetPort}/items` },
      );

      expect(result.trace.success).toBe(true);
      expect(result.source).toBe("marketplace");

      const dashboard = await waitForDashboard(
        backendPort,
        apiKey,
        (body) => body?.savings?.baseline_cost_uc != null && body?.savings?.actual_cost_uc != null,
      );

      expect(dashboard.savings.baseline_time_ms).toBe(12_400);
      expect(dashboard.savings.actual_time_ms).toBeGreaterThan(0);
      expect(dashboard.savings.time_saved_ms).toBeGreaterThan(0);
      expect(dashboard.savings.speedup_ratio).toBeGreaterThan(1);
      expect(dashboard.savings.baseline_cost_uc).toBe(18_500 * 3);
      expect(dashboard.savings.actual_cost_uc).toBeGreaterThan(0);
      expect(dashboard.savings.cost_saved_uc).toBeGreaterThan(0);
    } finally {
      backendServer.stop(true);
      targetServer.stop(true);
      rmSync(snapshotFile, { force: true });
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });
});
