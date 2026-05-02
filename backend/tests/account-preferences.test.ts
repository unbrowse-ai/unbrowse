import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { app } from "../src/index.js";
import type { Env } from "../src/types.js";
import { clearKVCacheForTests } from "../src/services/kv.js";
import { createLocalKey } from "../src/services/keys.js";

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

async function patchReq(path: string, body: unknown, headers: Record<string, string> = {}): Promise<Response> {
  const init: RequestInit = {
    method: "PATCH",
    headers: { "Content-Type": "application/json", ...headers },
  };
  if (body !== undefined) init.body = typeof body === "string" ? body : JSON.stringify(body);
  return app.fetch(new Request(`http://local.test${path}`, init), baseEnv);
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

describe("/v1/account/preferences", () => {
  it("1. GET with anonymous key returns 403 account_required", async () => {
    const { key } = await createLocalKey(baseEnv, "anon-prefs");
    const res = await getReq("/v1/account/preferences", { Authorization: `Bearer ${key}` });
    expect(res.status).toBe(403);
    const body = await res.json() as { error: string };
    expect(body.error).toBe("account_required");
  });

  it("2. GET with no Authorization returns 401", async () => {
    const res = await getReq("/v1/account/preferences");
    expect(res.status).toBe(401);
  });

  it("3. GET with account-bound key returns share_pointers: false default", async () => {
    const { key } = await magicLinkBoundKey("alice-prefs@example.com");
    const res = await getReq("/v1/account/preferences", { Authorization: `Bearer ${key}` });
    expect(res.status).toBe(200);
    const body = await res.json() as { share_pointers: boolean };
    expect(body.share_pointers).toBe(false);
  });

  it("4. PATCH share_pointers: true persists, GET reflects it", async () => {
    const { key } = await magicLinkBoundKey("bob-prefs@example.com");
    const patchRes = await patchReq("/v1/account/preferences", { share_pointers: true }, { Authorization: `Bearer ${key}` });
    expect(patchRes.status).toBe(200);
    const patchBody = await patchRes.json() as { share_pointers: boolean };
    expect(patchBody.share_pointers).toBe(true);

    const getRes = await getReq("/v1/account/preferences", { Authorization: `Bearer ${key}` });
    expect(getRes.status).toBe(200);
    const getBody = await getRes.json() as { share_pointers: boolean };
    expect(getBody.share_pointers).toBe(true);
  });

  it("5. PATCH share_pointers: false flips back, GET reflects", async () => {
    const { key } = await magicLinkBoundKey("carol-prefs@example.com");
    await patchReq("/v1/account/preferences", { share_pointers: true }, { Authorization: `Bearer ${key}` });

    const patchRes = await patchReq("/v1/account/preferences", { share_pointers: false }, { Authorization: `Bearer ${key}` });
    expect(patchRes.status).toBe(200);
    const patchBody = await patchRes.json() as { share_pointers: boolean };
    expect(patchBody.share_pointers).toBe(false);

    const getRes = await getReq("/v1/account/preferences", { Authorization: `Bearer ${key}` });
    const getBody = await getRes.json() as { share_pointers: boolean };
    expect(getBody.share_pointers).toBe(false);
  });

  it("6. PATCH with non-boolean share_pointers returns 400 invalid_input", async () => {
    const { key } = await magicLinkBoundKey("dave-prefs@example.com");
    const headers = { Authorization: `Bearer ${key}` };

    for (const bad of [{ share_pointers: "true" }, { share_pointers: 1 }, { share_pointers: null }]) {
      const res = await patchReq("/v1/account/preferences", bad, headers);
      expect(res.status).toBe(400);
      const body = await res.json() as { error: string };
      expect(body.error).toBe("invalid_input");
    }
  });

  it("7. PATCH with empty body returns 200 with current prefs unchanged", async () => {
    const { key } = await magicLinkBoundKey("eve-prefs@example.com");
    await patchReq("/v1/account/preferences", { share_pointers: true }, { Authorization: `Bearer ${key}` });

    const patchRes = await patchReq("/v1/account/preferences", "", { Authorization: `Bearer ${key}` });
    expect(patchRes.status).toBe(200);
    const body = await patchRes.json() as { share_pointers: boolean };
    expect(body.share_pointers).toBe(true);
  });

  it("8. Two users have independent preferences", async () => {
    const a = await magicLinkBoundKey("user-a-prefs@example.com");
    const b = await magicLinkBoundKey("user-b-prefs@example.com");

    const setA = await patchReq("/v1/account/preferences", { share_pointers: true }, { Authorization: `Bearer ${a.key}` });
    expect(setA.status).toBe(200);

    const getA = await getReq("/v1/account/preferences", { Authorization: `Bearer ${a.key}` });
    expect((await getA.json() as { share_pointers: boolean }).share_pointers).toBe(true);

    const getB = await getReq("/v1/account/preferences", { Authorization: `Bearer ${b.key}` });
    expect(getB.status).toBe(200);
    expect((await getB.json() as { share_pointers: boolean }).share_pointers).toBe(false);
  });
});
