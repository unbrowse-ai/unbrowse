import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { Env } from "../src/types.js";
import { scanVersionHistory } from "../src/services/traction.js";
import { statsKV, clearKVCacheForTests } from "../src/services/kv.js";

const env: Env = {
  API_KEY: "admin",
  EMERGENTDB_API_KEY: "test",
  NEBIUS_API_KEY: "nebius",
  STATS_KV: {} as KVNamespace,
  ENVIRONMENT: "local-dev",
};

function createMockFetch(store: Map<string, string>) {
  return async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url);

    if (url.pathname === "/qdkv/set") {
      const body = JSON.parse(String(init?.body ?? "{}")) as { key: string; value: string };
      store.set(body.key, body.value);
      return Response.json({ ok: true });
    }

    if (url.pathname.startsWith("/qdkv/get/")) {
      const key = decodeURIComponent(url.pathname.replace("/qdkv/get/", ""));
      const value = store.get(key);
      return Response.json(value == null
        ? { found: false, value: null }
        : { found: true, value });
    }

    if (url.pathname.startsWith("/qdkv/del/")) {
      const key = decodeURIComponent(url.pathname.replace("/qdkv/del/", ""));
      store.delete(key);
      return Response.json({ ok: true });
    }

    throw new Error(`Unexpected fetch: ${url.toString()}`);
  };
}

describe("scanVersionHistory", () => {
  const store = new Map<string, string>();
  const originalFetch = globalThis.fetch;

  beforeEach(async () => {
    globalThis.fetch = createMockFetch(store) as typeof fetch;
    store.clear();
    clearKVCacheForTests("stats");
    await statsKV(env).resetSplitIndex();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("returns zero totals and an empty agent map when no stats:* entries exist", async () => {
    const result = await scanVersionHistory(env);
    expect(result.totalPasses).toBe(0);
    expect(result.passesByAgent.size).toBe(0);
  });

  it("counts two passes from different agents in a single stats:{skill}--{endpoint} entry", async () => {
    await statsKV(env).put("stats:skill-foo--endpoint-bar", JSON.stringify({
      version_history: [
        { version: "1.0.0", status: "pass", verified_at: "2026-01-01T00:00:00Z", agent_id: "agent-a" },
        { version: "1.0.1", status: "pass", verified_at: "2026-01-02T00:00:00Z", agent_id: "agent-b" },
      ],
    }));

    const result = await scanVersionHistory(env);
    expect(result.totalPasses).toBe(2);
    expect(result.passesByAgent.size).toBe(2);
    expect(result.passesByAgent.get("agent-a")).toBe(1);
    expect(result.passesByAgent.get("agent-b")).toBe(1);
  });

  it("does not count entries whose status is fail", async () => {
    await statsKV(env).put("stats:skill-x--endpoint-y", JSON.stringify({
      version_history: [
        { version: "1.0.0", status: "fail", verified_at: "2026-01-01T00:00:00Z", agent_id: "agent-fail" },
      ],
    }));

    const result = await scanVersionHistory(env);
    expect(result.totalPasses).toBe(0);
    expect(result.passesByAgent.size).toBe(0);
    expect(result.passesByAgent.has("agent-fail")).toBe(false);
  });

  it("treats a sibling stats:traction cache row without version_history as a zero-increment", async () => {
    await statsKV(env).put("stats:traction", JSON.stringify({
      cached_at: "2026-01-01T00:00:00Z",
      totalKeys: 42,
      // intentionally no version_history key
    }));
    await statsKV(env).put("stats:skill-q--endpoint-z", JSON.stringify({
      version_history: [
        { version: "2.0.0", status: "pass", verified_at: "2026-01-03T00:00:00Z", agent_id: "agent-real" },
      ],
    }));

    const result = await scanVersionHistory(env);
    // sibling cache row contributes nothing; the real stats row contributes one pass
    expect(result.totalPasses).toBe(1);
    expect(result.passesByAgent.get("agent-real")).toBe(1);
    expect(result.passesByAgent.size).toBe(1);
  });

  it("skips malformed JSON values without throwing and still counts valid neighbours", async () => {
    await statsKV(env).put("stats:broken--row", "{not valid json");
    await statsKV(env).put("stats:good--row", JSON.stringify({
      version_history: [
        { version: "1.0.0", status: "pass", verified_at: "2026-01-04T00:00:00Z", agent_id: "agent-good" },
      ],
    }));

    const result = await scanVersionHistory(env);
    expect(result.totalPasses).toBe(1);
    expect(result.passesByAgent.get("agent-good")).toBe(1);
  });
});
