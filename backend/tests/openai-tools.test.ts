import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { openaiToolsRoutes } from "../src/routes/openai-tools";
import {
  SUBSTRATE_PRIMITIVES,
  buildOpenAIToolList,
  contractRowToOpenAITool,
  asMCPTools,
  type OpenAIFunctionTool,
} from "../src/services/openai-tools";
import type { ContractEventRow, ContractLedger } from "../src/services/contract-ledger";

function memLedger(): ContractLedger {
  const rows: ContractEventRow[] = [];
  return {
    async append(row) {
      const stamped = { ...row, ts: row.ts || new Date().toISOString() };
      rows.push(stamped);
      return stamped;
    },
    async get(id) {
      const hit = rows.filter((r) => r.id === id);
      return hit.length ? hit : null;
    },
    async listAll() {
      return rows.slice();
    },
    async listChildren(parentId) {
      return rows.filter((r) => r.parent_id === parentId);
    },
  };
}

describe("substrate primitives are always present", () => {
  test("five built-in tools", () => {
    expect(SUBSTRATE_PRIMITIVES.length).toBe(5);
    const names = SUBSTRATE_PRIMITIVES.map((t) => t.function.name);
    expect(names).toContain("aiko_declare");
    expect(names).toContain("aiko_status");
    expect(names).toContain("aiko_iterate");
    expect(names).toContain("aiko_pick_channel");
    expect(names).toContain("aiko_search");
  });

  test("each primitive has valid OpenAI function-tool shape", () => {
    for (const t of SUBSTRATE_PRIMITIVES) {
      expect(t.type).toBe("function");
      expect(typeof t.function.name).toBe("string");
      expect(/^[a-z][a-z0-9_]{1,63}$/.test(t.function.name)).toBe(true);
      expect(typeof t.function.description).toBe("string");
      expect(t.function.parameters.type).toBe("object");
      expect(t.function.parameters.properties).toBeDefined();
    }
  });
});

describe("contract → OpenAI tool projection", () => {
  test("declared row WITHOUT tool_schema is not a tool", () => {
    const row: ContractEventRow = {
      event: "declared",
      id: "abc12345",
      ts: "2026-05-25T20:00:00Z",
      plan: "private contract",
      action: "neuron",
    };
    expect(contractRowToOpenAITool(row)).toBeNull();
  });

  test("declared row WITH tool_schema becomes a tool, name=contract_<id>", () => {
    const row = {
      event: "declared",
      id: "abc12345",
      ts: "2026-05-25T20:00:00Z",
      plan: "do a thing",
      action: "neuron",
      tool_schema: {
        type: "object" as const,
        properties: { q: { type: "string" as const } },
        required: ["q"],
      },
    } as ContractEventRow;
    const tool = contractRowToOpenAITool(row);
    expect(tool).not.toBeNull();
    expect(tool?.function.name).toBe("contract_abc12345");
    expect(tool?.function.description).toBe("do a thing");
  });

  test("tool_name alias overrides contract_<id> when valid", () => {
    const row = {
      event: "declared",
      id: "abc12345",
      ts: "2026-05-25T20:00:00Z",
      plan: "search reddit",
      action: "neuron",
      tool_name: "reddit_search",
      tool_description: "Search Reddit for posts matching query",
      tool_schema: { type: "object" as const, properties: {} },
    } as ContractEventRow;
    const tool = contractRowToOpenAITool(row);
    expect(tool?.function.name).toBe("reddit_search");
    expect(tool?.function.description).toBe("Search Reddit for posts matching query");
  });

  test("invalid tool_name pattern falls back to contract_<id>", () => {
    const row = {
      event: "declared",
      id: "abc12345",
      ts: "2026-05-25T20:00:00Z",
      plan: "x",
      action: "neuron",
      tool_name: "BAD-NAME-with-caps",
      tool_schema: { type: "object" as const, properties: {} },
    } as ContractEventRow;
    expect(contractRowToOpenAITool(row)?.function.name).toBe("contract_abc12345");
  });
});

describe("buildOpenAIToolList — lineage filter", () => {
  test("anonymous-public contracts included for any caller", async () => {
    const ledger = memLedger();
    await ledger.append({
      event: "declared",
      id: "pub00001",
      ts: "2026-05-25T20:00:00Z",
      plan: "public op",
      action: "neuron",
      // anonymous: no wallet_identity → treat as public
      tool_schema: { type: "object" as const, properties: {} },
    } as ContractEventRow);
    const tools = await buildOpenAIToolList(ledger);
    expect(tools.some((t) => t.function.name === "contract_pub00001")).toBe(true);
  });

  test("lineage-bound contract HIDDEN from stranger; VISIBLE to owner", async () => {
    const ledger = memLedger();
    await ledger.append({
      event: "declared",
      id: "secr0001",
      ts: "2026-05-25T20:00:00Z",
      plan: "lineage-only op",
      action: "neuron",
      tool_schema: { type: "object" as const, properties: {} },
      visibility: "lineage",
      wallet_identity: "owner_pubkey_xxxx",
    } as ContractEventRow);
    const stranger = await buildOpenAIToolList(ledger, { caller_pubkey: "stranger" });
    expect(stranger.some((t) => t.function.name === "contract_secr0001")).toBe(false);
    const owner = await buildOpenAIToolList(ledger, { caller_pubkey: "owner_pubkey_xxxx" });
    expect(owner.some((t) => t.function.name === "contract_secr0001")).toBe(true);
  });

  test("substrate primitives always present", async () => {
    const tools = await buildOpenAIToolList(memLedger());
    expect(tools.some((t) => t.function.name === "aiko_declare")).toBe(true);
    expect(tools.some((t) => t.function.name === "aiko_pick_channel")).toBe(true);
  });
});

describe("MCP projection — same registry, different envelope", () => {
  test("openai → mcp shape conversion", () => {
    const openai: OpenAIFunctionTool = {
      type: "function",
      function: {
        name: "do_thing",
        description: "the thing",
        parameters: { type: "object", properties: { q: { type: "string" } }, required: ["q"] },
      },
    };
    const mcp = asMCPTools([openai]);
    expect(mcp[0]?.name).toBe("do_thing");
    expect(mcp[0]?.description).toBe("the thing");
    expect(mcp[0]?.inputSchema.properties?.q).toBeDefined();
  });
});

describe("/v1/contract/tools route", () => {
  function mountApp() {
    const app = new Hono();
    app.route("/v1", openaiToolsRoutes);
    return app;
  }

  async function getJson(app: Hono, path: string, headers: Record<string, string> = {}) {
    const res = await app.fetch(new Request(`http://test.local${path}`, { headers }));
    return { status: res.status, json: await res.json() };
  }

  test("GET /v1/contract/tools returns OpenAI tools array", async () => {
    const app = mountApp();
    const { status, json } = await getJson(app, "/v1/contract/tools");
    expect(status).toBe(200);
    const body = json as { tools: OpenAIFunctionTool[] };
    expect(Array.isArray(body.tools)).toBe(true);
    expect(body.tools.length).toBeGreaterThanOrEqual(5);
    expect(body.tools[0]?.type).toBe("function");
  });

  test("GET /v1/contract/tools?format=mcp returns MCP envelope", async () => {
    const app = mountApp();
    const { status, json } = await getJson(app, "/v1/contract/tools?format=mcp");
    expect(status).toBe(200);
    const body = json as { tools: Array<{ name: string; inputSchema: unknown }> };
    expect(Array.isArray(body.tools)).toBe(true);
    expect(body.tools[0]?.inputSchema).toBeDefined();
    // MCP envelope has no `type: "function"` — verifies the projection
    expect((body.tools[0] as any).type).toBeUndefined();
  });
});
