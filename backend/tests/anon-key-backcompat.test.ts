import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Hono } from "hono";
import type { Env } from "../src/types.js";
import { clearKVCacheForTests } from "../src/services/kv.js";
import { bearerAuth } from "../src/middleware/auth.js";
import { createLocalKey } from "../src/services/keys.js";
import { bindKeyToUser, lookupUserIdByKey, upsertUser } from "../src/services/accounts.js";

// Backwards-compat regression test for the account-binding code shipped in
// commit ec8095a9 (backend/src/middleware/auth.ts). Proves the existing 819
// anonymous Unbrowse keys (which have no key2user record) still authenticate.
//
// Real implementations everywhere:
//   - createLocalKey mints a real ubr_<48hex> key and writes the keyhash into
//     the in-test EmergentDB qdkv store via the fetch interceptor below
//   - bearerAuth runs against that real store
//   - lookupUserIdByKey reads from that same store
//
// Only the network boundary is stubbed (matches auth-routes-magic-flow.test.ts).
// ENVIRONMENT is set to "production" so verifyKey takes the REAL path
// (verifyLocalKey -> sha256 -> KV lookup), not the staging "accept any token" shortcut.

const baseEnv: Env = {
  API_KEY: "admin-not-used",
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

function makeFetch(store: Map<string, string>): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const urlStr = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const url = new URL(urlStr);
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
      return Response.json({ ok: true });
    }
    throw new Error(`Unexpected fetch in test: ${urlStr}`);
  }) as typeof fetch;
}

// Probe app: a minimal Hono app that mounts bearerAuth on a single route and
// returns whatever bearerAuth set in the request context. This is contained,
// in-test, and changes no shipping code (option (b) in the task spec).
type ProbeEnv = { Bindings: Env; Variables: { agent_id: string; user_id?: string } };
function makeProbeApp(): Hono<ProbeEnv> {
  const app = new Hono<ProbeEnv>();
  app.get("/probe", bearerAuth, (c) => {
    return c.json({
      agent_id: c.get("agent_id"),
      user_id: c.get("user_id") ?? "<none>",
    });
  });
  return app;
}

async function probe(app: Hono<ProbeEnv>, key: string | null): Promise<Response> {
  const headers: Record<string, string> = {};
  if (key !== null) headers.Authorization = `Bearer ${key}`;
  return app.fetch(new Request("http://local.test/probe", { headers }), baseEnv);
}

beforeEach(() => {
  originalFetch = globalThis.fetch;
  kvStore = new Map();
  globalThis.fetch = makeFetch(kvStore);
  clearKVCacheForTests();
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  clearKVCacheForTests();
});

describe("anonymous key backwards-compat (existing 819 keys must still authenticate)", () => {
  it("1. anonymous key authenticates against bearerAuth (200, NOT 500)", async () => {
    const app = makeProbeApp();
    const { key } = await createLocalKey(baseEnv, "anon-test-1");

    const res = await probe(app, key);
    expect(res.status).toBe(200);
    const body = await res.json() as { agent_id: string; user_id: string };
    expect(body.agent_id).toMatch(/^[0-9a-f]{32}$/);
  });

  it("2. anonymous key never gets a user_id set in context", async () => {
    const app = makeProbeApp();
    const { key } = await createLocalKey(baseEnv, "anon-test-2");

    const res = await probe(app, key);
    expect(res.status).toBe(200);
    const body = await res.json() as { agent_id: string; user_id: string };
    expect(body.user_id).toBe("<none>");
  });

  it("3. account-bound key DOES get a user_id set in context", async () => {
    const app = makeProbeApp();
    const { key, keyId } = await createLocalKey(baseEnv, "bound-test-3");
    const user = await upsertUser(baseEnv, "alice@example.com", { verifyNow: true });
    await bindKeyToUser(baseEnv, keyId, user.user_id);

    const res = await probe(app, key);
    expect(res.status).toBe(200);
    const body = await res.json() as { agent_id: string; user_id: string };
    expect(body.user_id).toBe(user.user_id);
    expect(body.agent_id).toBe(keyId);
  });

  it("4. lookupUserIdByKey returns null (not throw) for unknown keyId", async () => {
    const result = await lookupUserIdByKey(baseEnv, "deadbeefdeadbeefdeadbeefdeadbeef");
    expect(result).toBeNull();
  });

  it("5. bad Authorization header returns 401/403 — no crash on the new lookup path", async () => {
    const app = makeProbeApp();

    const res = await probe(app, "notarealkey");
    // verifyLocalKey rejects unknown -> bearerAuth returns 403 INVALID_KEY
    expect([401, 403]).toContain(res.status);
    const body = await res.json() as { error: string };
    expect(body.error).toMatch(/Invalid|Missing/);
  });

  it("6. concurrent authed requests on an anonymous key all succeed (no shared-state race)", async () => {
    const app = makeProbeApp();
    const { key, keyId } = await createLocalKey(baseEnv, "anon-test-6");

    const results = await Promise.all(
      Array.from({ length: 10 }, () => probe(app, key)),
    );

    for (const res of results) {
      expect(res.status).toBe(200);
      const body = await res.json() as { agent_id: string; user_id: string };
      expect(body.agent_id).toBe(keyId);
      expect(body.user_id).toBe("<none>");
    }
  });

  it("7. concurrent authed requests on an account-bound key all see the same user_id", async () => {
    const app = makeProbeApp();
    const { key, keyId } = await createLocalKey(baseEnv, "bound-test-7");
    const user = await upsertUser(baseEnv, "bob@example.com", { verifyNow: true });
    await bindKeyToUser(baseEnv, keyId, user.user_id);

    const results = await Promise.all(
      Array.from({ length: 10 }, () => probe(app, key)),
    );

    for (const res of results) {
      expect(res.status).toBe(200);
      const body = await res.json() as { agent_id: string; user_id: string };
      expect(body.agent_id).toBe(keyId);
      expect(body.user_id).toBe(user.user_id);
    }
  });

  // 8. revokeLocalKey is a stub that always returns false (see backend/src/services/keys.ts:76),
  //    so revocation isn't actually implemented at the data layer — there's no way for a
  //    revoked key to coexist with a key2user record. Skipping per the task spec.
  it.skip("8. a revoked key returns 401 even if key2user is set (revokeLocalKey is a stub — see keys.ts)", () => {});
});
