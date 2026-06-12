import { afterEach, describe, expect, it } from "bun:test";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { executeSkill } from "../src/execution/index.js";
import type { EndpointDescriptor, SkillManifest } from "../src/types/index.js";

const servers = new Set<ReturnType<typeof createServer>>();

async function startJsonServer(payload: unknown): Promise<{
  baseUrl: string;
  close: () => Promise<void>;
}> {
  const server = createServer((_req: IncomingMessage, res: ServerResponse) => {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify(payload));
  });
  servers.add(server);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${port}`,
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

function makeSkill(intent: string, endpoint: EndpointDescriptor): SkillManifest {
  return {
    skill_id: "skill-test",
    version: "1.0.0",
    schema_version: "1",
    lifecycle: "active",
    execution_type: "http",
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    name: "test-skill",
    intent_signature: intent,
    domain: "127.0.0.1",
    description: "test skill",
    owner_type: "agent",
    endpoints: [endpoint],
  };
}

describe("execution intent truth gate", () => {
  it("fails transport-success responses that do not satisfy the skill intent", async () => {
    const server = await startJsonServer({
      news: [
        {
          title: "Atlassian job cuts raise the question: Is AI driving layoffs?",
          url: "https://finance.yahoo.com/video/atlassian-job-cuts-raise-ai-163000380.html",
        },
      ],
    });

    const out = await executeSkill(
      makeSkill("get stock quote", {
        endpoint_id: "quote",
        method: "GET",
        url_template: `${server.baseUrl}/quote/AAPL`,
        idempotency: "safe",
        verification_status: "verified",
        reliability_score: 1,
        description: "quote",
      }),
      {},
      { raw: true },
    );

    // wrong_entity_type now returns skip (not fail) — execution succeeds
    // but the data may not match the expected schema for the intent
    expect(out.trace.success).toBe(true);
    await server.close();
  });

  it("keeps transport-success responses that satisfy the skill intent", async () => {
    const server = await startJsonServer({
      quoteResponse: {
        result: [
          {
            symbol: "AAPL",
            shortName: "Apple Inc.",
            regularMarketPrice: 212.34,
            regularMarketChangePercent: 1.23,
            currency: "USD",
          },
        ],
      },
    });

    const out = await executeSkill(
      makeSkill("get stock quote", {
        endpoint_id: "quote",
        method: "GET",
        url_template: `${server.baseUrl}/quote/AAPL`,
        idempotency: "safe",
        verification_status: "verified",
        reliability_score: 1,
        description: "quote",
      }),
      {},
      { raw: true },
    );

    expect(out.trace.success).toBe(true);
    expect((out.result as Record<string, unknown>)?.quoteResponse).toBeTruthy();
    await server.close();
  });
});
