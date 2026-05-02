import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { app } from "../src/index.js";
import type { Env } from "../src/types.js";
import { clearKVCacheForTests } from "../src/services/kv.js";
import { createLocalKey } from "../src/services/keys.js";
import { bindKeyToUser, upsertUser } from "../src/services/accounts.js";

// Real Hono app, real accounts/keys/KV; only the network boundary is stubbed.
// Uses ENVIRONMENT=production so verifyLocalKey actually exercises the
// hash lookup path (staging short-circuit would mint a fresh staging keyId
// that wouldn't match the one bindKeyToUser stored).

interface ResendCall { url: string; body: any }

const baseEnv: Env = {
  API_KEY: "admin",
  EMERGENTDB_API_KEY: "test",
  NEBIUS_API_KEY: "nebius",
  STATS_KV: {} as KVNamespace,
  ENVIRONMENT: "production",
  TURBOBOX_URL: "http://turbobox.local",
  R2_BUCKET: {} as R2Bucket,
  FAL_KEY: "fal",
  RESEND_API_KEY: "re_test",
  RESEND_FROM: "Unbrowse <auth@auth.unbrowse.ai>",
  PUBLIC_API_URL: "http://api.local",
};

let originalFetch: typeof fetch;
let kvStore: Map<string, string>;
let resendCalls: ResendCall[];

function makeFetch(store: Map<string, string>, calls: ResendCall[]): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const urlStr = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const url = new URL(urlStr);

    if (url.hostname === "api.resend.com") {
      calls.push({ url: urlStr, body: JSON.parse(String(init?.body ?? "{}")) });
      return new Response(JSON.stringify({ id: "resend-stub" }), { status: 200 });
    }

    if (url.hostname === "api.emergentdb.com") {
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
      if (url.pathname.startsWith("/qdkv/list/")) {
        // Minimal listWithValues stub: prefix scan over the in-memory map
        const prefix = decodeURIComponent(url.pathname.replace("/qdkv/list/", ""));
        const items = [...store.entries()]
          .filter(([k]) => k.startsWith(prefix))
          .map(([key, value]) => ({ key, value }));
        return Response.json({ items });
      }
      return Response.json({ ok: true });
    }

    throw new Error(`Unexpected fetch in test: ${urlStr}`);
  }) as typeof fetch;
}

async function getReq(path: string, headers: Record<string, string> = {}): Promise<Response> {
  return app.fetch(new Request(`http://local.test${path}`, { headers }), baseEnv);
}

async function postJson(path: string, body: unknown): Promise<Response> {
  return app.fetch(
    new Request(`http://local.test${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
    baseEnv,
  );
}

async function magicLinkBoundKey(email: string): Promise<{ key: string; userId: string }> {
  const startRes = await postJson("/v1/auth/email/start", { email });
  const { token } = await startRes.json() as { token: string };
  await getReq(`/v1/auth/email/verify?token=${token}`);
  const pollRes = await getReq(`/v1/auth/email/poll?token=${token}`);
  const poll = await pollRes.json() as { api_key: string; user_id: string };
  return { key: poll.api_key, userId: poll.user_id };
}

beforeEach(() => {
  originalFetch = globalThis.fetch;
  kvStore = new Map();
  resendCalls = [];
  globalThis.fetch = makeFetch(kvStore, resendCalls);
  clearKVCacheForTests();
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  clearKVCacheForTests();
});

describe("/v1/account/* routes", () => {
  it("1. /me with anonymous key returns 403 account_required", async () => {
    const { key } = await createLocalKey(baseEnv, "anon-test");
    const res = await getReq("/v1/account/me", { Authorization: `Bearer ${key}` });
    expect(res.status).toBe(403);
    const body = await res.json() as { error: string };
    expect(body.error).toBe("account_required");
  });

  it("2. /me with no Authorization returns 401", async () => {
    const res = await getReq("/v1/account/me");
    expect(res.status).toBe(401);
  });

  it("3. /me with account-bound key returns 200 with user_id, email, keys_count >= 1", async () => {
    const { key, userId } = await magicLinkBoundKey("alice@example.com");

    const res = await getReq("/v1/account/me", { Authorization: `Bearer ${key}` });
    expect(res.status).toBe(200);
    const body = await res.json() as {
      user_id: string;
      email: string;
      created_at: string;
      verified_at: string | null;
      keys_count: number;
      skills_count: number;
    };
    expect(body.user_id).toBe(userId);
    expect(body.email).toBe("alice@example.com");
    expect(body.keys_count).toBeGreaterThanOrEqual(1);
    expect(body.skills_count).toBe(0);
    expect(typeof body.created_at).toBe("string");
    expect(typeof body.verified_at).toBe("string");
  });

  it("4. /keys with account-bound key contains the auth key's keyId", async () => {
    const { key } = await magicLinkBoundKey("bob@example.com");

    const res = await getReq("/v1/account/keys", { Authorization: `Bearer ${key}` });
    expect(res.status).toBe(200);
    const body = await res.json() as { keys: { keyId: string }[] };
    expect(body.keys.length).toBeGreaterThanOrEqual(1);
    // keyId is the first 32 hex chars of the body of the ubr_<48hex> key
    const expectedKeyId = key.slice("ubr_".length, "ubr_".length + 32);
    expect(body.keys.some((k) => k.keyId === expectedKeyId)).toBe(true);
  });

  it("5. /skills with account-bound key returns empty array (Slice 2 stub)", async () => {
    const { key } = await magicLinkBoundKey("carol@example.com");

    const res = await getReq("/v1/account/skills", { Authorization: `Bearer ${key}` });
    expect(res.status).toBe(200);
    const body = await res.json() as { skills: unknown[] };
    expect(Array.isArray(body.skills)).toBe(true);
    expect(body.skills.length).toBe(0);
  });

  it("6. binding two keys to same user — /keys returns both", async () => {
    const user = await upsertUser(baseEnv, "dave@example.com", { verifyNow: true });
    const k1 = await createLocalKey(baseEnv, "dave-1");
    const k2 = await createLocalKey(baseEnv, "dave-2");
    await bindKeyToUser(baseEnv, k1.keyId, user.user_id);
    await bindKeyToUser(baseEnv, k2.keyId, user.user_id);

    const res = await getReq("/v1/account/keys", { Authorization: `Bearer ${k1.key}` });
    expect(res.status).toBe(200);
    const body = await res.json() as { keys: { keyId: string }[] };
    const ids = body.keys.map((k) => k.keyId);
    expect(ids).toContain(k1.keyId);
    expect(ids).toContain(k2.keyId);
  });
});
