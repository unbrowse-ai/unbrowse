import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { Env, SkillManifest } from "../src/types.js";
import { deprecateSkill } from "../src/services/marketplace.js";
import { skillsKV } from "../src/services/kv.js";

const env: Env = {
  API_KEY: "admin",
  UNKEY_ROOT_KEY: "root",
  UNKEY_API_ID: "api",
  EMERGENTDB_API_KEY: "test",
  NEBIUS_API_KEY: "nebius",
  STATS_KV: {} as KVNamespace,
  ENVIRONMENT: "staging",
};

function seededSkill(): SkillManifest {
  return {
    skill_id: "skill-deprecate-cleanup",
    version: "1.0.0",
    schema_version: "1",
    name: "example.com",
    intent_signature: "example.com",
    domain: "example.com",
    description: "Cleanup fixture",
    owner_type: "agent",
    execution_type: "http",
    lifecycle: "active",
    created_at: "2026-03-11T20:00:00.000Z",
    updated_at: "2026-03-11T20:00:00.000Z",
    endpoints: [
      {
        endpoint_id: "ep-1",
        method: "GET",
        url_template: "https://example.com/api/a",
        description: "Endpoint A",
        idempotency: "safe",
        verification_status: "verified",
        reliability_score: 0.9,
      },
      {
        endpoint_id: "ep-2",
        method: "GET",
        url_template: "https://example.com/api/b",
        description: "Endpoint B",
        idempotency: "safe",
        verification_status: "verified",
        reliability_score: 0.9,
      },
    ],
  };
}

describe("deprecateSkill cleanup", () => {
  const store = new Map<string, string>();
  const originalFetch = globalThis.fetch;
  const vectorDeletes: Array<{ id: number; namespace: string }> = [];

  beforeEach(async () => {
    store.clear();
    vectorDeletes.length = 0;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
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
      if (url.pathname === "/vectors/delete") {
        const body = JSON.parse(String(init?.body ?? "{}")) as { id: number; namespace: string };
        vectorDeletes.push(body);
        return Response.json({ ok: true });
      }
      throw new Error(`Unexpected fetch: ${url.toString()}`);
    }) as typeof fetch;

    await skillsKV(env).resetSplitIndex();
    await skillsKV(env).put("skill:skill-deprecate-cleanup", JSON.stringify(seededSkill()));
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("removes legacy and per-endpoint vectors when deprecating a skill", async () => {
    const skill = await deprecateSkill(env, "skill-deprecate-cleanup");
    expect(skill?.lifecycle).toBe("deprecated");

    expect(vectorDeletes).toHaveLength(6);
    const namespaces = vectorDeletes.map((entry) => entry.namespace).sort();
    expect(namespaces).toEqual([
      "unbrowse-stg4--example-com",
      "unbrowse-stg4--example-com",
      "unbrowse-stg4--example-com",
      "unbrowse-stg4--global",
      "unbrowse-stg4--global",
      "unbrowse-stg4--global",
    ]);
  });
});
