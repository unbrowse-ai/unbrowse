/**
 * POST/DELETE /v1/account/keys/:keyId/delegation — the non-custodial delegated
 * funding bind + revoke routes (design §3, Phase 1). Witnesses:
 *   - a valid bind sets funding {kind:"delegated"} with the delegated fields;
 *   - only the OWNER can bind (a foreign key's keyId is 404);
 *   - DELETE clears the delegation (revocation path 2);
 *   - cap_uc <= 0 (and missing fields) are rejected 400;
 *   - the wallet bind is hijack-hardened (a wallet owned by another key is refused).
 *
 * Real Hono app + real accounts/keys/KV; only the network boundary (EmergentDB +
 * Resend) is stubbed — same harness as account-routes.test.ts.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { app } from "../src/index.js";
import type { Env } from "../src/types.js";
import { clearKVCacheForTests } from "../src/services/kv.js";
import { createLocalKey, getKeyFunding, setKeyDelegation } from "../src/services/keys.js";

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
} as unknown as Env;

interface ResendCall { url: string; body: unknown }

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

async function postJson(path: string, body: unknown, headers: Record<string, string> = {}): Promise<Response> {
  return app.fetch(
    new Request(`http://local.test${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body: JSON.stringify(body),
    }),
    baseEnv,
  );
}

async function deleteReq(path: string, headers: Record<string, string> = {}): Promise<Response> {
  return app.fetch(new Request(`http://local.test${path}`, { method: "DELETE", headers }), baseEnv);
}

async function magicLinkBoundKey(email: string): Promise<{ key: string; userId: string; keyId: string }> {
  const startRes = await postJson("/v1/auth/email/start", { email });
  const { token } = (await startRes.json()) as { token: string };
  await getReq(`/v1/auth/email/verify?token=${token}`);
  const pollRes = await getReq(`/v1/auth/email/poll?token=${token}`);
  const poll = (await pollRes.json()) as { api_key: string; user_id: string };
  const keyId = poll.api_key.slice("ubr_".length, "ubr_".length + 32);
  return { key: poll.api_key, userId: poll.user_id, keyId };
}

const VALID_BODY = {
  wallet: "So1WalletOwner1111111111111111111111111111",
  escrow: "Escrow1PDA1111111111111111111111111111111",
  session_key_address: "SessKey1111111111111111111111111111111111",
  cap_uc: 1_000_000,
  expires_at_slot: "987654321",
};

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

describe("POST /v1/account/keys/:keyId/delegation", () => {
  it("1. binds funding {kind:'delegated'} with all delegated fields", async () => {
    const { key, keyId } = await magicLinkBoundKey("deleg-alice@example.com");
    const res = await postJson(`/v1/account/keys/${keyId}/delegation`, VALID_BODY, {
      Authorization: `Bearer ${key}`,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { keyId: string; funding: Record<string, unknown> };
    expect(body.funding.kind).toBe("delegated");
    expect(body.funding.wallet).toBe(VALID_BODY.wallet);
    expect(body.funding.escrow).toBe(VALID_BODY.escrow);
    expect(body.funding.session_key_address).toBe(VALID_BODY.session_key_address);
    expect(body.funding.cap_uc).toBe(VALID_BODY.cap_uc);
    expect(body.funding.expires_at_slot).toBe(VALID_BODY.expires_at_slot);
    expect(typeof body.funding.bound_at).toBe("string");

    // and it round-trips through getKeyFunding
    const persisted = await getKeyFunding(baseEnv, keyId);
    expect(persisted?.kind).toBe("delegated");
  });

  it("2. only the owner can bind — a non-owned keyId returns 404", async () => {
    const { key } = await magicLinkBoundKey("deleg-bob@example.com");
    // A key id this user does NOT own.
    const foreign = await createLocalKey(baseEnv, "foreign");
    const res = await postJson(`/v1/account/keys/${foreign.keyId}/delegation`, VALID_BODY, {
      Authorization: `Bearer ${key}`,
    });
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("not_found");
    // and nothing was bound on the foreign key
    expect(await getKeyFunding(baseEnv, foreign.keyId)).toBeNull();
  });

  it("3. cap_uc <= 0 is rejected 400", async () => {
    const { key, keyId } = await magicLinkBoundKey("deleg-carol@example.com");
    const res = await postJson(
      `/v1/account/keys/${keyId}/delegation`,
      { ...VALID_BODY, cap_uc: 0 },
      { Authorization: `Bearer ${key}` },
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("invalid_input");
    expect(await getKeyFunding(baseEnv, keyId)).toBeNull();
  });

  it("4. empty/missing required fields are rejected 400", async () => {
    const { key, keyId } = await magicLinkBoundKey("deleg-dave@example.com");
    for (const missing of ["wallet", "escrow", "session_key_address", "expires_at_slot"] as const) {
      const body = { ...VALID_BODY, [missing]: "" };
      const res = await postJson(`/v1/account/keys/${keyId}/delegation`, body, {
        Authorization: `Bearer ${key}`,
      });
      expect(res.status).toBe(400);
    }
    expect(await getKeyFunding(baseEnv, keyId)).toBeNull();
  });

  it("5. hijack-hardened — a wallet already owned by another key is refused 409", async () => {
    const a = await magicLinkBoundKey("deleg-owner-a@example.com");
    const b = await magicLinkBoundKey("deleg-owner-b@example.com");
    // a binds the wallet first.
    const first = await postJson(`/v1/account/keys/${a.keyId}/delegation`, VALID_BODY, {
      Authorization: `Bearer ${a.key}`,
    });
    expect(first.status).toBe(200);
    // b tries to delegate against the SAME wallet — must be refused (hijack guard).
    const second = await postJson(`/v1/account/keys/${b.keyId}/delegation`, VALID_BODY, {
      Authorization: `Bearer ${b.key}`,
    });
    expect(second.status).toBe(409);
    const body = (await second.json()) as { error: string };
    expect(body.error).toBe("wallet_already_bound");
    expect(await getKeyFunding(baseEnv, b.keyId)).toBeNull();
  });
});

describe("DELETE /v1/account/keys/:keyId/delegation", () => {
  it("6. clears the delegation (revocation path 2)", async () => {
    const { key, keyId } = await magicLinkBoundKey("deleg-erin@example.com");
    await setKeyDelegation(baseEnv, keyId, {
      wallet: VALID_BODY.wallet,
      escrow: VALID_BODY.escrow,
      session_key_address: VALID_BODY.session_key_address,
      cap_uc: VALID_BODY.cap_uc,
      expires_at_slot: VALID_BODY.expires_at_slot,
    });
    expect((await getKeyFunding(baseEnv, keyId))?.kind).toBe("delegated");

    const res = await deleteReq(`/v1/account/keys/${keyId}/delegation`, {
      Authorization: `Bearer ${key}`,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; funding: unknown };
    expect(body.ok).toBe(true);
    expect(body.funding).toBeNull();
    // The record is durably gone (the route deleted the underlying KV key). Drop
    // the in-isolate EdbKV index cache to read as a fresh next request would —
    // the cache is per-worker-isolate, so a real subsequent request always sees
    // the post-delete state.
    clearKVCacheForTests();
    expect(await getKeyFunding(baseEnv, keyId)).toBeNull();
  });

  it("7. after delete, the wallet is free to be re-delegated by another key", async () => {
    const a = await magicLinkBoundKey("deleg-recycle-a@example.com");
    const b = await magicLinkBoundKey("deleg-recycle-b@example.com");
    await postJson(`/v1/account/keys/${a.keyId}/delegation`, VALID_BODY, {
      Authorization: `Bearer ${a.key}`,
    });
    await deleteReq(`/v1/account/keys/${a.keyId}/delegation`, { Authorization: `Bearer ${a.key}` });
    // now b can claim the freed wallet
    const res = await postJson(`/v1/account/keys/${b.keyId}/delegation`, VALID_BODY, {
      Authorization: `Bearer ${b.key}`,
    });
    expect(res.status).toBe(200);
    expect((await getKeyFunding(baseEnv, b.keyId))?.kind).toBe("delegated");
  });

  it("8. delete on a non-owned key is 404", async () => {
    const { key } = await magicLinkBoundKey("deleg-frank@example.com");
    const foreign = await createLocalKey(baseEnv, "foreign-2");
    const res = await deleteReq(`/v1/account/keys/${foreign.keyId}/delegation`, {
      Authorization: `Bearer ${key}`,
    });
    expect(res.status).toBe(404);
  });
});
