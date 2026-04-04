import { afterEach, describe, expect, it } from "bun:test";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { dirname, join } from "node:path";

type CapturedRequest = {
  method: string;
  path: string;
  body: unknown;
};

const TESTS_DIR = dirname(new URL(import.meta.url).pathname);
const ROOT = join(TESTS_DIR, "..");
const servers = new Set<ReturnType<typeof createServer>>();

async function startJsonEchoServer(responseBody: unknown = { ok: true }): Promise<{
  baseUrl: string;
  lastRequest: () => CapturedRequest | null;
  close: () => Promise<void>;
}> {
  let last: CapturedRequest | null = null;
  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const raw = Buffer.concat(chunks).toString("utf8");
    last = {
      method: req.method ?? "GET",
      path: req.url ?? "/",
      body: raw ? JSON.parse(raw) : null,
    };
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify(responseBody));
  });
  servers.add(server);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    lastRequest: () => last,
    close: async () => {
      if (!server.listening) return;
      await new Promise<void>((resolve, reject) => server.close((err) => err ? reject(err) : resolve()));
      servers.delete(server);
    },
  };
}

afterEach(async () => {
  await Promise.all(
    [...servers].map((server) =>
      new Promise<void>((resolve, reject) => server.close((err) => err ? reject(err) : resolve())),
    ),
  );
  servers.clear();
});

async function runCli(baseUrl: string, args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn([process.execPath, "src/cli.ts", ...args, "--no-auto-start"], {
    cwd: ROOT,
    env: {
      ...process.env,
      UNBROWSE_URL: baseUrl,
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

describe("CLI input payload ingestion (integration)", () => {
  it("resolve merges --url and --params into the request payload", async () => {
    const server = await startJsonEchoServer({ result: { ok: true } });

    const cli = await runCli(server.baseUrl, [
      "resolve",
      "--intent", "search packages",
      "--url", "https://npmjs.com/search?q=openai",
      "--params", "{\"page\":2,\"filters\":{\"type\":\"package\"}}",
    ]);

    expect(cli.code).toBe(0);
    expect(server.lastRequest()).toEqual({
      method: "POST",
      path: "/v1/intent/resolve",
      body: {
        intent: "search packages",
        projection: { raw: true },
        params: {
          url: "https://npmjs.com/search?q=openai",
          page: 2,
          filters: { type: "package" },
        },
        context: {
          url: "https://npmjs.com/search?q=openai",
        },
        projection: {
          raw: true,
        },
      },
    });
  });

  it("execute merges endpoint selection, context url, and --params into the request payload", async () => {
    const server = await startJsonEchoServer({ result: { ok: true } });

    const cli = await runCli(server.baseUrl, [
      "execute",
      "--skill", "skill-123",
      "--endpoint", "ep-search",
      "--url", "https://npmjs.com/search?q=openai",
      "--intent", "search packages",
      "--params", "{\"page\":2,\"query\":\"openai\"}",
      "--raw",
    ]);

    expect(cli.code).toBe(0);
    expect(server.lastRequest()).toEqual({
      method: "POST",
      path: "/v1/skills/skill-123/execute",
      body: {
        params: {
          endpoint_id: "ep-search",
          page: 2,
          query: "openai",
          url: "https://npmjs.com/search?q=openai",
        },
        context_url: "https://npmjs.com/search?q=openai",
        intent: "search packages",
        projection: { raw: true },
      },
    });
  });

  it("preserves already-structured large results instead of re-applying stale raw extraction hints", async () => {
    const server = await startJsonEchoServer({
      trace: {
        trace_id: "trace-linkedin",
        skill_id: "skill-linkedin",
        endpoint_id: "ep-feed",
        success: true,
        status_code: 200,
      },
      result: Array.from({ length: 12 }, (_, i) => ({
        id: `post-${i + 1}`,
        url: `https://www.linkedin.com/feed/update/post-${i + 1}`,
        author: `Author ${i + 1}`,
        content: `Long feed post ${i + 1}: ` + "linked data ".repeat(40),
      })),
      extraction_hints: {
        path: "included[]",
        fields: ["name", "url", "content"],
        confidence: "high",
        cli_args: "--path \"included[]\" --extract \"name,url,content\" --limit 10",
      },
      response_schema: {
        type: "object",
        properties: {
          data: { type: "object" },
          included: { type: "array" },
        },
      },
    });

    const cli = await runCli(server.baseUrl, [
      "resolve",
      "--intent", "get feed posts",
      "--url", "https://www.linkedin.com/feed/",
    ]);

    expect(cli.code).toBe(0);
    const body = JSON.parse(cli.stdout.trim() || "{}");
    expect(Array.isArray(body.result)).toBe(true);
    expect(body.result).toHaveLength(12);
    expect(body._response_too_large).toBeUndefined();
    expect(body.extraction_hints).toBeUndefined();
    expect(cli.stderr).not.toContain('resolved to undefined');
  });

  it("forwards --session to browse POST commands", async () => {
    const server = await startJsonEchoServer({ ok: true });

    const cli = await runCli(server.baseUrl, [
      "click",
      "e5",
      "--session", "sess-42",
    ]);

    expect(cli.code).toBe(0);
    expect(server.lastRequest()).toEqual({
      method: "POST",
      path: "/v1/browse/click",
      body: {
        ref: "e5",
        session_id: "sess-42",
      },
    });
  });

  it("forwards --session to browse GET commands as a query string", async () => {
    const server = await startJsonEchoServer({ text: "hello" });

    const cli = await runCli(server.baseUrl, [
      "text",
      "--session", "sess-42",
    ]);

    expect(cli.code).toBe(0);
    expect(server.lastRequest()).toEqual({
      method: "GET",
      path: "/v1/browse/text?session_id=sess-42",
      body: null,
    });
  });

  it("sends publish-bundle to the foundry publish route", async () => {
    const server = await startJsonEchoServer({ ok: true });

    const cli = await runCli(server.baseUrl, [
      "publish-bundle",
      "--preset", "skills/x-account-operator/foundry-preset.json",
      "--hosts", "codex,claude",
      "--site-url", "https://www.unbrowse.ai",
    ]);

    expect(cli.code).toBe(0);
    expect(server.lastRequest()).toEqual({
      method: "POST",
      path: "/v1/foundry/publish-bundle",
      body: {
        preset_path: "skills/x-account-operator/foundry-preset.json",
        hosts: ["codex", "claude"],
        site_url: "https://www.unbrowse.ai",
      },
    });
  });
});
