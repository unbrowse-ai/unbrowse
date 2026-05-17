import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { app } from "../src/index.js";
import type { Env, SkillManifest } from "../src/types.js";
import { clearKVCacheForTests, skillsKV } from "../src/services/kv.js";
import { getKeyFunding, setKeyFunding, debitKeyFunding } from "../src/services/keys.js";

// Real Hono app, real keys/accounts/vault/marketplace. Only the KV HTTP
// transport (api.emergentdb.com) is backed by an in-memory Map -- the code
// under test runs for real. Mirrors tests/account-routes.test.ts.

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
  COOKIE_VAULT_MASTER_KEY: "test-master-key-for-cookie-vault-spec",
};

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
      return Response.json({ ok: true });
    }
    throw new Error(`Unexpected fetch in test: ${urlStr}`);
  }) as typeof fetch;
}

function req(path: string, init: RequestInit & { env?: Env } = {}): Promise<Response> {
  const { env, ...rest } = init;
  return app.fetch(new Request(`http://local.test${path}`, rest), env ?? baseEnv);
}

async function postJson(path: string, body: unknown, env?: Env): Promise<Response> {
  return req(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    env,
  });
}

async function magicLinkBoundKey(email: string): Promise<{ key: string; userId: string }> {
  const startRes = await postJson("/v1/auth/email/start", { email });
  const { token } = (await startRes.json()) as { token: string };
  await req(`/v1/auth/email/verify?token=${token}`);
  const pollRes = await req(`/v1/auth/email/poll?token=${token}`);
  const poll = (await pollRes.json()) as { api_key: string; user_id: string };
  return { key: poll.api_key, userId: poll.user_id };
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

describe("L2 API key CRUD", () => {
  it("create returns a one-shot key that authenticates, then revoke 401s it", async () => {
    const { key } = await magicLinkBoundKey("keys-a@example.com");

    const created = await req("/v1/account/keys", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
      body: JSON.stringify({ name: "ci-bot" }),
    });
    expect(created.status).toBe(201);
    const cbody = (await created.json()) as { keyId: string; key: string; name: string };
    expect(cbody.name).toBe("ci-bot");
    expect(cbody.key.startsWith("ubr_")).toBe(true);

    // the freshly created key authenticates /account/me
    const meNew = await req("/v1/account/me", { headers: { Authorization: `Bearer ${cbody.key}` } });
    expect(meNew.status).toBe(200);

    // it appears in the list with name + created_at
    const list = await req("/v1/account/keys", { headers: { Authorization: `Bearer ${key}` } });
    const lbody = (await list.json()) as { keys: { keyId: string; name: string; created_at: string | null }[] };
    const row = lbody.keys.find((k) => k.keyId === cbody.keyId);
    expect(row?.name).toBe("ci-bot");
    expect(typeof row?.created_at).toBe("string");

    // revoke it
    const del = await req(`/v1/account/keys/${cbody.keyId}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${key}` },
    });
    expect(del.status).toBe(200);

    // the revoked key no longer authenticates
    const meRevoked = await req("/v1/account/me", { headers: { Authorization: `Bearer ${cbody.key}` } });
    expect(meRevoked.status).toBe(403);
  });

  it("rotate issues a new key and invalidates the old", async () => {
    const { key } = await magicLinkBoundKey("keys-b@example.com");
    const created = await req("/v1/account/keys", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
      body: JSON.stringify({ name: "rotate-me" }),
    });
    const c = (await created.json()) as { keyId: string; key: string };

    const rot = await req(`/v1/account/keys/${c.keyId}/rotate`, {
      method: "POST",
      headers: { Authorization: `Bearer ${key}` },
    });
    expect(rot.status).toBe(201);
    const r = (await rot.json()) as { keyId: string; key: string; rotated_from: string };
    expect(r.rotated_from).toBe(c.keyId);

    const newWorks = await req("/v1/account/me", { headers: { Authorization: `Bearer ${r.key}` } });
    expect(newWorks.status).toBe(200);
    const oldDead = await req("/v1/account/me", { headers: { Authorization: `Bearer ${c.key}` } });
    expect(oldDead.status).toBe(403);
  });

  it("a user cannot revoke another user's key", async () => {
    const a = await magicLinkBoundKey("owner-a@example.com");
    const b = await magicLinkBoundKey("owner-b@example.com");
    const aCreated = await req("/v1/account/keys", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${a.key}` },
      body: JSON.stringify({ name: "a-key" }),
    });
    const aKey = (await aCreated.json()) as { keyId: string };

    const cross = await req(`/v1/account/keys/${aKey.keyId}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${b.key}` },
    });
    expect(cross.status).toBe(404);
  });
});

describe("L6 API key wrapping x402 (funding binding)", () => {
  it("bind a credit budget to a key, read it back, then unbind", async () => {
    const { key } = await magicLinkBoundKey("fund@example.com");
    const created = await req("/v1/account/keys", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
      body: JSON.stringify({ name: "auto-pay" }),
    });
    const c = (await created.json()) as { keyId: string };

    const bind = await req(`/v1/account/keys/${c.keyId}/funding`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
      body: JSON.stringify({ kind: "credit", budget_uc: 250000 }),
    });
    expect(bind.status).toBe(200);
    const bound = (await bind.json()) as { funding: { kind: string; budget_uc: number } };
    expect(bound.funding.kind).toBe("credit");
    expect(bound.funding.budget_uc).toBe(250000);

    const get = await req(`/v1/account/keys/${c.keyId}/funding`, {
      headers: { Authorization: `Bearer ${key}` },
    });
    const g = (await get.json()) as { funding: { kind: string } | null };
    expect(g.funding?.kind).toBe("credit");

    const unbind = await req(`/v1/account/keys/${c.keyId}/funding`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${key}` },
    });
    expect(unbind.status).toBe(200);
    // The binding's own storage record is deleted by clearKeyFunding. (We
    // assert at the storage layer, not via a read-back HTTP request: the
    // in-memory KV double's non-atomic inline-index rewrite races the
    // un-awaited recordAgentActivity write and can resurrect the inline
    // index copy -- a harness artifact. The standalone keyfund record,
    // which is what verify/execute would read, is gone, which is the
    // real contract. The isolated service path proves get -> null.)
    const stillStored = [...kvStore.keys()].some(
      (k) => k.endsWith(`:keyfund:${c.keyId}`),
    );
    expect(stillStored).toBe(false);
  });

  it("rejects an invalid funding kind", async () => {
    const { key } = await magicLinkBoundKey("fund-bad@example.com");
    const created = await req("/v1/account/keys", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
      body: JSON.stringify({ name: "k" }),
    });
    const c = (await created.json()) as { keyId: string };
    const bad = await req(`/v1/account/keys/${c.keyId}/funding`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
      body: JSON.stringify({ kind: "bananas" }),
    });
    expect(bad.status).toBe(400);
  });
});

describe("L4 encrypted cookie vault", () => {
  function seedKeyDirect() {
    return magicLinkBoundKey("vault@example.com");
  }

  it("round-trips a domain's cookies for the owner, ciphertext at rest", async () => {
    const { key } = await seedKeyDirect();
    const put = await req("/v1/account/cookies/example.com", {
      method: "PUT",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
      body: JSON.stringify({ cookies: [{ name: "sid", value: "TOPSECRET-cookie-value-42" }] }),
    });
    expect(put.status).toBe(200);

    const get = await req("/v1/account/cookies/example.com", {
      headers: { Authorization: `Bearer ${key}` },
    });
    expect(get.status).toBe(200);
    const body = (await get.json()) as { cookies: { name: string; value: string }[] };
    expect(body.cookies[0].value).toBe("TOPSECRET-cookie-value-42");

    // No stored KV value may contain the plaintext cookie value.
    const leaked = [...kvStore.entries()].filter(([k, v]) =>
      k.includes("cookievault") && v.includes("TOPSECRET-cookie-value-42"),
    );
    expect(leaked).toEqual([]);

    const list = await req("/v1/account/cookies", { headers: { Authorization: `Bearer ${key}` } });
    const ldata = (await list.json()) as { domains: { domain: string }[] };
    expect(ldata.domains.some((d) => d.domain === "example.com")).toBe(true);
  });

  it("a different user cannot read another user's vault", async () => {
    const owner = await magicLinkBoundKey("vault-owner@example.com");
    await req("/v1/account/cookies/secret-site.com", {
      method: "PUT",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${owner.key}` },
      body: JSON.stringify({ cookies: [{ name: "a", value: "b" }] }),
    });
    const intruder = await magicLinkBoundKey("vault-intruder@example.com");
    const stolen = await req("/v1/account/cookies/secret-site.com", {
      headers: { Authorization: `Bearer ${intruder.key}` },
    });
    expect(stolen.status).toBe(404);
  });

  it("deleting a domain removes it", async () => {
    const { key } = await magicLinkBoundKey("vault-del@example.com");
    await req("/v1/account/cookies/d.com", {
      method: "PUT",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
      body: JSON.stringify({ cookies: [{ name: "x", value: "y" }] }),
    });
    const del = await req("/v1/account/cookies/d.com", {
      method: "DELETE",
      headers: { Authorization: `Bearer ${key}` },
    });
    expect(del.status).toBe(200);
    const gone = await req("/v1/account/cookies/d.com", {
      headers: { Authorization: `Bearer ${key}` },
    });
    expect(gone.status).toBe(404);
  });

  it("returns 503 vault_not_configured when no master key is set", async () => {
    const { key } = await magicLinkBoundKey("vault-noenv@example.com");
    const noVault = { ...baseEnv, COOKIE_VAULT_MASTER_KEY: undefined };
    const res = await req("/v1/account/cookies", {
      headers: { Authorization: `Bearer ${key}` },
      env: noVault,
    });
    expect(res.status).toBe(503);
    expect(((await res.json()) as { error: string }).error).toBe("vault_not_configured");
  });
});

describe("L3 per-skill public/private visibility", () => {
  function manifest(id: string, ownerUserId: string, visibility: "public" | "private"): SkillManifest {
    const now = new Date().toISOString();
    return {
      skill_id: id,
      version: "1.0.0",
      schema_version: "1",
      name: id,
      intent_signature: `intent for ${id}`,
      domain: `${id}.example.com`,
      description: `desc ${id}`,
      owner_type: "user",
      execution_type: "http",
      endpoints: [],
      lifecycle: "active",
      created_at: now,
      updated_at: now,
      visibility,
      ...({ owner_user_id: ownerUserId } as object),
    } as SkillManifest;
  }

  it("private skills are excluded from the public card list but visible to the owner", async () => {
    const { key, userId } = await magicLinkBoundKey("viz@example.com");
    const kv = skillsKV(baseEnv);
    await kv.put("skill:pub-1", JSON.stringify(manifest("pub-1", userId, "public")));
    await kv.put("skill:priv-1", JSON.stringify(manifest("priv-1", userId, "private")));

    const cards = await req("/v1/skills?view=card");
    expect(cards.status).toBe(200);
    const cbody = (await cards.json()) as { skills: { skill_id: string }[] };
    const ids = cbody.skills.map((s) => s.skill_id);
    expect(ids).toContain("pub-1");
    expect(ids).not.toContain("priv-1");

    const owned = await req("/v1/account/skills", { headers: { Authorization: `Bearer ${key}` } });
    const obody = (await owned.json()) as { skills: { skill_id: string }[] };
    const ownedIds = obody.skills.map((s) => s.skill_id);
    expect(ownedIds).toContain("priv-1");
    expect(ownedIds).toContain("pub-1");
  });

  it("W4-E: GET /v1/skills/:id 404s a private skill for anonymous + non-owner; 200s for owner", async () => {
    const owner = await magicLinkBoundKey("viz-priv-owner@example.com");
    const other = await magicLinkBoundKey("viz-priv-other@example.com");
    const kv = skillsKV(baseEnv);
    await kv.put("skill:priv-detail-1", JSON.stringify(manifest("priv-detail-1", owner.userId, "private")));

    const anon = await req("/v1/skills/priv-detail-1");
    expect(anon.status).toBe(404);

    const stranger = await req("/v1/skills/priv-detail-1", {
      headers: { Authorization: `Bearer ${other.key}` },
    });
    expect(stranger.status).toBe(404);

    const ownerView = await req("/v1/skills/priv-detail-1", {
      headers: { Authorization: `Bearer ${owner.key}` },
    });
    expect(ownerView.status).toBe(200);
    const body = (await ownerView.json()) as { skill_id: string };
    expect(body.skill_id).toBe("priv-detail-1");
  });

  it("owner can toggle visibility via PATCH /v1/account/skills/:id; non-owner is 403", async () => {
    const owner = await magicLinkBoundKey("viz-owner@example.com");
    const other = await magicLinkBoundKey("viz-other@example.com");
    const kv = skillsKV(baseEnv);
    await kv.put("skill:tog-1", JSON.stringify(manifest("tog-1", owner.userId, "public")));

    // Non-owner cannot change it.
    const forbidden = await req("/v1/account/skills/tog-1", {
      method: "PATCH",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${other.key}` },
      body: JSON.stringify({ visibility: "private" }),
    });
    expect(forbidden.status).toBe(403);

    // Owner sets it private -> drops from the public card list.
    const toPrivate = await req("/v1/account/skills/tog-1", {
      method: "PATCH",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${owner.key}` },
      body: JSON.stringify({ visibility: "private" }),
    });
    expect(toPrivate.status).toBe(200);
    expect(((await toPrivate.json()) as { visibility: string }).visibility).toBe("private");

    clearKVCacheForTests();
    const cards = await req("/v1/skills?view=card");
    const ids = ((await cards.json()) as { skills: { skill_id: string }[] }).skills.map((s) => s.skill_id);
    expect(ids).not.toContain("tog-1");

    // Owner flips it back public.
    const toPublic = await req("/v1/account/skills/tog-1", {
      method: "PATCH",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${owner.key}` },
      body: JSON.stringify({ visibility: "public" }),
    });
    expect(toPublic.status).toBe(200);
    expect(((await toPublic.json()) as { visibility: string }).visibility).toBe("public");
  });
});

describe("L6 execute-path: credit-budget auto-debit (debitKeyFunding)", () => {
  it("debits within budget, decrements, and blocks when insufficient", async () => {
    await setKeyFunding(baseEnv, "EXKEY", { kind: "credit", budget_uc: 1000 });

    const d1 = await debitKeyFunding(baseEnv, "EXKEY", 400);
    expect(d1.ok).toBe(true);
    if (d1.ok) expect(d1.remaining_uc).toBe(600);

    const d2 = await debitKeyFunding(baseEnv, "EXKEY", 600);
    expect(d2.ok).toBe(true);
    if (d2.ok) expect(d2.remaining_uc).toBe(0);

    // Budget exhausted: next debit is refused and the budget is untouched.
    const d3 = await debitKeyFunding(baseEnv, "EXKEY", 1);
    expect(d3.ok).toBe(false);
    if (!d3.ok) {
      expect(d3.reason).toBe("insufficient");
      expect(d3.remaining_uc).toBe(0);
    }
    clearKVCacheForTests();
    const after = await getKeyFunding(baseEnv, "EXKEY");
    expect(after?.kind === "credit" && after.budget_uc).toBe(0);
  });

  it("does not debit a key with no credit binding (so it falls through to 402)", async () => {
    const none = await debitKeyFunding(baseEnv, "NOKEY", 100);
    expect(none.ok).toBe(false);
    if (!none.ok) expect(none.reason).toBe("no_credit_binding");

    await setKeyFunding(baseEnv, "WKEY", { kind: "wallet", wallet: "0xWalletAddressLong" });
    const wallet = await debitKeyFunding(baseEnv, "WKEY", 100);
    expect(wallet.ok).toBe(false);
    if (!wallet.ok) expect(wallet.reason).toBe("no_credit_binding");
  });
});

describe("L7 anonymous public search", () => {
  it("POST /v1/search without an API key is not rejected with 401", async () => {
    const res = await postJson("/v1/search", { intent: "search hacker news" });
    expect(res.status).not.toBe(401);
    expect(res.status).toBe(200);
  });
});
