import { describe, expect, it } from "bun:test";
import { Unbrowse, UnbrowseApiError } from "../packages/sdk/src/index.ts";

type RecordedRequest = {
  path: string;
  method: string;
  headers: Headers;
  body: Record<string, unknown> | null;
};

async function withStubServer(
  handler: (request: Request, requests: RecordedRequest[]) => Promise<Response> | Response,
  run: (baseUrl: string, requests: RecordedRequest[]) => Promise<void>,
): Promise<void> {
  const requests: RecordedRequest[] = [];
  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      const bodyText = request.method === "GET" ? "" : await request.text();
      requests.push({
        path: new URL(request.url).pathname,
        method: request.method,
        headers: request.headers,
        body: bodyText ? JSON.parse(bodyText) as Record<string, unknown> : null,
      });
      return handler(request, requests);
    },
  });

  try {
    await run(`http://127.0.0.1:${server.port}`, requests);
  } finally {
    await server.stop();
  }
}

describe("@unbrowse/sdk", () => {
  it("maps resolve url into params and context, and sends auth headers", async () => {
    await withStubServer((request, requests) => {
      const latest = requests.at(-1);
      expect(new URL(request.url).pathname).toBe("/v1/intent/resolve");
      expect(request.headers.get("authorization")).toBe("Bearer test-key");
      expect(request.headers.get("x-unbrowse-client-id")).toBe("sdk-test");
      expect(latest?.body).toEqual({
        intent: "get feed posts",
        params: { limit: 5, url: "https://news.ycombinator.com" },
        context: { url: "https://news.ycombinator.com" },
        force_capture: true,
      });
      return Response.json({
        result: { items: [] },
        trace: {
          trace_id: "trace_1",
          skill_id: "skill_1",
          endpoint_id: "ep_1",
          started_at: new Date().toISOString(),
          completed_at: new Date().toISOString(),
          success: true,
        },
        source: "marketplace",
      });
    }, async (baseUrl) => {
      const client = new Unbrowse({
        baseUrl,
        apiKey: "test-key",
        clientId: "sdk-test",
      });
      const result = await client.resolve({
        intent: "get feed posts",
        url: "https://news.ycombinator.com",
        params: { limit: 5 },
        forceCapture: true,
      });
      expect(result.trace.skill_id).toBe("skill_1");
      expect(result.source).toBe("marketplace");
    });
  });

  it("can execute directly from a resolve response", async () => {
    await withStubServer((request, requests) => {
      const latest = requests.at(-1);
      expect(new URL(request.url).pathname).toBe("/v1/skills/skill_123/execute");
      expect(latest?.body).toEqual({
        params: { symbol: "NVDA" },
        context_url: "https://finance.yahoo.com/quote/NVDA",
      });
      return Response.json({
        result: { price: 123 },
        trace: {
          trace_id: "trace_2",
          skill_id: "skill_123",
          endpoint_id: "ep_2",
          started_at: new Date().toISOString(),
          completed_at: new Date().toISOString(),
          success: true,
        },
      });
    }, async (baseUrl) => {
      const client = new Unbrowse({ baseUrl });
      const resolved = {
        result: {},
        trace: {
          trace_id: "trace_1",
          skill_id: "skill_123",
          endpoint_id: "ep_1",
          started_at: new Date().toISOString(),
          completed_at: new Date().toISOString(),
          success: true,
        },
        source: "marketplace" as const,
        skill: {
          skill_id: "skill_123",
          version: "1.0.0",
          schema_version: "1.0.0",
          name: "finance",
          intent_signature: "get stock prices",
          domain: "finance.yahoo.com",
          description: "finance skill",
          owner_type: "agent" as const,
          execution_type: "http" as const,
          endpoints: [],
          lifecycle: "active" as const,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        },
      };
      const result = await client.execute(resolved, {
        params: { symbol: "NVDA" },
        contextUrl: "https://finance.yahoo.com/quote/NVDA",
      });
      expect(result.trace.endpoint_id).toBe("ep_2");
      expect(result.result).toEqual({ price: 123 });
    });
  });

  it("throws UnbrowseApiError with parsed server payload", async () => {
    await withStubServer(() => Response.json({ error: "auth_required", login_url: "https://calendar.google.com" }, { status: 401 }), async (baseUrl) => {
      const client = new Unbrowse({ baseUrl });
      await expect(client.login({ url: "https://calendar.google.com" })).rejects.toMatchObject({
        name: "UnbrowseApiError",
        status: 401,
        path: "/v1/auth/login",
      });
      try {
        await client.login({ url: "https://calendar.google.com" });
      } catch (error) {
        expect(error).toBeInstanceOf(UnbrowseApiError);
        expect((error as UnbrowseApiError).data).toEqual({
          error: "auth_required",
          login_url: "https://calendar.google.com",
        });
      }
    });
  });
});
