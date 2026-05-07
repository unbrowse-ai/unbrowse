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
  it("routes settings updates to the local settings endpoint", async () => {
    await withStubServer(async (req, requests) => {
      const path = new URL(req.url).pathname;
      if (path === "/v1/settings") {
        expect(requests.at(-1)?.body).toEqual({
          auto_publish_checkpoints: false,
          publish_domain_blacklist: ["linkedin.com", "x.com"],
          publish_domain_promptlist: ["github.com"],
        });
        return Response.json({
          ok: true,
          capture_pipeline: {
            auto_publish_checkpoints: false,
            publish_domain_blacklist: ["linkedin.com", "x.com"],
            publish_domain_promptlist: ["github.com"],
          },
          next_step: "Auto-publish after sync/close is disabled.",
        });
      }
      if (path === "/health") return Response.json({ status: "ok" });
      return new Response("not found", { status: 404 });
    }, async (baseUrl, requests) => {
      const out = await runCli(baseUrl, [
        "settings",
        "--auto-publish", "off",
        "--publish-blacklist", "linkedin.com,x.com",
        "--publish-promptlist", "github.com",
      ]);

      expect(out.code).toBe(0);
      expect(out.body.capture_pipeline).toBeDefined();
      expect(out.body.next_step).toContain("Auto-publish");
      expect(requests.some((entry) => entry.path === "/v1/settings" && entry.method === "POST")).toBe(true);
    });
  });

  it("routes index to the local-only skill reindex endpoint", async () => {
    await withStubServer(async (req) => {
      const path = new URL(req.url).pathname;
      if (path === "/v1/skills/skill-123/index") {
        return Response.json({ ok: true, skill_id: "skill-123", indexed: true, publish_status: "indexed" });
      }
      if (path === "/health") return Response.json({ status: "ok" });
      return new Response("not found", { status: 404 });
    }, async (baseUrl, requests) => {
      const out = await runCli(baseUrl, [
        "index",
        "--skill", "skill-123",
      ]);

      expect(out.code).toBe(0);
      expect(out.body.publish_status).toBe("indexed");
      expect(requests.some((entry) => entry.path === "/v1/skills/skill-123/index" && entry.method === "POST")).toBe(true);
    });
  });

  it("forwards confirm_publish when explicitly publishing a guarded skill", async () => {
    await withStubServer(async (req, requests) => {
      const path = new URL(req.url).pathname;
      if (path === "/v1/skills/skill-123/publish") {
        expect(requests.at(-1)?.body).toEqual({
          endpoints: [{ endpoint_id: "ep-1", description: "test" }],
          confirm_publish: true,
        });
        return Response.json({
          ok: true,
          skill_id: "skill-123",
          publish_status: "published",
          next_step: "Remote share completed.",
        });
      }
      if (path === "/health") return Response.json({ status: "ok" });
      return new Response("not found", { status: 404 });
    }, async (baseUrl, requests) => {
      const out = await runCli(baseUrl, [
        "publish",
        "--skill", "skill-123",
        "--confirm-publish",
        "--endpoints", '[{"endpoint_id":"ep-1","description":"test"}]',
      ]);

      expect(out.code).toBe(0);
      expect(out.body.publish_status).toBe("published");
      expect(requests.some((entry) => entry.path === "/v1/skills/skill-123/publish" && entry.method === "POST")).toBe(true);
    });
  });

  it("does not force-capture after payment_required on resolve", async () => {
    let resolveCalls = 0;

    await withStubServer(async (req, requests) => {
      const path = new URL(req.url).pathname;
      if (path === "/v1/intent/resolve") {
        resolveCalls += 1;
        const body = requests.at(-1)?.body ?? {};
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
      if (path === "/health") return Response.json({ status: "ok" });
      return new Response("not found", { status: 404 });
    }, async (baseUrl) => {
      const out = await runCli(baseUrl, [
        "resolve",
        "--intent", "get feed posts",
        "--url", "https://www.linkedin.com/feed/",
      ]);

      expect(out.code).toBe(0);
      expect(out.body.result.error).toBe("payment_required");
      expect(resolveCalls).toBe(1);
      expect(out.stderr).not.toContain("free live capture");
    });
  });

  it("surfaces auth_required without auto-login side effects", async () => {
    let resolveCalls = 0;

    await withStubServer(async (req) => {
      const path = new URL(req.url).pathname;
      if (path === "/v1/intent/resolve") {
        resolveCalls += 1;
        return Response.json({
          result: {
            error: "auth_required",
            login_url: "https://x.com/home",
          },
        });
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
      expect(out.body.result.error).toBe("auth_required");
      expect(resolveCalls).toBe(1);
      expect(out.stderr).toContain('unbrowse auth-capture --url "https://x.com/home"');
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

  it("does not auto-execute policy-gated endpoints without explicit third-party terms confirmation", async () => {
    await withStubServer(async (req) => {
      const path = new URL(req.url).pathname;
      if (path === "/v1/intent/resolve") {
        return Response.json({
          trace: { trace_id: "t2", skill_id: "x-skill", endpoint_id: "", success: true },
          result: null,
          available_endpoints: [{
            endpoint_id: "post-tweet",
            score: 10,
            method: "POST",
            description: "Create post on X",
            requires_third_party_terms_confirmation: true,
            third_party_terms_policy_domain: "x.com",
          }],
          skill: { skill_id: "x-skill" },
          source: "live-capture",
        });
      }
      if (path === "/health") return Response.json({ status: "ok" });
      if (path === "/v1/skills/x-skill/execute") {
        return Response.json({ error: "should_not_execute" }, { status: 500 });
      }
      return new Response("not found", { status: 404 });
    }, async (baseUrl, requests) => {
      const out = await runCli(baseUrl, [
        "resolve",
        "--intent", "post tweet",
        "--url", "https://x.com/compose/post",
        "--execute",
      ]);

      expect(out.code).toBe(0);
      expect(requests.filter((req) => req.path === "/v1/skills/x-skill/execute")).toHaveLength(0);
      expect(out.stderr).toContain("requires explicit third-party terms confirmation");
    });
  });
});
