import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import app from "../src/index.js";
import type { Env } from "../src/types.js";
import { statsKV } from "../src/services/kv.js";

const env = { API_KEY: "test", EMERGENTDB_API_KEY: "test", NEBIUS_API_KEY: "test", STATS_KV: {} as KVNamespace, ENVIRONMENT: "local-dev" } as Env;
const store = new Map<string, string>();
const originalFetch = globalThis.fetch;

beforeEach(async () => {
  store.clear();
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    if (url.pathname === "/qdkv/set") { const body = JSON.parse(String(init?.body)); store.set(body.key, body.value); return Response.json({ ok: true }); }
    if (url.pathname.startsWith("/qdkv/get/")) { const value = store.get(decodeURIComponent(url.pathname.slice(10))); return Response.json(value == null ? { found: false, value: null } : { found: true, value }); }
    if (url.pathname.startsWith("/qdkv/del/")) { store.delete(decodeURIComponent(url.pathname.slice(10))); return Response.json({ ok: true }); }
    throw new Error(`unexpected ${url}`);
  }) as typeof fetch;
  await statsKV(env).resetSplitIndex();
});
afterEach(() => { globalThis.fetch = originalFetch; });

describe("MCP aggregate-only telemetry", () => {
  it("stores numeric coverage but no tool args/results", async () => {
    const response = await app.fetch(new Request("http://local/v1/telemetry/session", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({
      schema_version: 1,
      session_id: "mcp-one",
      summary: {
        started_at: new Date(Date.now() - 3000).toISOString(),
        completed_at: new Date().toISOString(),
        mcp_version: "11.4.0",
        client_seed_fp: "8c15372d690bbaa4",
        tool_calls_total: 1,
        errors_total: 0,
        success: true,
      },
    }) }), env);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ stored: true, storage: "aggregate_only" });
    const sessionRows = await statsKV(env).listWithValues("analytics:session:mcp-seed:8c15372d690bbaa4:");
    expect(sessionRows).toHaveLength(1);
    expect(sessionRows[0]?.key).not.toContain("mcp-one");
    const all = sessionRows[0]?.value ?? "";
    expect(all).not.toContain("private-canary"); expect(all).not.toContain("private-result"); expect(all).not.toContain("must-not-store");
    expect(all).toContain('"surface":"mcp"'); expect(all).toContain('"api_calls":1');
    const erased = await app.fetch(new Request("http://local/v1/telemetry/sessions?seed=erase-seed", { method: "DELETE" }), env);
    expect(await erased.json()).toMatchObject({ ok: true, deleted: 1, complete: true });
    expect(await statsKV(env).listWithValues("analytics:session:mcp-seed:8c15372d690bbaa4:")).toHaveLength(0);
  });
});
