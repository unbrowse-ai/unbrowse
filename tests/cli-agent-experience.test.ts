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
      UNBROWSE_LOCAL_ONLY: "1",
      UNBROWSE_RESOLVE_CACHE_TTL_MS: "0",
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
  it("accepts --task as an alias for --intent on resolve", async () => {
    await withStubServer(async (req, requests) => {
      const path = new URL(req.url).pathname;
      if (path === "/v1/intent/resolve") {
        expect(requests.at(-1)?.body?.intent).toBe("search listings");
        return Response.json({
          trace: { success: true },
          result: { status: "ok", items: [] },
        });
      }
      if (path === "/health") return Response.json({ status: "ok" });
      return new Response("not found", { status: 404 });
    }, async (baseUrl) => {
      const out = await runCli(baseUrl, [
        "resolve",
        "--url", "https://www.carousell.sg/search/beige%20shirt",
        "--task", "search listings",
      ]);

      expect(out.code).toBe(0);
      expect(out.body.result).toEqual({ status: "ok", items: [] });
    });
  });

  it("accepts --query as an alias for --intent on resolve", async () => {
    await withStubServer(async (req, requests) => {
      const path = new URL(req.url).pathname;
      if (path === "/v1/intent/resolve") {
        expect(requests.at(-1)?.body?.intent).toBe("beige sweater Serangoon");
        return Response.json({
          trace: { success: true },
          result: { status: "ok", items: [] },
        });
      }
      if (path === "/health") return Response.json({ status: "ok" });
      return new Response("not found", { status: 404 });
    }, async (baseUrl) => {
      const out = await runCli(baseUrl, [
        "resolve",
        "--url", "https://www.carousell.sg",
        "--query", "beige sweater Serangoon",
      ]);

      expect(out.code).toBe(0);
      expect(out.body.result).toEqual({ status: "ok", items: [] });
    });
  });

  it("accepts --intent on canonical read resolve and returns the agent-facing resolve envelope", async () => {
    await withStubServer(async (req, requests) => {
      const path = new URL(req.url).pathname;
      if (path === "/v1/intent/resolve") {
        expect(requests.at(-1)?.body).toMatchObject({
          intent: "resolve repository data for github.com",
          params: { url: "https://github.com" },
          context: { url: "https://github.com" },
        });
        return Response.json({
          trace: {
            success: true,
            skill_id: "direct-document",
            endpoint_id: "direct-document",
          },
          source: "direct-document",
          impact: { source: "direct-document", browser_avoided: true },
          result: {
            title: "GitHub",
            url: "https://github.com",
            text_excerpt: "GitHub page content",
            extraction: { source: "direct-document", rejected: false },
          },
        });
      }
      if (path === "/health") return Response.json({ status: "ok" });
      return new Response("not found", { status: 404 });
    }, async (baseUrl) => {
      const proc = Bun.spawn([
        process.execPath,
        "src/cli.ts",
        "read",
        "resolve",
        "--intent", "resolve repository data for github.com",
        "--url", "https://github.com",
        "--json",
        "--no-auto-start",
      ], {
        cwd: ROOT,
        env: {
          ...process.env,
          UNBROWSE_URL: baseUrl,
          UNBROWSE_DISABLE_AUTO_UPDATE: "1",
          UNBROWSE_LOCAL_ONLY: "1",
          UNBROWSE_NO_SWEEP: "1",
        },
        stdout: "pipe",
        stderr: "pipe",
      });

      const [code, stdout, stderr] = await Promise.all([
        proc.exited,
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
      ]);

      expect(code).toBe(0);
      expect(stderr).not.toContain("intent_required");
      const body = JSON.parse(stdout.trim()) as Record<string, unknown>;
      expect(body.source).toBe("direct-document");
      const result = body.result as Record<string, unknown>;
      expect(result.available_operations).toEqual([
        expect.objectContaining({
          endpoint_id: "direct-document-read",
          url_template: "https://github.com",
        }),
      ]);
      expect(result.suggested_next_operation_id).toBe("direct-document-read");
      expect(result.next_action).toMatchObject({ title: "Use returned direct-document data" });
      expect(JSON.stringify(result.next_action)).toContain("unbrowse read resolve");
    });
  });

  it("runs a URL and positional task through resolve without requiring flag juggling", async () => {
    await withStubServer(async (req, requests) => {
      const path = new URL(req.url).pathname;
      if (path === "/v1/intent/resolve") {
        expect(requests.at(-1)?.body).toMatchObject({
          intent: "list beige shirts",
          params: { url: "https://www.carousell.sg/search/beige%20shirt" },
          context: { url: "https://www.carousell.sg/search/beige%20shirt" },
        });
        return Response.json({
          trace: { success: true },
          result: { status: "ok", items: [{ title: "beige shirt" }] },
        });
      }
      if (path === "/health") return Response.json({ status: "ok" });
      return new Response("not found", { status: 404 });
    }, async (baseUrl) => {
      const out = await runCli(baseUrl, [
        "run",
        "https://www.carousell.sg/search/beige%20shirt",
        "list beige shirts",
      ]);

      expect(out.code).toBe(0);
      expect(out.body.result).toEqual({ status: "ok", items: [{ title: "beige shirt" }] });
    });
  });

  it("adds agent-facing operation guidance to direct-document resolve results", async () => {
    await withStubServer(async (req) => {
      const path = new URL(req.url).pathname;
      if (path === "/v1/intent/resolve") {
        return Response.json({
          trace: {
            success: true,
            skill_id: "direct-document",
            endpoint_id: "direct-document",
          },
          source: "direct-document",
          impact: { source: "direct-document", browser_avoided: true },
          result: {
            title: "GitHub",
            url: "https://github.com",
            text_excerpt: "GitHub page content",
            extraction: { source: "direct-document", rejected: false },
          },
        });
      }
      if (path === "/health") return Response.json({ status: "ok" });
      return new Response("not found", { status: 404 });
    }, async (baseUrl) => {
      const out = await runCli(baseUrl, [
        "resolve",
        "--url", "https://github.com",
        "--intent", "resolve repository data for github.com",
      ]);

      expect(out.code).toBe(0);
      const result = out.body.result as Record<string, unknown>;
      expect(result.available_operations).toEqual([
        expect.objectContaining({
          operation: "read_returned_direct_document",
          endpoint_id: "direct-document-read",
          method: "GET",
          url_template: "https://github.com",
        }),
      ]);
      expect(result.suggested_next_operation_id).toBe("direct-document-read");
      expect(result.next_action).toMatchObject({
        title: "Use returned direct-document data",
      });
      expect(JSON.stringify(result.next_action)).toContain("unbrowse read resolve");
      expect(JSON.stringify(result.next_action)).toContain("--force-capture");
      expect(out.body.source).toBe("direct-document");
    });
  });

  it("adds auth handoff requirements to auth-shaped direct-document resolve results", async () => {
    await withStubServer(async (req) => {
      const path = new URL(req.url).pathname;
      if (path === "/v1/intent/resolve") {
        return Response.json({
          trace: {
            success: true,
            skill_id: "direct-document",
            endpoint_id: "direct-document",
          },
          source: "direct-document",
          impact: { source: "direct-document", browser_avoided: true },
          result: {
            url: "https://mail.google.com",
            data: {},
            extraction: { source: "direct-document", rejected: false },
          },
        });
      }
      if (path === "/health") return Response.json({ status: "ok" });
      return new Response("not found", { status: 404 });
    }, async (baseUrl) => {
      const out = await runCli(baseUrl, [
        "resolve",
        "--url", "https://mail.google.com",
        "--intent", "resolve the authenticated workflow surface and report the next required user action if auth is needed for mail.google.com",
      ]);

      expect(out.code).toBe(0);
      const result = out.body.result as Record<string, unknown>;
      const requirements = result.requirements as Record<string, unknown>;
      const auth = requirements.auth_handoff as Record<string, unknown>;
      expect(result.status).toBe("needs_input");
      expect(auth).toMatchObject({
        login_required: true,
        domain: "mail.google.com",
        web_login_url: "https://mail.google.com/",
        reason: "auth_likely_intent",
      });
      expect(JSON.stringify(auth)).toContain("unbrowse auth");
      expect(result.next_action).toMatchObject({
        title: "Authenticate with site, then retry resolve",
        command: "unbrowse auth 'https://mail.google.com/'",
      });
      expect(result.suggested_next_operation_id).toBe("auth-handoff");
      expect(result.available_operations).toEqual([
        expect.objectContaining({
          operation: "authenticate_site_then_retry",
          endpoint_id: "auth-handoff",
          url_template: "https://mail.google.com/",
          requires_auth: true,
        }),
        expect.objectContaining({
          operation: "read_returned_direct_document",
          endpoint_id: "direct-document-read",
          url_template: "https://mail.google.com",
        }),
      ]);
    });
  });

  it("auto-executes a safe direct endpoint from run", async () => {
    await withStubServer(async (req, requests) => {
      const path = new URL(req.url).pathname;
      if (path === "/v1/intent/resolve") {
        return Response.json({
          skill: { skill_id: "skill-carousell" },
          available_endpoints: [
            { endpoint_id: "ep-search", method: "GET", description: "Search listings" },
          ],
        });
      }
      if (path === "/v1/skills/skill-carousell/execute") {
        expect(requests.at(-1)?.body).toMatchObject({
          intent: "list beige shirts",
          params: {
            endpoint_id: "ep-search",
            url: "https://www.carousell.sg/search/beige%20shirt",
          },
        });
        return Response.json({
          trace: { success: true, skill_id: "skill-carousell", endpoint_id: "ep-search" },
          result: { status: "ok", items: [{ title: "beige shirt" }] },
        });
      }
      if (path === "/health") return Response.json({ status: "ok" });
      return new Response("not found", { status: 404 });
    }, async (baseUrl, requests) => {
      const out = await runCli(baseUrl, [
        "run",
        "https://www.carousell.sg/search/beige%20shirt",
        "list beige shirts",
      ]);

      expect(out.code).toBe(0);
      expect(out.body.result).toEqual({ status: "ok", items: [{ title: "beige shirt" }] });
      expect(requests.map((entry) => entry.path).filter((path) => path !== "/health")).toEqual([
        "/v1/intent/resolve",
        "/v1/skills/skill-carousell/execute",
      ]);
      expect(out.body.run_plan).toContainEqual(expect.objectContaining({ step: "execute", status: "complete", endpoint_id: "ep-search" }));
    });
  });

  it("auto-indexes on a run miss and retries resolve against the fresh capture", async () => {
    await withStubServer(async (req, requests) => {
      const path = new URL(req.url).pathname;
      if (path === "/v1/intent/resolve") {
        const resolveCount = requests.filter((entry) => entry.path === "/v1/intent/resolve").length;
        expect(requests.at(-1)?.body).toMatchObject({
          intent: "list beige pants with links",
          params: { url: "https://www.carousell.sg/search/beige%20pants" },
          context: { url: "https://www.carousell.sg/search/beige%20pants" },
        });
        if (resolveCount === 1) {
          return Response.json({ result: { status: "no_match" } });
        }
        return Response.json({
          trace: { success: true },
          result: { status: "ok", items: [{ title: "GU cargo", url: "https://www.carousell.sg/p/gu-1/" }] },
        });
      }
      if (path === "/v1/capture") {
        expect(requests.at(-1)?.body).toMatchObject({
          url: "https://www.carousell.sg/search/beige%20pants",
          intent: "list beige pants with links",
        });
        return Response.json({ skill_id: "skill-carousell", endpoints_discovered: 2, endpoints: [{ method: "GET" }, { method: "GET" }] });
      }
      if (path === "/health") return Response.json({ status: "ok" });
      return new Response("not found", { status: 404 });
    }, async (baseUrl, requests) => {
      const out = await runCli(baseUrl, [
        "run",
        "https://www.carousell.sg/search/beige%20pants",
        "list beige pants with links",
      ]);

      expect(out.code).toBe(0);
      expect(out.body.result).toEqual({
        status: "ok",
        items: [{ title: "GU cargo", url: "https://www.carousell.sg/p/gu-1/" }],
      });
      expect(requests.map((entry) => entry.path).filter((path) => path !== "/health")).toEqual([
        "/v1/intent/resolve",
        "/v1/capture",
        "/v1/intent/resolve",
      ]);
      expect(out.body.run_plan).toEqual([
        expect.objectContaining({ step: "resolve", status: "miss" }),
        expect.objectContaining({ step: "index", status: "complete", endpoints_discovered: 2 }),
        expect.objectContaining({ step: "resolve", status: "hit" }),
      ]);
    });
  });

  it("opens a browse session when run cannot satisfy the task through direct/indexed routes", async () => {
    await withStubServer(async (req, requests) => {
      const path = new URL(req.url).pathname;
      if (path === "/v1/intent/resolve") {
        return Response.json({ result: { status: "no_match" } });
      }
      if (path === "/v1/capture") {
        return Response.json({ skill_id: "skill-thin", endpoints_discovered: 0, endpoints: [] });
      }
      if (path === "/v1/browse/go") {
        expect(requests.at(-1)?.body).toEqual({ url: "https://www.carousell.sg/search/beige%20pants" });
        return Response.json({ ok: true, session_id: "sess-123" });
      }
      if (path === "/health") return Response.json({ status: "ok" });
      return new Response("not found", { status: 404 });
    }, async (baseUrl) => {
      const out = await runCli(baseUrl, [
        "run",
        "https://www.carousell.sg/search/beige%20pants",
        "find pants near Serangoon",
      ]);

      expect(out.code).toBe(0);
      expect(out.body.status).toBe("browse_required");
      expect(out.body.next_action).toMatchObject({
        command: "unbrowse snap --session sess-123 --filter interactive",
      });
      expect(out.body.run_plan).toContainEqual(expect.objectContaining({ step: "browse", status: "opened", session_id: "sess-123" }));
    });
  });

  it("does not capture/index to bypass a payment-required direct route", async () => {
    await withStubServer(async (req) => {
      const path = new URL(req.url).pathname;
      if (path === "/v1/intent/resolve") {
        return Response.json({
          error: "payment_required",
          message: "Endpoint requires payment",
          payment: { amount: "0.001" },
        });
      }
      if (path === "/health") return Response.json({ status: "ok" });
      return new Response("not found", { status: 404 });
    }, async (baseUrl, requests) => {
      const out = await runCli(baseUrl, [
        "run",
        "https://paid.example/search",
        "search listings",
      ]);

      expect(out.code).toBe(0);
      expect(out.body.error).toBe("payment_required");
      expect(requests.map((entry) => entry.path).filter((path) => path !== "/health")).toEqual([
        "/v1/intent/resolve",
      ]);
    });
  });

  it("accepts --skill-id and --endpoint-id aliases on execute", async () => {
    await withStubServer(async (req, requests) => {
      const path = new URL(req.url).pathname;
      if (path === "/v1/skills/skill_123/execute") {
        expect(requests.at(-1)?.body?.params).toMatchObject({ endpoint_id: "endpoint_456" });
        return Response.json({
          trace: { success: true, skill_id: "skill_123", endpoint_id: "endpoint_456" },
          result: { status: "ok" },
        });
      }
      if (path === "/health") return Response.json({ status: "ok" });
      return new Response("not found", { status: 404 });
    }, async (baseUrl) => {
      const out = await runCli(baseUrl, [
        "execute",
        "--skill-id", "skill_123",
        "--endpoint-id", "endpoint_456",
      ]);

      expect(out.code).toBe(0);
      expect(out.body.result).toEqual({ status: "ok" });
    });
  });

  it("forces an interactive browser for auth-capture instead of cookie-import only", async () => {
    await withStubServer(async (req, requests) => {
      const path = new URL(req.url).pathname;
      if (path === "/v1/auth/login") {
        expect(requests.at(-1)?.body).toEqual({
          url: "https://www.carousell.sg/",
          interactive_only: true,
        });
        return Response.json({
          success: true,
          domain: "www.carousell.sg",
          cookies_stored: 6,
          source: "interactive",
        });
      }
      if (path === "/health") return Response.json({ status: "ok" });
      return new Response("not found", { status: 404 });
    }, async (baseUrl) => {
      const out = await runCli(baseUrl, [
        "auth-capture",
        "--url", "https://www.carousell.sg/",
      ]);

      expect(out.code).toBe(0);
      expect(out.body.source).toBe("interactive");
    });
  });

  it("accepts auth as the consolidated site login command", async () => {
    await withStubServer(async (req, requests) => {
      const path = new URL(req.url).pathname;
      if (path === "/v1/auth/login") {
        expect(requests.at(-1)?.body).toEqual({
          url: "https://www.carousell.sg/",
          interactive_only: true,
        });
        return Response.json({
          success: true,
          domain: "www.carousell.sg",
          cookies_stored: 6,
          source: "interactive",
        });
      }
      if (path === "/health") return Response.json({ status: "ok" });
      return new Response("not found", { status: 404 });
    }, async (baseUrl) => {
      const out = await runCli(baseUrl, [
        "auth",
        "https://www.carousell.sg/",
      ]);

      expect(out.code).toBe(0);
      expect(out.body.source).toBe("interactive");
    });
  });

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
