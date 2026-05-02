import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { Env } from "../src/types.js";
import {
  bindKeyToUser,
  generateUserId,
  getUserByEmail,
  getUserById,
  listKeysForUser,
  lookupUserIdByKey,
  upsertUser,
} from "../src/services/accounts.js";
import { clearKVCacheForTests } from "../src/services/kv.js";

// Real EdbKV runs against a fetch interceptor that emulates EmergentDB qdkv.
// We do NOT mock accounts.ts itself — only the network underneath EdbKV.
// Same pattern used by backend/tests/auth-recovery.test.ts.
const env: Env = {
  API_KEY: "admin",
  EMERGENTDB_API_KEY: "test",
  NEBIUS_API_KEY: "nebius",
  STATS_KV: {} as KVNamespace,
  ENVIRONMENT: "staging",
  TURBOBOX_URL: "http://test",
  R2_BUCKET: {} as R2Bucket,
  FAL_KEY: "test",
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

describe("accounts.ts KV contract", () => {
  const store = new Map<string, string>();
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    globalThis.fetch = createMockFetch(store) as typeof fetch;
    store.clear();
    clearKVCacheForTests();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("generateUserId returns a 24-char hex string, unique across 100 calls", () => {
    const ids = new Set<string>();
    for (let i = 0; i < 100; i++) {
      const id = generateUserId();
      expect(id).toMatch(/^[0-9a-f]{24}$/);
      ids.add(id);
    }
    expect(ids.size).toBe(100);
  });

  it("upsertUser is idempotent — same email returns same user_id and created_at", async () => {
    const a = await upsertUser(env, "alex@example.com");
    const b = await upsertUser(env, "alex@example.com");
    expect(b.user_id).toBe(a.user_id);
    expect(b.created_at).toBe(a.created_at);
  });

  it("upsertUser normalizes email (trim + lowercase)", async () => {
    const rec = await upsertUser(env, "  Lewis@Example.COM  ");
    expect(rec.email).toBe("lewis@example.com");
    const looked = await getUserByEmail(env, "LEWIS@example.com");
    expect(looked?.user_id).toBe(rec.user_id);
  });

  it("upsertUser rejects empty/whitespace-only email", async () => {
    await expect(upsertUser(env, "")).rejects.toThrow(/email required/);
    await expect(upsertUser(env, "   ")).rejects.toThrow(/email required/);
  });

  it("upsertUser sets verified_at only when verifyNow=true, never regresses to undefined", async () => {
    const first = await upsertUser(env, "v@example.com");
    expect(first.verified_at).toBeUndefined();

    const second = await upsertUser(env, "v@example.com", { verifyNow: true });
    expect(second.verified_at).toBeDefined();
    expect(new Date(second.verified_at!).toISOString()).toBe(second.verified_at);
    const verifiedAt = second.verified_at!;

    const third = await upsertUser(env, "v@example.com", { verifyNow: true });
    expect(third.verified_at).toBe(verifiedAt);

    // A subsequent call with no verifyNow must also not regress.
    const fourth = await upsertUser(env, "v@example.com");
    expect(fourth.verified_at).toBe(verifiedAt);
  });

  it("getUserByEmail and getUserById round-trip", async () => {
    const created = await upsertUser(env, "  Round@Trip.io ");
    const byEmail = await getUserByEmail(env, "round@trip.io");
    const byId = await getUserById(env, created.user_id);
    expect(byEmail).toEqual(created);
    expect(byId).toEqual(created);
    expect(byId?.email).toBe("round@trip.io");
  });

  it("bindKeyToUser writes both indexes (key->user and user->keys)", async () => {
    const user = await upsertUser(env, "binder@example.com");
    await bindKeyToUser(env, "kid_a", user.user_id);
    expect(await lookupUserIdByKey(env, "kid_a")).toBe(user.user_id);
    expect(await listKeysForUser(env, user.user_id)).toEqual(["kid_a"]);
  });

  it("bindKeyToUser appends, doesn't overwrite — three binds yield three keys", async () => {
    const user = await upsertUser(env, "many@example.com");
    await bindKeyToUser(env, "kid_a", user.user_id);
    await bindKeyToUser(env, "kid_b", user.user_id);
    await bindKeyToUser(env, "kid_c", user.user_id);
    const keys = await listKeysForUser(env, user.user_id);
    expect(keys).toHaveLength(3);
    expect(keys).toContain("kid_a");
    expect(keys).toContain("kid_b");
    expect(keys).toContain("kid_c");
    // Re-binding an existing key must NOT duplicate it.
    await bindKeyToUser(env, "kid_a", user.user_id);
    const keys2 = await listKeysForUser(env, user.user_id);
    expect(keys2).toHaveLength(3);
  });

  it("lookupUserIdByKey returns null (literally) for unknown key", async () => {
    const got = await lookupUserIdByKey(env, "kid_nonexistent");
    expect(got).toBeNull();
  });
});
