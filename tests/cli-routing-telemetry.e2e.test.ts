import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import app from "../backend/src/index.js";
import { statsKV } from "../backend/src/services/kv.js";
import type { Env, RoutingTelemetryEvent, RoutingTelemetrySummary } from "../backend/src/types.js";
import type { SkillManifest } from "../src/types/index.js";

const ROOT = new URL("..", import.meta.url).pathname;
const originalFetch = globalThis.fetch;
const tempDirs: string[] = [];

const env: Env = {
  API_KEY: "admin",
  UNKEY_ROOT_KEY: "root",
  UNKEY_API_ID: "api",
  EMERGENTDB_API_KEY: "test",
  NEBIUS_API_KEY: "nebius",
  STATS_KV: {} as KVNamespace,
  ENVIRONMENT: "staging",
};

const stubSkill: SkillManifest = {
  skill_id: "local-pypi-skill",
  version: "1.0.0",
  schema_version: "1",
  name: "PyPI Package Detail",
  intent_signature: "get package info",
  intents: ["get package info", "package info"],
  domain: "pypi.org",
  description: "Structured replay for PyPI package detail pages",
  owner_type: "agent",
  execution_type: "http",
  lifecycle: "active",
  created_at: "2026-04-03T00:00:00.000Z",
  updated_at: "2026-04-03T00:00:00.000Z",
  endpoints: [
    {
      endpoint_id: "package-info",
      method: "GET",
      url_template: "https://pypi.org/pypi/{slug_2}/json",
      idempotency: "safe",
      verification_status: "verified",
      reliability_score: 0.99,
      description: "Fetch package metadata for a PyPI project",
      response_schema: {
        type: "object",
        properties: {
          info: {
            type: "object",
            properties: {
              name: { type: "string" },
              version: { type: "string" },
              summary: { type: "string" },
            },
          },
        },
      },
    },
  ],
  operation_graph: {
    entry_operation_ids: ["op-package-info"],
    operations: [
      {
        operation_id: "op-package-info",
        endpoint_id: "package-info",
        method: "GET",
        url_template: "https://pypi.org/pypi/{slug_2}/json",
        action_kind: "read",
        resource_kind: "package",
        description_out: "PyPI package detail",
        requires: [{ key: "slug_2", required: true }],
        provides: [{ key: "info.name", required: false }],
      },
    ],
    edges: [],
  },
};

const execCtx = {
  waitUntil(_promise: Promise<unknown>) {},
  passThroughOnException() {},
};

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
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

async function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        reject(new Error("failed to allocate free port"));
        return;
      }
      const { port } = address;
      server.close((err) => err ? reject(err) : resolve(port));
    });
    server.on("error", reject);
  });
}

async function waitForServer(baseUrl: string, timeoutMs = 45_000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await originalFetch(`${baseUrl}/health`, { signal: AbortSignal.timeout(2_000) });
      if (res.ok) return;
    } catch {
      // retry
    }
    await Bun.sleep(500);
  }
  throw new Error(`server did not become healthy at ${baseUrl} within ${timeoutMs}ms`);
}

async function waitForRoutingSummary(
  backendBaseUrl: string,
  predicate: (summary: RoutingTelemetrySummary) => boolean,
  timeoutMs = 30_000,
): Promise<RoutingTelemetrySummary> {
  const start = Date.now();
  let lastBody: RoutingTelemetrySummary | undefined;
  while (Date.now() - start < timeoutMs) {
    const res = await originalFetch(`${backendBaseUrl}/v1/analytics/routing?days=1`, {
      headers: { Authorization: "Bearer admin" },
      signal: AbortSignal.timeout(5_000),
    });
    if (res.ok) {
      const body = await res.json() as RoutingTelemetrySummary;
      lastBody = body;
      if (predicate(body)) return body;
    }
    await Bun.sleep(500);
  }
  throw new Error(`routing analytics did not converge: ${JSON.stringify(lastBody ?? null)}`);
}

async function runCli(args: string[], envOverrides: Record<string, string>): Promise<{ code: number; stdout: string; stderr: string; body: any }> {
  const proc = Bun.spawn([process.execPath, "src/cli.ts", ...args, "--no-auto-start"], {
    cwd: ROOT,
    env: {
      ...process.env,
      ...envOverrides,
    },
    stdout: "pipe",
    stderr: "pipe",
  });

  const [code, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);

  let body: any;
  try {
    body = JSON.parse(stdout.trim() || "{}");
  } catch {
    throw new Error(`cli returned non-JSON stdout\nstdout:\n${stdout}\nstderr:\n${stderr}`);
  }

  return { code, stdout, stderr, body };
}

afterEach(() => {
  globalThis.fetch = originalFetch;
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("cli routing telemetry e2e", () => {
  // route not yet implemented — POST /v1/telemetry/routing, GET /v1/analytics/routing
  it.skip("stores sanitized routing telemetry from the real CLI path and surfaces it via analytics", async () => {
    const store = new Map<string, string>();
    globalThis.fetch = createMockFetch(store, originalFetch) as typeof fetch;
    await statsKV(env).resetSplitIndex();

    const backendServer = Bun.serve({
      port: 0,
      async fetch(request) {
        const url = new URL(request.url);
        if (url.pathname === "/v1/search/resolve") {
          return Response.json({
            domain_results: [
              {
                id: 1,
                score: 99.5,
                metadata: {
                  content: JSON.stringify({
                    skill_id: stubSkill.skill_id,
                    endpoint_id: "package-info",
                    domain: "pypi.org",
                  }),
                },
              },
            ],
            global_results: [],
            skipped_global: false,
          });
        }
        if (url.pathname === `/v1/skills/${stubSkill.skill_id}`) {
          return Response.json(stubSkill);
        }
        if (url.pathname === `/v1/skills/${stubSkill.skill_id}/chunk`) {
          return Response.json({
            skill_id: stubSkill.skill_id,
            intent: "get package info",
            missing_bindings: [],
            available_operations: [
              {
                operation_id: "op-package-info",
                endpoint_id: "package-info",
                action_kind: "read",
                resource_kind: "package",
                description_out: "PyPI package detail",
                requires: ["slug_2"],
                provides: ["info.name"],
                runnable: true,
              },
            ],
          });
        }
        if (
          url.pathname.startsWith("/v1/telemetry/") ||
          url.pathname.startsWith("/v1/analytics/") ||
          url.pathname.startsWith("/v1/agents/") ||
          url.pathname.startsWith("/v1/tos/") ||
          url.pathname.startsWith("/v1/stats/") ||
          url.pathname === "/v1/validate"
        ) {
          return app.fetch(request, env, execCtx);
        }
        return new Response("not found", { status: 404 });
      },
    });

    const tempRoot = makeTempDir("unbrowse-routing-telemetry-");
    const localPort = await getFreePort();
    const localBaseUrl = `http://127.0.0.1:${localPort}`;
    const backendBaseUrl = `http://127.0.0.1:${backendServer.port}`;
    const sharedEnv = {
      HOME: tempRoot,
      UNBROWSE_URL: localBaseUrl,
      UNBROWSE_BACKEND_URL: backendBaseUrl,
      UNBROWSE_CONFIG_DIR: join(tempRoot, "config"),
      UNBROWSE_SKILL_CACHE_DIR: join(tempRoot, "skill-cache"),
      UNBROWSE_RUN_DIR: join(tempRoot, "run"),
      TRACES_DIR: join(tempRoot, "traces"),
      UNBROWSE_DISABLE_AUTO_UPDATE: "1",
      UNBROWSE_NON_INTERACTIVE: "1",
      UNBROWSE_TOS_ACCEPTED: "1",
    };

    const serverProc = Bun.spawn([process.execPath, "src/index.ts"], {
      cwd: ROOT,
      env: {
        ...process.env,
        ...sharedEnv,
        HOST: "127.0.0.1",
        PORT: String(localPort),
      },
      stdout: "ignore",
      stderr: "pipe",
    });

    try {
      await waitForServer(localBaseUrl);

      const out = await runCli([
        "eval",
        "resolve",
        "--intent", "get package info",
        "--domain", "pypi.org",
        "--params", "{\"slug_2\":\"openai\"}",
        "--endpoint-id", "package-info",
        "--execute",
      ], sharedEnv);

      expect(out.code).toBe(0);
      expect(out.body.error).toBeUndefined();
      expect(out.body.result?.error).toBeUndefined();

      const initialStoredEvents = await statsKV(env).listWithValues("routing-event:");
      expect(initialStoredEvents.length).toBeGreaterThan(0);

      const summary = await waitForRoutingSummary(backendBaseUrl, (body) =>
        body.sessions >= 1 &&
        body.total_api_calls >= 1 &&
        body.avg_steps_per_session >= 1 &&
        body.top_intents.some((entry) => entry.intent === "get package info") &&
        body.top_domains.some((entry) => entry.domain === "pypi.org"),
      );

      expect(summary.sessions).toBe(1);
      expect(summary.total_api_calls).toBeGreaterThanOrEqual(1);
      expect(summary.source_performance.length).toBeGreaterThan(0);
      expect(summary.top_intents).toEqual(expect.arrayContaining([
        expect.objectContaining({ intent: "get package info" }),
      ]));
      expect(summary.top_domains).toEqual(expect.arrayContaining([
        expect.objectContaining({ domain: "pypi.org" }),
      ]));

      const storedEvents = await statsKV(env).listWithValues("routing-event:");
      expect(storedEvents.length).toBeGreaterThanOrEqual(4);

      const events = storedEvents.map((entry) => JSON.parse(entry.value) as RoutingTelemetryEvent);
      const eventTypes = new Set(events.map((event) => event.event_type));
      expect(eventTypes.has("routing_session_started")).toBe(true);
      expect(eventTypes.has("routing_candidates_ranked")).toBe(true);
      expect(eventTypes.has("routing_step_executed")).toBe(true);
      expect(eventTypes.has("routing_session_completed")).toBe(true);

      const serialized = JSON.stringify(events);
      expect(serialized).not.toContain("\"slug_2\":\"openai\"");
      expect(serialized).not.toContain("\"email\":");
    } finally {
      serverProc.kill();
      backendServer.stop(true);
    }
  }, 180_000);
});
