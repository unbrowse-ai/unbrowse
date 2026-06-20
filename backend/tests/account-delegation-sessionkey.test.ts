/**
 * GET /v1/account/delegation/session-key — discovery for the non-custodial
 * delegation lane. A user needs the PLATFORM's delegation session-key PUBLIC
 * address to register it to their own escrow before binding a delegation.
 *
 * Witnesses:
 *   - CONFIGURED env (delegation session-key secret set) → returns a valid
 *     base58 Ed25519 pubkey + ready:true; the pubkey is the trailing 32 bytes
 *     of the keypair, base58-encoded (the same decode the signer uses).
 *   - UNCONFIGURED env (no secret) → ready:false, reason "delegation_not_configured",
 *     HTTP 200, and NO secret material anywhere in the body.
 *   - The held SECRET is NEVER present in the response body (only the derived
 *     public key).
 *
 * Real Hono app + the real account bearer-auth guard (light auth, matching the
 * sibling /account/* read routes); only the network boundary (EmergentDB +
 * Resend) is stubbed — same harness as account-keys-delegation.test.ts.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import bs58 from "bs58";
import { app } from "../src/index.js";
import type { Env } from "../src/types.js";
import { clearKVCacheForTests } from "../src/services/kv.js";
import { getDelegationSessionKeyAddress } from "../src/services/delegation-settlement.js";

// A 64-byte Solana keypair (seed||pubkey) as a JSON byte array — the same
// encoding the delegation-settlement test uses for the held secret.
const SECRET_BYTES = Array.from({ length: 64 }, (_, i) => i + 1);
const SECRET_JSON = JSON.stringify(SECRET_BYTES);
// The derived public key is the trailing 32 bytes, base58-encoded.
const EXPECTED_PUBKEY = bs58.encode(Uint8Array.from(SECRET_BYTES.slice(32, 64)));

function envWith(overrides: Partial<Env> = {}): Env {
  return {
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
    ...overrides,
  } as unknown as Env;
}

let originalFetch: typeof fetch;
let kvStore: Map<string, string>;

function makeFetch(store: Map<string, string>): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const urlStr = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const url = new URL(urlStr);

    if (url.hostname === "api.resend.com") {
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
        const items = [...store.entries()].filter(([k]) => k.startsWith(prefix)).map(([key, value]) => ({ key, value }));
        return Response.json({ items });
      }
      return Response.json({ ok: true });
    }
    throw new Error(`Unexpected fetch in test: ${urlStr}`);
  }) as typeof fetch;
}

async function postJson(env: Env, path: string, body: unknown): Promise<Response> {
  return app.fetch(
    new Request(`http://local.test${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
    env,
  );
}
async function getReq(env: Env, path: string, headers: Record<string, string> = {}): Promise<Response> {
  return app.fetch(new Request(`http://local.test${path}`, { headers }), env);
}

async function magicLinkKey(env: Env, email: string): Promise<string> {
  const startRes = await postJson(env, "/v1/auth/email/start", { email });
  const { token } = (await startRes.json()) as { token: string };
  await getReq(env, `/v1/auth/email/verify?token=${token}`);
  const pollRes = await getReq(env, `/v1/auth/email/poll?token=${token}`);
  const poll = (await pollRes.json()) as { api_key: string };
  return poll.api_key;
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

describe("getDelegationSessionKeyAddress — pubkey derivation (service)", () => {
  it("derives a valid base58 pubkey from a configured secret, never the secret", async () => {
    const env = envWith({ FLEX_DELEGATION_SESSION_KEY_SECRET: SECRET_JSON });
    const addr = await getDelegationSessionKeyAddress(env);
    expect(addr).toBe(EXPECTED_PUBKEY);
    // round-trips: it decodes to exactly 32 bytes (an Ed25519 pubkey)
    expect(bs58.decode(addr!).length).toBe(32);
    // it is NOT the secret bytes' base58 (the secret is 64 bytes)
    expect(addr).not.toBe(bs58.encode(Uint8Array.from(SECRET_BYTES)));
  });

  it("returns null when the lane is not configured", async () => {
    expect(await getDelegationSessionKeyAddress(envWith({}))).toBeNull();
    expect(await getDelegationSessionKeyAddress(envWith({ FLEX_DELEGATION_SESSION_KEY_SECRET: "   " }))).toBeNull();
  });
});

describe("GET /v1/account/delegation/session-key", () => {
  it("configured env → valid base58 pubkey + ready:true, no secret in body", async () => {
    const env = envWith({ FLEX_DELEGATION_SESSION_KEY_SECRET: SECRET_JSON });
    const key = await magicLinkKey(env, "deleg-sk-alice@example.com");
    const res = await getReq(env, "/v1/account/delegation/session-key", { Authorization: `Bearer ${key}` });
    expect(res.status).toBe(200);
    const raw = await res.text();
    const body = JSON.parse(raw) as { session_key_address?: string; ready: boolean; reason?: string };
    expect(body.ready).toBe(true);
    expect(body.session_key_address).toBe(EXPECTED_PUBKEY);
    expect(bs58.decode(body.session_key_address!).length).toBe(32);
    // NEVER leak the secret: neither the raw byte-array form nor any 64-byte
    // base58 of the secret appears in the response body.
    expect(raw).not.toContain(SECRET_JSON);
    expect(raw).not.toContain("33,34"); // a fragment of the trailing-secret JSON
    expect(raw).not.toContain(bs58.encode(Uint8Array.from(SECRET_BYTES)));
  });

  it("unconfigured env → ready:false, reason delegation_not_configured, 200, no secret", async () => {
    const env = envWith({}); // no FLEX_DELEGATION_SESSION_KEY_SECRET
    const key = await magicLinkKey(env, "deleg-sk-bob@example.com");
    const res = await getReq(env, "/v1/account/delegation/session-key", { Authorization: `Bearer ${key}` });
    expect(res.status).toBe(200);
    const raw = await res.text();
    const body = JSON.parse(raw) as { ready: boolean; reason?: string; session_key_address?: string };
    expect(body.ready).toBe(false);
    expect(body.reason).toBe("delegation_not_configured");
    expect(body.session_key_address).toBeUndefined();
    expect(raw).not.toContain(SECRET_JSON);
  });
});
