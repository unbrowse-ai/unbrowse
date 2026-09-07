import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { app } from "../src/index.js";
import type { Env } from "../src/types.js";
import { clearKVCacheForTests } from "../src/services/kv.js";

/**
 * Step-5 e2e contract for /v1/claim/*. Drives the real Hono app + the real
 * EdbKV through a fake `fetch` that handles both:
 *   - api.emergentdb.com (KV reads/writes)
 *   - cloudflare-dns.com / dns.google (DoH lookups)
 *
 * No mocks of the unit under test. The DoH primitive receives a real fetch
 * that returns canned application/dns-json bodies.
 */

const baseEnv: Env = {
  API_KEY: "admin",
  EMERGENTDB_API_KEY: "test",
  NEBIUS_API_KEY: "nebius",
  STATS_KV: {} as KVNamespace,
  ENVIRONMENT: "staging",
  TURBOBOX_URL: "http://turbobox.local",
  R2_BUCKET: {} as R2Bucket,
  FAL_KEY: "fal",
  RESEND_API_KEY: "re_test",
  RESEND_FROM: "Unbrowse <auth@auth.unbrowse.ai>",
  PUBLIC_API_URL: "http://api.local",
};

const VALID_WALLET = "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin";
const OTHER_WALLET = "5tQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin";
const TEST_DOMAIN = "example.com";

type DohRoute = (txtName: string) => Response;

interface FetchHarness {
  kv: Map<string, string>;
  doh: { cloudflare: DohRoute; google: DohRoute };
  fetchImpl: typeof fetch;
}

function makeHarness(doh: { cloudflare: DohRoute; google: DohRoute }): FetchHarness {
  const kv = new Map<string, string>();
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const urlStr = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const url = new URL(urlStr);

    if (url.hostname === "api.emergentdb.com") {
      if (url.pathname === "/qdkv/set") {
        const body = JSON.parse(String(init?.body ?? "{}")) as { key: string; value: string };
        kv.set(body.key, body.value);
        return Response.json({ ok: true });
      }
      if (url.pathname.startsWith("/qdkv/get/")) {
        const key = decodeURIComponent(url.pathname.replace("/qdkv/get/", ""));
        const value = kv.get(key);
        return Response.json(value == null ? { found: false, value: null } : { found: true, value });
      }
      if (url.pathname.startsWith("/qdkv/del/")) {
        const key = decodeURIComponent(url.pathname.replace("/qdkv/del/", ""));
        kv.delete(key);
        return Response.json({ ok: true });
      }
      return Response.json({ ok: true });
    }

    if (url.hostname === "cloudflare-dns.com") {
      const txtName = url.searchParams.get("name") ?? "";
      return doh.cloudflare(txtName);
    }
    if (url.hostname === "dns.google") {
      const txtName = url.searchParams.get("name") ?? "";
      return doh.google(txtName);
    }

    throw new Error(`Unexpected fetch in test: ${urlStr}`);
  }) as typeof fetch;
  return { kv, doh, fetchImpl };
}

function dohMatchTxt(value: string): DohRoute {
  return () =>
    Response.json({
      Status: 0,
      Answer: [{ name: "x", type: 16, TTL: 60, data: `"${value}"` }],
    });
}

function dohNoRecord(): DohRoute {
  return () => Response.json({ Status: 0, Answer: [] });
}

function dohWrongTxt(value: string): DohRoute {
  return () =>
    Response.json({
      Status: 0,
      Answer: [{ name: "x", type: 16, TTL: 60, data: `"${value}"` }],
    });
}

async function postJson(path: string, body: unknown): Promise<Response> {
  return app.fetch(
    new Request(`http://local.test${path}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer stub-key`,
      },
      body: JSON.stringify(body),
    }),
    baseEnv,
  );
}

async function getJson(path: string): Promise<Response> {
  return app.fetch(
    new Request(`http://local.test${path}`, { method: "GET" }),
    baseEnv,
  );
}

let originalFetch: typeof fetch;
let currentHarness: FetchHarness;

function setHarness(doh: { cloudflare: DohRoute; google: DohRoute }): FetchHarness {
  currentHarness = makeHarness(doh);
  globalThis.fetch = currentHarness.fetchImpl;
  return currentHarness;
}

beforeEach(() => {
  originalFetch = globalThis.fetch;
  clearKVCacheForTests();
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  clearKVCacheForTests();
});

describe("/v1/claim/* Step 5 e2e (DoH + KV)", () => {
  it("golden path: challenge -> verify (dual-DoH match) -> status returns binding", async () => {
    // First fetch the challenge so we know exactly which TXT value the DoH
    // fakes need to return.
    const h = setHarness({ cloudflare: dohNoRecord(), google: dohNoRecord() });

    const chRes = await postJson("/v1/claim/challenge", {
      domain: TEST_DOMAIN,
      wallet_address: VALID_WALLET,
    });
    expect(chRes.status).toBe(200);
    const challenge = (await chRes.json()) as {
      txt_name: string;
      txt_value: string;
      expires_at: string;
    };
    expect(challenge.txt_name).toBe(`_unbrowse-claim.${TEST_DOMAIN}`);
    expect(challenge.txt_value).toContain(`wallet=${VALID_WALLET}`);

    // KV row exists at the per-(domain, wallet) challenge key.
    const challengeKey = `staging-stats:domain-claim-challenge:${TEST_DOMAIN}:${VALID_WALLET}`;
    expect(h.kv.has(challengeKey)).toBe(true);

    // Now swap the DoH fakes to return the matching TXT for verify. Reuse
    // the same KV map so the challenge row is still readable.
    h.doh.cloudflare = dohMatchTxt(challenge.txt_value);
    h.doh.google = dohMatchTxt(challenge.txt_value);

    const vRes = await postJson("/v1/claim/verify", {
      domain: TEST_DOMAIN,
      wallet_address: VALID_WALLET,
    });
    expect(vRes.status).toBe(200);
    const vBody = (await vRes.json()) as {
      ok: boolean;
      verified_at: string;
      domain: string;
      wallet_address: string;
    };
    expect(vBody.ok).toBe(true);
    expect(vBody.domain).toBe(TEST_DOMAIN);
    expect(vBody.wallet_address).toBe(VALID_WALLET);
    expect(() => new Date(vBody.verified_at).toISOString()).not.toThrow();

    // Binding row exists with full schema.
    const bindingKey = `staging-stats:domain-wallet:${TEST_DOMAIN}`;
    expect(h.kv.has(bindingKey)).toBe(true);
    const stored = JSON.parse(h.kv.get(bindingKey)!) as Record<string, unknown>;
    expect(stored.domain).toBe(TEST_DOMAIN);
    expect(stored.wallet_address).toBe(VALID_WALLET);
    expect(stored.schema_version).toBe(1);
    expect(Array.isArray(stored.doh_attestations)).toBe(true);
    expect((stored.doh_attestations as unknown[]).length).toBe(2);
    expect(stored.txt_value_witness).toBe(challenge.txt_value);

    // Status route returns the verified binding to a public caller.
    const sRes = await getJson(`/v1/claim/status?domain=${TEST_DOMAIN}`);
    expect(sRes.status).toBe(200);
    const sBody = (await sRes.json()) as {
      verified: boolean;
      wallet_address?: string;
      verified_at?: string;
    };
    expect(sBody.verified).toBe(true);
    expect(sBody.wallet_address).toBe(VALID_WALLET);
    expect(sBody.verified_at).toBe(vBody.verified_at);
  });

  it("verify after challenge expired returns 410 challenge_expired", async () => {
    const h = setHarness({ cloudflare: dohNoRecord(), google: dohNoRecord() });

    // Hand-write a stale challenge directly into KV (TTL doesn't kick in
    // through the EdbKV fake set above, so we simulate expiry via the
    // record's expires_at field — domain-claim.ts re-checks that defensively).
    const txtName = `_unbrowse-claim.${TEST_DOMAIN}`;
    const txtValue = `unbrowse-claim=deadbeef;wallet=${VALID_WALLET}`;
    const expiredRecord = {
      domain: TEST_DOMAIN,
      wallet_address: VALID_WALLET,
      challenge: "deadbeef",
      txt_name: txtName,
      txt_value: txtValue,
      created_at: new Date(Date.now() - 2 * 86400 * 1000).toISOString(),
      expires_at: new Date(Date.now() - 60 * 1000).toISOString(),
      agent_id: "stub-agent",
    };
    h.kv.set(
      `staging-stats:domain-claim-challenge:${TEST_DOMAIN}:${VALID_WALLET}`,
      JSON.stringify(expiredRecord),
    );

    const vRes = await postJson("/v1/claim/verify", {
      domain: TEST_DOMAIN,
      wallet_address: VALID_WALLET,
    });
    expect(vRes.status).toBe(410);
    const body = (await vRes.json()) as { error: string };
    expect(body.error).toBe("challenge_expired");
  });

  it("adversarial: DoH returns matching TXT but verify request wallet does not match challenge wallet -> 404 no_challenge", async () => {
    // Anti-replay guarantee: the challenge key is (domain, wallet)-tuple
    // scoped, so a DNS record minted for wallet A cannot be consumed by
    // wallet B even if the TXT contents are byte-identical. The verify
    // route looks up its KV row using the REQUEST wallet, not the wallet
    // embedded in the TXT.
    const h = setHarness({ cloudflare: dohNoRecord(), google: dohNoRecord() });

    // Step 1: wallet A mints a challenge.
    const chRes = await postJson("/v1/claim/challenge", {
      domain: TEST_DOMAIN,
      wallet_address: VALID_WALLET,
    });
    expect(chRes.status).toBe(200);
    const challenge = (await chRes.json()) as { txt_value: string };

    // Step 2: DoH returns wallet-A's TXT exactly.
    h.doh.cloudflare = dohMatchTxt(challenge.txt_value);
    h.doh.google = dohMatchTxt(challenge.txt_value);

    // Step 3: wallet B calls verify. There is no challenge KV row at
    // (domain, walletB), so the handler must reject with 404 no_challenge
    // BEFORE it ever reaches the DoH primitive. This is the wallet-binding
    // anti-replay guarantee from firmament-step2.md "Anti-spoofing".
    const vRes = await postJson("/v1/claim/verify", {
      domain: TEST_DOMAIN,
      wallet_address: OTHER_WALLET,
    });
    expect(vRes.status).toBe(404);
    const body = (await vRes.json()) as { error: string };
    expect(body.error).toBe("no_challenge");
  });

  it("verify when DoH returns mismatching TXT -> 409 dns_mismatch", async () => {
    const h = setHarness({ cloudflare: dohNoRecord(), google: dohNoRecord() });

    const chRes = await postJson("/v1/claim/challenge", {
      domain: TEST_DOMAIN,
      wallet_address: VALID_WALLET,
    });
    expect(chRes.status).toBe(200);

    h.doh.cloudflare = dohWrongTxt("unbrowse-claim=other;wallet=other");
    h.doh.google = dohWrongTxt("unbrowse-claim=other;wallet=other");

    const vRes = await postJson("/v1/claim/verify", {
      domain: TEST_DOMAIN,
      wallet_address: VALID_WALLET,
    });
    expect(vRes.status).toBe(409);
    const body = (await vRes.json()) as { ok: boolean; error: string };
    expect(body.ok).toBe(false);
    expect(body.error).toBe("dns_mismatch");
  });

  it("verify when only one DoH provider matches -> 409 partial_propagation", async () => {
    const h = setHarness({ cloudflare: dohNoRecord(), google: dohNoRecord() });

    const chRes = await postJson("/v1/claim/challenge", {
      domain: TEST_DOMAIN,
      wallet_address: VALID_WALLET,
    });
    expect(chRes.status).toBe(200);
    const challenge = (await chRes.json()) as { txt_value: string };

    h.doh.cloudflare = dohMatchTxt(challenge.txt_value);
    h.doh.google = dohNoRecord();

    const vRes = await postJson("/v1/claim/verify", {
      domain: TEST_DOMAIN,
      wallet_address: VALID_WALLET,
    });
    expect(vRes.status).toBe(409);
    const body = (await vRes.json()) as { ok: boolean; error: string };
    expect(body.error).toBe("partial_propagation");
  });

  it("re-verify with second wallet AFTER first wallet bound -> 409 wallet_conflict", async () => {
    // The first wallet successfully claims the domain. A second wallet then
    // mints its own challenge, sets up DoH, and calls verify. Even though
    // its own (domain, wallet) challenge row exists AND DoH returns the
    // matching value, the binding row already names a different wallet —
    // the handler must reject.
    const h = setHarness({ cloudflare: dohNoRecord(), google: dohNoRecord() });

    // First-wallet golden path.
    const ch1 = await postJson("/v1/claim/challenge", {
      domain: TEST_DOMAIN,
      wallet_address: VALID_WALLET,
    });
    const challenge1 = (await ch1.json()) as { txt_value: string };
    h.doh.cloudflare = dohMatchTxt(challenge1.txt_value);
    h.doh.google = dohMatchTxt(challenge1.txt_value);
    const v1 = await postJson("/v1/claim/verify", {
      domain: TEST_DOMAIN,
      wallet_address: VALID_WALLET,
    });
    expect(v1.status).toBe(200);

    // Second-wallet attempt.
    const ch2 = await postJson("/v1/claim/challenge", {
      domain: TEST_DOMAIN,
      wallet_address: OTHER_WALLET,
    });
    const challenge2 = (await ch2.json()) as { txt_value: string };
    h.doh.cloudflare = dohMatchTxt(challenge2.txt_value);
    h.doh.google = dohMatchTxt(challenge2.txt_value);
    const v2 = await postJson("/v1/claim/verify", {
      domain: TEST_DOMAIN,
      wallet_address: OTHER_WALLET,
    });
    expect(v2.status).toBe(409);
    const body = (await v2.json()) as { ok: boolean; error: string };
    expect(body.error).toBe("wallet_conflict");
  });

  it("rate-limit: 11th challenge mint for the same domain returns 429 rate_limited", async () => {
    setHarness({ cloudflare: dohNoRecord(), google: dohNoRecord() });

    // 10 mints should pass. Vary wallet to avoid the (domain, wallet)
    // challenge-key collision masking the domain-only rate-limit.
    for (let i = 0; i < 10; i += 1) {
      // Build 10 syntactically valid wallets by mutating the last char.
      // The base58 alphabet excludes 0/O/I/l so we draw from a safe set.
      const safe = "23456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
      const w = VALID_WALLET.slice(0, -1) + safe[i];
      const res = await postJson("/v1/claim/challenge", {
        domain: TEST_DOMAIN,
        wallet_address: w,
      });
      expect(res.status).toBe(200);
    }

    const res = await postJson("/v1/claim/challenge", {
      domain: TEST_DOMAIN,
      wallet_address: VALID_WALLET,
    });
    expect(res.status).toBe(429);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("rate_limited");
  });

  it("status for unverified domain returns { verified: false }", async () => {
    setHarness({ cloudflare: dohNoRecord(), google: dohNoRecord() });
    const res = await getJson(`/v1/claim/status?domain=never-claimed.example`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { verified: boolean };
    expect(body.verified).toBe(false);
  });
});
