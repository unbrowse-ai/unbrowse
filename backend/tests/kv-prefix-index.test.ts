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

describe("kv prefix indexes", () => {
  const store = new Map<string, string>();
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    globalThis.fetch = createMockFetch(store) as typeof fetch;
    store.clear();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  // Prefix-specific indexes (_idxp:) were replaced by split sub-indexes
  // (_idx:main / _idx:large) in the current KV implementation. This test
  // documents the original per-prefix index design for future reference.
  it.todo("maintains prefix-specific indexes for hot analytics keys — _idxp: indexes not implemented in current KV split-index design");
});
