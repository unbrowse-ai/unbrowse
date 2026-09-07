import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import app from "../src/index.js";
import type { Env, AgentProfile } from "../src/types.js";
import { getAgent } from "../src/services/agents.js";
import { statsKV } from "../src/services/kv.js";

const env: Env = {
  API_KEY: "admin",
  EMERGENTDB_API_KEY: "test",
  NEBIUS_API_KEY: "nebius",
  STATS_KV: {} as KVNamespace,
  ENVIRONMENT: "staging",
};

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
      const body = JSON.parse(String(init?.body ?? "{}")) as { keys?: string[] };
      const values: Record<string, string | null> = {};
      for (const k of body.keys ?? []) values[k] = store.get(k) ?? null;
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

describe("auth profile recovery", () => {
  const store = new Map<string, string>();
  const originalFetch = globalThis.fetch;

  beforeEach(async () => {
    globalThis.fetch = createMockFetch(store) as typeof fetch;
    store.clear();
    await statsKV(env).resetSplitIndex();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("creates a recovered agent profile when a valid auth key has no profile row", async () => {
    const res = await app.fetch(new Request("http://local.test/v1/agents/me", {
      headers: { Authorization: "Bearer ubr_missing_profile_key" },
    }), env);

    expect(res.status).toBe(200);
    const body = await res.json() as AgentProfile;
    expect(body.agent_id).toBe("staging_ubr_miss");
    expect(body.profile_origin).toBe("recovered");
    expect(body.name).toBe("recovered-ubr_miss");

    const stored = await getAgent(env, "staging_ubr_miss");
    expect(stored?.profile_origin).toBe("recovered");
    expect(stored?.agent_id).toBe("staging_ubr_miss");
  });
});
