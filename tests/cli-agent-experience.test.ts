import { describe, expect, it } from "bun:test";

const ROOT = new URL("..", import.meta.url).pathname;

type RecordedRequest = {
  path: string;
  method: string;
  body: Record<string, unknown> | null;
};

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

async function runCli(baseUrl: string, args: string[]): Promise<{ code: number; stdout: string; stderr: string; body: Record<string, unknown> }> {
  const proc = Bun.spawn([process.execPath, "src/cli.ts", ...args, "--no-auto-start"], {
    cwd: ROOT,
    env: {
      ...process.env,
      UNBROWSE_URL: baseUrl,
      UNBROWSE_DISABLE_AUTO_UPDATE: "1",
    },
    stdout: "pipe",
    stderr: "pipe",
  });

  const [code, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);

  return {
    code,
    stdout,
    stderr,
    body: JSON.parse(stdout.trim() || "{}") as Record<string, unknown>,
  };
}

describe("cli agent experience", () => {
  it("falls back from payment_required to free live capture on resolve", async () => {
    let resolveCalls = 0;

    await withStubServer(async (req, requests) => {
      const path = new URL(req.url).pathname;
      if (path === "/v1/intent/resolve") {
        resolveCalls += 1;
        const body = requests.at(-1)?.body ?? {};
        if (resolveCalls === 1) {
          expect(body.force_capture).toBeUndefined();
          return Response.json({
            trace: { trace_id: "t1", skill_id: "marketplace-search", endpoint_id: "search", success: false, status_code: 402 },
            result: {
              error: "payment_required",
              indexing_fallback_available: true,
              next_step: "Pay or force capture",
            },
            source: "marketplace",
          });
        }

        expect(body.force_capture).toBe(true);
        return Response.json({
          trace: { trace_id: "t2", skill_id: "local-skill", endpoint_id: "", success: true },
          result: { skill_id: "local-skill", message: "captured" },
          available_endpoints: [{ endpoint_id: "ep-live", score: 10 }],
          source: "live-capture",
          skill: { skill_id: "local-skill" },
        });
      }
      if (path === "/health") return Response.json({ status: "ok" });
      return new Response("not found", { status: 404 });
    }, async (baseUrl) => {
      const out = await runCli(baseUrl, [
        "resolve",
        "--intent", "get feed posts",
        "--url", "https://www.linkedin.com/feed/",
      ]);

      expect(out.code).toBe(0);
      expect(out.body.source).toBe("live-capture");
      expect(resolveCalls).toBe(2);
      expect(out.stderr).toContain("Falling back to free live capture");
    });
  });

  it("tries browser cookie import before interactive login on auth_required", async () => {
    let resolveCalls = 0;
    let loginCalls = 0;
    let stealCalls = 0;

    await withStubServer(async (req) => {
      const path = new URL(req.url).pathname;
      if (path === "/v1/intent/resolve") {
        resolveCalls += 1;
        if (resolveCalls === 1) {
          return Response.json({
            result: {
              error: "auth_required",
              login_url: "https://x.com/home",
            },
          });
        }
        return Response.json({
          trace: { trace_id: "t2", skill_id: "x-skill", endpoint_id: "", success: true },
          result: { skill_id: "x-skill", message: "ready" },
          available_endpoints: [{ endpoint_id: "ep-x", score: 10 }],
          skill: { skill_id: "x-skill" },
          source: "live-capture",
        });
      }
      if (path === "/v1/auth/steal") {
        stealCalls += 1;
        return Response.json({ success: true, cookies_stored: 3 });
      }
      if (path === "/v1/auth/login") {
        loginCalls += 1;
        return Response.json({ success: true, cookies_stored: 2 });
      }
      if (path === "/health") return Response.json({ status: "ok" });
      return new Response("not found", { status: 404 });
    }, async (baseUrl) => {
      const out = await runCli(baseUrl, [
        "resolve",
        "--intent", "get timeline",
        "--url", "https://x.com/home",
      ]);

      expect(out.code).toBe(0);
      expect(out.body.source).toBe("live-capture");
      expect(resolveCalls).toBe(2);
      expect(stealCalls).toBe(1);
      expect(loginCalls).toBe(0);
      expect(out.stderr).toContain("Trying browser cookie import first");
    });
  });

  it("falls back to interactive login when browser cookie import has nothing reusable", async () => {
    let resolveCalls = 0;
    let loginCalls = 0;

    await withStubServer(async (req) => {
      const path = new URL(req.url).pathname;
      if (path === "/v1/intent/resolve") {
        resolveCalls += 1;
        if (resolveCalls === 1) {
          return Response.json({
            result: {
              error: "auth_required",
              login_url: "https://x.com/home",
            },
          });
        }
        return Response.json({
          trace: { trace_id: "t2", skill_id: "x-skill", endpoint_id: "", success: true },
          result: { skill_id: "x-skill", message: "ready" },
          available_endpoints: [{ endpoint_id: "ep-x", score: 10 }],
          skill: { skill_id: "x-skill" },
          source: "live-capture",
        });
      }
      if (path === "/v1/auth/steal") {
        return Response.json({ success: false, cookies_stored: 0 });
      }
      if (path === "/v1/auth/login") {
        loginCalls += 1;
        return Response.json({ success: true, cookies_stored: 2 });
      }
      if (path === "/health") return Response.json({ status: "ok" });
      return new Response("not found", { status: 404 });
    }, async (baseUrl) => {
      const out = await runCli(baseUrl, [
        "resolve",
        "--intent", "get timeline",
        "--url", "https://x.com/home",
      ]);

      expect(out.code).toBe(0);
      expect(out.body.source).toBe("live-capture");
      expect(resolveCalls).toBe(2);
      expect(loginCalls).toBe(1);
      expect(out.stderr).toContain("Opening browser for login");
    });
  });

  it("preserves top-level resolve errors instead of slimming them to an empty object", async () => {
    await withStubServer(async (req) => {
      const path = new URL(req.url).pathname;
      if (path === "/v1/intent/resolve") {
        return Response.json({
          error: "connection_failed",
          message: "Unable to connect. Is the computer able to access the url?",
          login_url: "https://x.com/",
          provider: "network",
        });
      }
      if (path === "/health") return Response.json({ status: "ok" });
      return new Response("not found", { status: 404 });
    }, async (baseUrl) => {
      const out = await runCli(baseUrl, [
        "resolve",
        "--intent", "search tweets",
        "--url", "https://x.com",
      ]);

      expect(out.code).toBe(0);
      expect(out.body.error).toBe("connection_failed");
      expect(out.body.message).toContain("Unable to connect");
      expect(out.body.login_url).toBe("https://x.com/");
      expect(out.body.provider).toBe("network");
    });
  });
});
