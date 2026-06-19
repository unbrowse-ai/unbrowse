/**
 * E2E witness (Dominion): the full caller path through the LIVE bearerAuth
 * middleware authenticating purely by wallet signature (web3-PK root) — and the
 * existing bearer-key path still working unchanged (web2 wrapper). Real key, real
 * ed25519 keypair, real KV (EmergentDB qdkv via fetch interceptor), real middleware.
 *   bun test backend/tests/auth-signature-e2e.test.ts
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Hono } from "hono";
import type { Env } from "../src/types.js";
import { clearKVCacheForTests } from "../src/services/kv.js";
import { bearerAuth } from "../src/middleware/auth.js";
import { createLocalKey, setKeyWallet } from "../src/services/keys.js";
import { authChallenge } from "../src/services/auth-signature.js";

const baseEnv: Env = {
  API_KEY: "admin-not-used",
  EMERGENTDB_API_KEY: "test",
  NEBIUS_API_KEY: "nebius",
  STATS_KV: {} as KVNamespace,
  ENVIRONMENT: "production", // REAL verify path (not the staging shortcut)
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

type ProbeEnv = { Bindings: Env; Variables: { agent_id: string; user_id?: string } };
function makeProbeApp(): Hono<ProbeEnv> {
  const app = new Hono<ProbeEnv>();
  app.get("/probe", bearerAuth, (c) => c.json({ agent_id: c.get("agent_id") }));
  return app;
}

const toHex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
async function freshWallet() {
  const kp = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]) as CryptoKeyPair;
  const pubkeyHex = toHex(new Uint8Array(await crypto.subtle.exportKey("raw", kp.publicKey)));
  const sign = async (m: string) => toHex(new Uint8Array(await crypto.subtle.sign({ name: "Ed25519" }, kp.privateKey, new TextEncoder().encode(m))));
  return { pubkeyHex, sign };
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

describe("E2E: bearerAuth authenticates by wallet signature (web3-PK root)", () => {
  it("signature headers alone (NO api key) authenticate as the bound agent → 200", async () => {
    const app = makeProbeApp();
    const { keyId } = await createLocalKey(baseEnv, "sig-e2e");
    const { pubkeyHex, sign } = await freshWallet();
    await setKeyWallet(baseEnv, keyId, pubkeyHex); // the key wraps this PK
    const ts = new Date().toISOString();
    const res = await app.fetch(new Request("http://local.test/probe", {
      headers: {
        "X-Unbrowse-Wallet": pubkeyHex,
        "X-Unbrowse-Auth-Ts": ts,
        "X-Unbrowse-Signature": await sign(authChallenge(pubkeyHex, ts)),
      },
    }), baseEnv);
    expect(res.status).toBe(200);
    expect((await res.json() as { agent_id: string }).agent_id).toBe(keyId);
  });

  it("the existing bearer-key path still authenticates unchanged (web2 wrapper) → 200", async () => {
    const app = makeProbeApp();
    const { key, keyId } = await createLocalKey(baseEnv, "key-e2e");
    const res = await app.fetch(new Request("http://local.test/probe", {
      headers: { Authorization: `Bearer ${key}` },
    }), baseEnv);
    expect(res.status).toBe(200);
    expect((await res.json() as { agent_id: string }).agent_id).toBe(keyId);
  });

  it("no credentials at all → 401 (the default anon gate is intact)", async () => {
    const app = makeProbeApp();
    const res = await app.fetch(new Request("http://local.test/probe"), baseEnv);
    expect(res.status).toBe(401);
  });

  it("a forged signature falls through to the 401 (no auth bypass)", async () => {
    const app = makeProbeApp();
    const { pubkeyHex } = await freshWallet();
    const res = await app.fetch(new Request("http://local.test/probe", {
      headers: {
        "X-Unbrowse-Wallet": pubkeyHex,
        "X-Unbrowse-Auth-Ts": new Date().toISOString(),
        "X-Unbrowse-Signature": "00".repeat(64),
      },
    }), baseEnv);
    expect(res.status).toBe(401); // signature invalid + no bearer key → missing-auth 401
  });
});
