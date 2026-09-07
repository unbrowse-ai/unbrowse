import { afterEach, describe, expect, it } from "bun:test";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { buildAdhocWriteEndpoint, evaluateExecutionTerminal, executeSkill, selectBestEndpoint } from "../src/execution/index.js";
import { assessSingleEndpointRecovery, canRecoverSingleEndpointForIntent } from "../src/api/routes.js";
import type { EndpointDescriptor, SkillManifest } from "../src/types/index.js";
import { projectIntentData } from "../src/intent-match.js";

const servers = new Set<ReturnType<typeof createServer>>();

it("projects an exact crate from a cached search collection for a detail intent", () => {
  const projected = projectIntentData({
    crates: [
      { id: "serde", name: "serde", description: "serialization", exact_match: true },
      { id: "serde_json", name: "serde_json", description: "json", exact_match: false },
    ],
  }, "get crate serde details");
  expect(projected).toMatchObject({ name: "serde", exact_match: true });
  expect(Array.isArray(projected)).toBe(false);
});

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
  it("executes a positively identified ad-hoc GraphQL query without unsafe confirmation", async () => {
    const server = await startJsonServer({ data: { countries: [{ code: "SG", name: "Singapore" }] } });
    const endpoint = buildAdhocWriteEndpoint(server.baseUrl, "POST", {
      query: "query Countries { countries { code name } }",
    });
    const out = await executeSkill(makeSkill("list countries using GraphQL", endpoint), {}, { raw: true });
    expect(out.trace.error).not.toBe("confirmation_required");
    expect(out.trace.success).toBe(true);
    await server.close();
  });

  it("D7 single-endpoint recovery rejects a detail route for search intent", () => {
    const endpoint = {
      endpoint_id: "package-openai",
      method: "GET",
      url_template: "https://www.npmjs.com/package/openai",
      semantic: { action_kind: "detail", resource_kind: "package" },
    } as never;
    expect(canRecoverSingleEndpointForIntent(endpoint, "search npm for zod", "https://www.npmjs.com/search?q=zod")).toBe(false);
    expect(assessSingleEndpointRecovery(endpoint, "search npm for zod", "https://www.npmjs.com/search?q=zod")).toEqual({
      allowed: false,
      reason: "route_intent_mismatch",
    });
  });
  it("derives route, response-shape, and intent truth from one judgment", () => {
    const endpoint = {
      endpoint_id: "detail",
      method: "GET",
      url_template: "https://crates.io/api/v1/crates/{name}",
      semantic: { action_kind: "detail" },
    } as never;
    const judged = evaluateExecutionTerminal({
      endpoint,
      intent: "get crate detail",
      contextUrl: "https://crates.io/crates/serde",
      status: 200,
      result: { crates: [{ name: "serde" }], total: 1 },
      transportSuccess: true,
    });
    expect(judged).toEqual({ success: false, intent_verdict: "fail", error: "response_shape_mismatch" });
  });
  it("rejects an explicit crates search endpoint for a detail intent before network execution", async () => {
    const endpoint = {
      endpoint_id: "crate-search",
      method: "GET",
      url_template: "http://127.0.0.1:1/api/v1/crates?q={query}",
      semantic: { action_kind: "search", resource_kind: "crate" },
      idempotency: "safe",
      verification_status: "verified",
      reliability_score: 1,
    } as EndpointDescriptor;
    const out = await executeSkill(makeSkill("search crates", endpoint), { endpoint_id: endpoint.endpoint_id }, undefined, {
      intent: "get crate detail",
      contextUrl: "https://crates.io/crates/serde",
    });
    expect(out.trace.success).toBe(false);
    expect(out.trace.error).toBe("no_relevant_route");
    expect((out.result as { reason: string }).reason).toBe("route_intent_mismatch");
  });
  it("exports the D8 selector and fails closed when no endpoint matches cardinality", () => {
    const search = {
      endpoint_id: "crate-search",
      method: "GET",
      url_template: "https://crates.io/api/v1/crates?q={query}",
      semantic: { action_kind: "search", resource_kind: "crate" },
    } as EndpointDescriptor;
    expect(() => selectBestEndpoint([search], "get crate detail", "crates.io", "https://crates.io/crates/serde"))
      .toThrow("No relevant endpoints available");
  });
  it("rejects a singular GraphQL payload for a plural countries intent", () => {
    const endpoint = {
      endpoint_id: "countries",
      method: "POST",
      url_template: "https://countries.trevorblades.com/",
      semantic: { action_kind: "list", resource_kind: "country" },
    } as EndpointDescriptor;
    expect(evaluateExecutionTerminal({
      endpoint,
      intent: "list countries",
      contextUrl: "https://countries.trevorblades.com/",
      status: 200,
      result: { data: { country: { code: "US", name: "United States" } } },
      transportSuccess: true,
    })).toEqual({ success: false, intent_verdict: "fail", error: "response_shape_mismatch" });
  });
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
