import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname;
const tempDirs: string[] = [];

type RecordedRequest = {
  path: string;
  method: string;
  body: Record<string, unknown> | null;
};

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

async function withStubServer(
  handler: (req: Request, requests: RecordedRequest[]) => Promise<Response> | Response,
  run: (baseUrl: string, requests: RecordedRequest[]) => Promise<void>,
): Promise<void> {
  const requests: RecordedRequest[] = [];
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const bodyText = req.method === "GET" ? "" : await req.text();
      requests.push({
        path: new URL(req.url).pathname,
        method: req.method,
        body: bodyText ? JSON.parse(bodyText) as Record<string, unknown> : null,
      });
      return handler(req, requests);
    },
  });

  try {
    await run(`http://127.0.0.1:${server.port}`, requests);
  } finally {
    await server.stop();
  }
}

async function runCli(
  baseUrl: string,
  args: string[],
  envOverrides: Record<string, string> = {},
): Promise<{ code: number; stdout: string; stderr: string }> {
  const configDir = makeTempDir("unbrowse-cli-telemetry-");
  const proc = Bun.spawn([process.execPath, "src/cli.ts", ...args, "--no-auto-start"], {
    cwd: ROOT,
    env: {
      ...process.env,
      UNBROWSE_URL: baseUrl,
      UNBROWSE_BACKEND_URL: baseUrl,
      UNBROWSE_API_KEY: "test-key",
      UNBROWSE_CONFIG_DIR: configDir,
      UNBROWSE_DISABLE_AUTO_UPDATE: "1",
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

  return { code, stdout, stderr };
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("cli funnel telemetry", () => {
  it("emits install-first-seen and resolve funnel events on the real CLI path", async () => {
    await withStubServer(async (req) => {
      const path = new URL(req.url).pathname;
      if (path === "/v1/intent/resolve") {
        return Response.json({
          trace: { trace_id: "t1", skill_id: "skill-1", endpoint_id: "ep-1", success: true },
          result: { items: [{ id: 1 }] },
          source: "marketplace",
          skill: { skill_id: "skill-1" },
        });
      }
      if (path === "/v1/telemetry/install") {
        return Response.json({ ok: true, event_id: "install-evt" });
      }
      if (path === "/v1/telemetry/events") {
        return Response.json({ ok: true, event_id: "funnel-evt" });
      }
      if (path === "/health") return Response.json({ status: "ok" });
      return new Response("not found", { status: 404 });
    }, async (baseUrl, requests) => {
      const out = await runCli(baseUrl, [
        "resolve",
        "--intent", "get items",
        "--url", "https://example.com/items",
      ]);

      expect(out.code).toBe(0);

      const installEvents = requests
        .filter((req) => req.path === "/v1/telemetry/install")
        .map((req) => req.body);
      expect(installEvents).toContainEqual(expect.objectContaining({
        source: "cli-first-seen",
        skill: "unbrowse",
      }));

      const funnelNames = requests
        .filter((req) => req.path === "/v1/telemetry/events")
        .map((req) => req.body?.name);
      expect(funnelNames).toEqual(expect.arrayContaining([
        "cli_invoked",
        "resolve_started",
        "resolve_completed",
      ]));

      const resolveCompleted = requests.find((req) =>
        req.path === "/v1/telemetry/events" && req.body?.name === "resolve_completed",
      );
      expect(resolveCompleted?.body).toEqual(expect.objectContaining({
        source: "cli",
        host_type: "cli",
        properties: expect.objectContaining({
          intent: "get items",
          domain: "example.com",
          url: "https://example.com/items",
        }),
      }));
    });
  });

  it("emits search telemetry with intent and domain", async () => {
    await withStubServer(async (req) => {
      const path = new URL(req.url).pathname;
      if (path === "/v1/search/domain") {
        return Response.json({ results: [{ id: 1, score: 0.9, metadata: { domain: "stripe.com" } }] });
      }
      if (path === "/v1/telemetry/install") {
        return Response.json({ ok: true, event_id: "install-evt" });
      }
      if (path === "/v1/telemetry/events") {
        return Response.json({ ok: true, event_id: "funnel-evt" });
      }
      if (path === "/health") return Response.json({ status: "ok" });
      return new Response("not found", { status: 404 });
    }, async (baseUrl, requests) => {
      const out = await runCli(baseUrl, [
        "search",
        "--intent", "create checkout session",
        "--domain", "stripe.com",
      ]);

      expect(out.code).toBe(0);

      const started = requests.find((req) =>
        req.path === "/v1/telemetry/events" && req.body?.name === "search_started",
      );
      expect(started?.body).toEqual(expect.objectContaining({
        properties: expect.objectContaining({
          intent: "create checkout session",
          domain: "stripe.com",
        }),
      }));

      const completed = requests.find((req) =>
        req.path === "/v1/telemetry/events" && req.body?.name === "search_completed",
      );
      expect(completed?.body).toEqual(expect.objectContaining({
        properties: expect.objectContaining({
          intent: "create checkout session",
          domain: "stripe.com",
          result_count: 1,
        }),
      }));
    });
  });

  it("forwards landing token from env on install and funnel telemetry", async () => {
    await withStubServer(async (req) => {
      const path = new URL(req.url).pathname;
      if (path === "/v1/intent/resolve") {
        return Response.json({
          trace: { trace_id: "t1", skill_id: "skill-1", endpoint_id: "ep-1", success: true },
          result: { items: [{ id: 1 }] },
          source: "marketplace",
          skill: { skill_id: "skill-1" },
        });
      }
      if (path === "/v1/telemetry/install") {
        return Response.json({ ok: true, event_id: "install-evt" });
      }
      if (path === "/v1/telemetry/events") {
        return Response.json({ ok: true, event_id: "funnel-evt" });
      }
      if (path === "/health") return Response.json({ status: "ok" });
      return new Response("not found", { status: 404 });
    }, async (baseUrl, requests) => {
      const out = await runCli(baseUrl, [
        "resolve",
        "--intent", "get items",
        "--url", "https://example.com/items",
      ], {
        UNBROWSE_LANDING_TOKEN: "landing-token-test",
      });

      expect(out.code).toBe(0);

      const installEvents = requests.filter((req) => req.path === "/v1/telemetry/install");
      expect(installEvents.length).toBeGreaterThan(0);
      for (const req of installEvents) {
        expect(req.body).toEqual(expect.objectContaining({
          landing_token: "landing-token-test",
        }));
      }

      const funnelEvents = requests.filter((req) => req.path === "/v1/telemetry/events");
      expect(funnelEvents.length).toBeGreaterThan(0);
      for (const req of funnelEvents) {
        expect(req.body).toEqual(expect.objectContaining({
          landing_token: "landing-token-test",
        }));
      }
    });
  });
});
