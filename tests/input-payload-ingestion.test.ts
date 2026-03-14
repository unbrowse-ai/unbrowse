import { afterEach, describe, expect, it } from "bun:test";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { extractEndpoints } from "../src/reverse-engineer/index.js";
import { executeSkill } from "../src/execution/index.js";
import type { RawRequest } from "../src/capture/index.js";
import type { EndpointDescriptor, SkillManifest } from "../src/types/index.js";

type EchoRecord = {
  method: string;
  url: string;
  body: string;
};

const servers = new Set<ReturnType<typeof createServer>>();

async function startEchoServer(): Promise<{
  baseUrl: string;
  lastRequest: () => EchoRecord | null;
  close: () => Promise<void>;
}> {
  let last: EchoRecord | null = null;
  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    last = {
      method: req.method ?? "GET",
      url: req.url ?? "/",
      body: Buffer.concat(chunks).toString("utf8"),
    };
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify(last));
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

function makeRequest(overrides: Partial<RawRequest>): RawRequest {
  return {
    url: "https://api.example.com/search",
    method: "POST",
    request_headers: {
      accept: "application/json",
      "content-type": "application/json",
      "user-agent": "test",
    },
    response_headers: {
      "content-type": "application/json",
    },
    request_body: JSON.stringify({ q: "openai" }),
    response_body: JSON.stringify({ items: [{ id: "1", name: "openai" }] }),
    status: 200,
    ...overrides,
  } as RawRequest;
}

function makeSkill(endpoint: EndpointDescriptor): SkillManifest {
  return {
    skill_id: "skill-test",
    version: "1.0.0",
    schema_version: "1",
    lifecycle: "active",
    execution_type: "http",
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    name: "test-skill",
    intent_signature: "search packages",
    domain: "127.0.0.1",
    description: "test skill",
    owner_type: "agent",
    endpoints: [endpoint],
  };
}

describe("input payload ingestion", () => {
  it("ingests captured JSON request bodies into learned endpoint bodies", () => {
    const endpoints = extractEndpoints([
      makeRequest({
        request_body: JSON.stringify({ q: "openai", limit: 5, filters: { type: "package" } }),
      }),
    ]);

    expect(endpoints).toHaveLength(1);
    expect(endpoints[0].body).toEqual({
      q: "openai",
      limit: "{limit}",
      filters: { type: "package" },
    });
    expect(endpoints[0].semantic?.example_request).toMatchObject({
      q: "openai",
      limit: "{limit}",
      filters: { type: "package" },
    });
  });

  it("ingests captured form payloads into learned endpoint bodies", () => {
    const endpoints = extractEndpoints([
      makeRequest({
        request_headers: {
          accept: "application/json",
          "content-type": "application/x-www-form-urlencoded",
          "user-agent": "test",
        },
        request_body: "q=openai&limit=10&type=package",
      }),
    ]);

    expect(endpoints).toHaveLength(1);
    expect(endpoints[0].body).toEqual({
      q: "openai",
      limit: "10",
      type: "package",
    });
    expect(endpoints[0].semantic?.example_request).toMatchObject({
      q: "openai",
      limit: "10",
      type: "package",
    });
  });

  it("merges context, defaults, and explicit params into GET execution urls", async () => {
    const server = await startEchoServer();
    const endpoint: EndpointDescriptor = {
      endpoint_id: "ep-get",
      method: "GET",
      url_template: `${server.baseUrl}/api/search?query={query}`,
      query: { type: "package" },
      idempotency: "safe",
      verification_status: "verified",
      reliability_score: 1,
      description: "search",
    };

    await executeSkill(
      makeSkill(endpoint),
      { page: "2", type: "library" },
      { raw: true },
      { contextUrl: `${server.baseUrl}/api/search?query=openai` },
    );

    expect(server.lastRequest()).toEqual({
      method: "GET",
      url: "/api/search?query=openai&type=library&page=2",
      body: "",
    });
  });

  it("interpolates explicit payload params and context-derived path params for POST execution", async () => {
    const server = await startEchoServer();
    const endpoint: EndpointDescriptor = {
      endpoint_id: "ep-post",
      method: "POST",
      url_template: `${server.baseUrl}/users/{userId}/messages`,
      body: {
        q: "{q}",
        cursor: "{cursor}",
      },
      idempotency: "unsafe",
      verification_status: "verified",
      reliability_score: 1,
      description: "post search",
    };

    await executeSkill(
      makeSkill(endpoint),
      { q: "openai", cursor: "abc123" },
      { raw: true },
      {
        contextUrl: "https://example.com/users/42/messages",
        confirm_unsafe: true,
      },
    );

    expect(server.lastRequest()).toEqual({
      method: "POST",
      url: "/users/42/messages",
      body: JSON.stringify({
        q: "openai",
        cursor: "abc123",
      }),
    });
  });
});
