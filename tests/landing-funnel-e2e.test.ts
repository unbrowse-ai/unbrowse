import { afterEach, describe, expect, it } from "bun:test";
import { join } from "node:path";
import app from "../backend/src/index.js";
import { skillsKV, statsKV } from "../backend/src/services/kv.js";
import type { Env } from "../backend/src/types.js";
import type { LandingHomepageExperimentConfig } from "../backend/src/services/landing-experiments.js";

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
  "UNBROWSE_LANDING_TOKEN",
];

function isoHoursAgo(hours: number): string {
  return new Date(Date.now() - hours * 3600_000).toISOString();
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

async function runBunEval(
  code: string,
  envOverrides: Record<string, string>,
): Promise<{ code: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn(["bun", "-e", code], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      ...envOverrides,
    },
    stdout: "pipe",
    stderr: "pipe",
  });

  const [codeExit, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);

  return { code: codeExit, stdout, stderr };
}

async function postLandingWebEvent(
  backendPort: number,
  payload: Record<string, unknown>,
): Promise<void> {
  const res = await fetch(`http://127.0.0.1:${backendPort}/v1/telemetry/web`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "cf-connecting-ip": "203.0.113.88",
    },
    body: JSON.stringify(payload),
  });
  expect(res.status).toBe(200);
}

async function mintLandingToken(
  backendPort: number,
  experimentId: string,
  variantId: string,
  visitorId: string,
  sessionId: string,
): Promise<string> {
  const res = await fetch(`http://127.0.0.1:${backendPort}/v1/landing/homepage/token`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      experiment_id: experimentId,
      variant_id: variantId,
      visitor_id: visitorId,
      session_id: sessionId,
    }),
  });
  expect(res.status).toBe(200);
  const body = await res.json() as { token: string };
  return body.token;
}

async function waitForLandingSummary(
  backendPort: number,
  predicate: (body: any) => boolean,
): Promise<any> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const res = await fetch(`http://127.0.0.1:${backendPort}/v1/analytics/landing-funnel?days=30`, {
      headers: { Authorization: "Bearer admin" },
    });
    if (res.ok) {
      const body = await res.json();
      if (predicate(body)) return body;
    }
    await Bun.sleep(100);
  }
  throw new Error("landing funnel analytics did not converge");
}

describe("landing funnel e2e", () => {
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

  it("flows signed landing attribution from token mint to CLI telemetry to landing analytics", async () => {
    const store = new Map<string, string>();
    globalThis.fetch = createMockFetch(store, originalFetch) as typeof fetch;
    await Promise.all([
      statsKV(env).resetSplitIndex(),
      skillsKV(env).resetSplitIndex(),
    ]);

    const backendPort = 8801;
    const tempRoot = join("/tmp", `unbrowse-landing-funnel-e2e-${process.pid}-${Date.now()}`);

    for (const key of touchedEnvKeys) {
      originalEnv.set(key, process.env[key]);
    }

    const backendServer = Bun.serve({
      port: backendPort,
      fetch(request) {
        return app.fetch(request, env, execCtx);
      },
    });

    try {
      const assignRes = await fetch(`http://127.0.0.1:${backendPort}/v1/landing/homepage/assign`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ visitor_id: "visitor-e2e" }),
      });
      expect(assignRes.status).toBe(200);
      const assigned = await assignRes.json() as {
        assignment: { experiment_id: string; variant_id: string };
      };

      const commonWeb = {
        visitor_id: "visitor-e2e",
        session_id: "session-e2e",
        experiment_id: assigned.assignment.experiment_id,
        variant_id: assigned.assignment.variant_id,
        path: "/?utm_campaign=landing-e2e",
        referrer: "https://x.com/getFoundry",
      };

      await postLandingWebEvent(backendPort, {
        ...commonWeb,
        name: "landing_page_viewed",
        created_at: isoHoursAgo(4),
        properties: { utm_campaign: "landing-e2e" },
      });
      await postLandingWebEvent(backendPort, {
        ...commonWeb,
        name: "hero_viewed",
        created_at: isoHoursAgo(4),
        properties: { utm_campaign: "landing-e2e" },
      });
      await postLandingWebEvent(backendPort, {
        ...commonWeb,
        name: "scroll_depth_reached",
        created_at: isoHoursAgo(3),
        properties: { bucket: 90, utm_campaign: "landing-e2e" },
      });
      await postLandingWebEvent(backendPort, {
        ...commonWeb,
        name: "section_viewed",
        created_at: isoHoursAgo(3),
        properties: { section_id: "install", utm_campaign: "landing-e2e" },
      });
      await postLandingWebEvent(backendPort, {
        ...commonWeb,
        name: "install_section_viewed",
        created_at: isoHoursAgo(3),
        properties: { section_id: "install", utm_campaign: "landing-e2e" },
      });
      await postLandingWebEvent(backendPort, {
        ...commonWeb,
        name: "exploration_page_clicked",
        created_at: isoHoursAgo(2),
        properties: { target_id: "compare_playwright", utm_campaign: "landing-e2e" },
      });
      await postLandingWebEvent(backendPort, {
        ...commonWeb,
        name: "page_exploration_depth_updated",
        created_at: isoHoursAgo(2),
        properties: { depth: 2, utm_campaign: "landing-e2e" },
      });
      await postLandingWebEvent(backendPort, {
        ...commonWeb,
        name: "install_command_copied",
        created_at: isoHoursAgo(2),
        properties: { tab_id: "hero-primary", tokenized: true, utm_campaign: "landing-e2e" },
      });

      const landingToken = await mintLandingToken(
        backendPort,
        assigned.assignment.experiment_id,
        assigned.assignment.variant_id,
        "visitor-e2e",
        "session-e2e",
      );

      const cliRun = await runBunEval(
        `
          const client = await import("./src/client/index.ts");
          await client.ensureCliInstallTracked("codex");
          await client.recordInstallTelemetryEvent("setup", {
            hostType: "codex",
            status: "started",
          });
          await client.recordFunnelTelemetryEvent("setup_completed", {
            source: "setup",
            hostType: "codex",
          });
          await client.recordFunnelTelemetryEvent("registration_succeeded", {
            source: "cli",
            hostType: "codex",
          });
          await client.recordFunnelTelemetryEvent("resolve_started", {
            source: "cli",
            hostType: "codex",
          });
          await client.recordFunnelTelemetryEvent("resolve_completed", {
            source: "cli",
            hostType: "codex",
            properties: { user_visible_result: true },
          });
          console.log(JSON.stringify({ installId: client.getInstallId() }));
        `,
        {
          UNBROWSE_BACKEND_URL: `http://127.0.0.1:${backendPort}`,
          UNBROWSE_API_KEY: "admin",
          UNBROWSE_CONFIG_DIR: join(tempRoot, "config"),
          UNBROWSE_SKILL_CACHE_DIR: join(tempRoot, "skill-cache"),
          TRACES_DIR: join(tempRoot, "traces"),
          UNBROWSE_LOCAL_ONLY: "0",
          UNBROWSE_NON_INTERACTIVE: "1",
          UNBROWSE_TOS_ACCEPTED: "1",
          UNBROWSE_LANDING_TOKEN: landingToken,
        },
      );

      expect(cliRun.code).toBe(0);
      expect(cliRun.stderr).toBe("");

      const summary = await waitForLandingSummary(backendPort, (body) =>
        Array.isArray(body?.variants)
          && body.variants.some((variant: any) => variant.variant_id === assigned.assignment.variant_id && variant.first_resolve_succeeded === 1),
      );

      const variant = summary.variants.find((entry: any) => entry.variant_id === assigned.assignment.variant_id);
      expect(variant).toBeTruthy();
      expect(variant.install_started).toBe(1);
      expect(variant.setup_completed).toBe(1);
      expect(variant.registrations).toBe(1);
      expect(variant.first_resolve_started).toBe(1);
      expect(variant.first_resolve_succeeded).toBe(1);
      expect(variant.top_campaigns[0]).toEqual({ campaign: "landing-e2e", sessions: 1 });
    } finally {
      backendServer.stop(true);
    }
  });

  it("runs the optimizer script against live analytics and updates config safely", async () => {
    const store = new Map<string, string>();
    globalThis.fetch = createMockFetch(store, originalFetch) as typeof fetch;
    await Promise.all([
      statsKV(env).resetSplitIndex(),
      skillsKV(env).resetSplitIndex(),
    ]);

    const backendPort = 8802;
    const backendServer = Bun.serve({
      port: backendPort,
      fetch(request) {
        return app.fetch(request, env, execCtx);
      },
    });

    try {
      const configRes = await fetch(`http://127.0.0.1:${backendPort}/v1/landing/homepage/config`, {
        headers: { Authorization: "Bearer admin" },
      });
      expect(configRes.status).toBe(200);
      const config = await configRes.json() as LandingHomepageExperimentConfig;
      const nextConfig: LandingHomepageExperimentConfig = {
        ...config,
        optimizer_runs: [],
        updated_at: new Date().toISOString(),
      };

      const saveRes = await fetch(`http://127.0.0.1:${backendPort}/v1/landing/homepage/config`, {
        method: "PUT",
        headers: {
          Authorization: "Bearer admin",
          "Content-Type": "application/json",
        },
        body: JSON.stringify(nextConfig),
      });
      expect(saveRes.status).toBe(200);

      const experimentId = config.experiment_id;
      const controlVariantId = config.control_variant_id;
      const speedVariantId = config.variants.find((variant) => variant.angle_family === "speed-proof")?.variant_id ?? config.variants[0].variant_id;
      const canaryVariantId = config.variants.find((variant) => variant.status === "canary")?.variant_id;
      expect(canaryVariantId).toBeTruthy();

      async function seedVariant(
        variantId: string,
        visitorPrefix: string,
        landingVisitors: number,
        successfulInstalls: number,
      ): Promise<void> {
        for (let index = 0; index < landingVisitors; index += 1) {
          const visitorId = `${visitorPrefix}-visitor-${index}`;
          const sessionId = `${visitorPrefix}-session-${index}`;
          await postLandingWebEvent(backendPort, {
            visitor_id: visitorId,
            session_id: sessionId,
            experiment_id: experimentId,
            variant_id: variantId,
            name: "landing_page_viewed",
            path: "/",
            referrer: "https://www.google.com/search?q=unbrowse",
            created_at: isoHoursAgo(6),
            properties: { utm_campaign: `${visitorPrefix}-campaign` },
          });
          await postLandingWebEvent(backendPort, {
            visitor_id: visitorId,
            session_id: sessionId,
            experiment_id: experimentId,
            variant_id: variantId,
            name: "install_command_copied",
            path: "/",
            referrer: "https://www.google.com/search?q=unbrowse",
            created_at: isoHoursAgo(5),
            properties: { tab_id: "cli", tokenized: true, utm_campaign: `${visitorPrefix}-campaign` },
          });

          if (index >= successfulInstalls) continue;
          const token = await mintLandingToken(backendPort, experimentId, variantId, visitorId, sessionId);
          const installId = `${visitorPrefix}-install-${index}`;

          const installRes = await fetch(`http://127.0.0.1:${backendPort}/v1/telemetry/install`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              install_id: installId,
              landing_token: token,
              source: "host",
              host_type: "codex",
              status: "installed",
              created_at: isoHoursAgo(4),
            }),
          });
          expect(installRes.status).toBe(200);

          for (const funnelEvent of [
            { name: "setup_completed", created_at: isoHoursAgo(3) },
            { name: "registration_succeeded", created_at: isoHoursAgo(3) },
            { name: "resolve_started", created_at: isoHoursAgo(2) },
            { name: "resolve_completed", created_at: isoHoursAgo(2), properties: { user_visible_result: true } },
          ]) {
            const res = await fetch(`http://127.0.0.1:${backendPort}/v1/telemetry/events`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                install_id: installId,
                landing_token: token,
                source: "cli",
                host_type: "codex",
                ...funnelEvent,
              }),
            });
            expect(res.status).toBe(200);
          }
        }
      }

      await seedVariant(controlVariantId, "control", 4, 1);
      await seedVariant(speedVariantId, "speed", 4, 3);
      await seedVariant(canaryVariantId!, "canary", 3, 0);

      const optimizeRun = await runBunEval(
        `await import("./scripts/landing-funnel-optimize.ts");`,
        {
          UNBROWSE_OPTIMIZER_API_URL: `http://127.0.0.1:${backendPort}`,
          UNBROWSE_OPTIMIZER_API_KEY: "admin",
          UNBROWSE_OPTIMIZER_MIN_CANARY_SAMPLE: "2",
          UNBROWSE_OPTIMIZER_PROMOTE_DELTA: "0.05",
          UNBROWSE_OPTIMIZER_DISABLE_DELTA: "0.05",
          UNBROWSE_OPTIMIZER_BOUNCE_DELTA_LIMIT: "0.5",
          UNBROWSE_OPTIMIZER_WINDOW_DAYS: "30",
        },
      );

      expect(optimizeRun.code).toBe(0);

      const updatedConfigRes = await fetch(`http://127.0.0.1:${backendPort}/v1/landing/homepage/config`, {
        headers: { Authorization: "Bearer admin" },
      });
      expect(updatedConfigRes.status).toBe(200);
      const updatedConfig = await updatedConfigRes.json() as LandingHomepageExperimentConfig;

      const updatedControl = updatedConfig.variants.find((variant) => variant.variant_id === controlVariantId);
      const updatedSpeed = updatedConfig.variants.find((variant) => variant.variant_id === speedVariantId);
      const updatedCanary = updatedConfig.variants.find((variant) => variant.variant_id === canaryVariantId);

      expect(updatedConfig.optimizer_runs?.length).toBe(1);
      expect(updatedSpeed?.weight).toBeGreaterThan(updatedControl?.weight ?? 0);
      expect(updatedCanary?.status).toBe("disabled");
      expect(updatedConfig.variants.some((variant) => variant.source === "auto_generated" && variant.status === "shadow")).toBe(true);
    } finally {
      backendServer.stop(true);
    }
  });
});
