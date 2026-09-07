import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { EdbKV } from "../src/services/kv.js";

function createMockFetch(store: Map<string, string>) {
  return async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url);
    if (url.hostname !== "api.emergentdb.com") {
      throw new Error(`Unexpected fetch: ${url.toString()}`);
    }

    if (url.pathname === "/qdkv/set") {
      const body = JSON.parse(String(init?.body ?? "{}")) as { key: string; value: string };
      store.set(body.key, body.value);
      return Response.json({ ok: true });
    }

    if (url.pathname === "/qdkv/mget") {
      const body = JSON.parse(String(init?.body ?? "{}")) as { keys: string[] };
      const values: Record<string, string | null> = {};
      for (const key of body.keys) values[key] = store.get(key) ?? null;
      return Response.json({ values });
    }

    if (url.pathname.startsWith("/qdkv/get/")) {
      const key = decodeURIComponent(url.pathname.replace("/qdkv/get/", ""));
      const value = store.get(key);
      return Response.json(value == null ? { found: false, value: null } : { found: true, value });
    }

    if (url.pathname.startsWith("/qdkv/del/")) {
      const key = decodeURIComponent(url.pathname.replace("/qdkv/del/", ""));
      store.delete(key);
      return Response.json({ ok: true });
    }

    throw new Error(`Unexpected fetch: ${url.toString()}`);
  };
}

describe("kv listWithValues", () => {
  const store = new Map<string, string>();
  const originalFetch = globalThis.fetch;

  beforeEach(async () => {
    globalThis.fetch = createMockFetch(store) as typeof fetch;
    store.clear();
    // Clear module-level KV cache to prevent cross-test pollution
    const kv = new EdbKV("test", "stats");
    await kv.resetSplitIndex();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("fetches all trimmed prefix entries, not only the first batch", async () => {
    const kv = new EdbKV("test", "stats");
    const entries = Array.from({ length: 65 }, (_, i) => ({
      k: `agent:${i + 1}`,
      v: "",
    }));

    store.set("stats:_idx:main", JSON.stringify(entries));
    store.set("stats:_idx:large", JSON.stringify([]));
    store.set("stats:_idx", JSON.stringify([]));
    for (let i = 0; i < 65; i++) {
      store.set(`stats:agent:${i + 1}`, JSON.stringify({ agent_id: `${i + 1}` }));
    }

    const values = await kv.listWithValues("agent:");

    expect(values).toHaveLength(65);
    expect(values[0]?.name).toBe("agent:1");
    expect(values[64]?.name).toBe("agent:65");
  });
});
