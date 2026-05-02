import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { app } from "../src/index.js";
import type { Env } from "../src/types.js";
import { clearKVCacheForTests } from "../src/services/kv.js";

// Adversarial coverage of the magic-link token surface. Uses the real Hono
// app + real EdbKV via the same in-test fetch interceptor pattern as
// auth-routes-magic-flow.test.ts. Only globalThis.fetch is stubbed (Resend +
// EmergentDB qdkv). All accounts/keys/KV logic uses REAL implementations.

interface ResendCall { url: string; body: any; auth: string | null }

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

let originalFetch: typeof fetch;
let resendCalls: ResendCall[];
let kvStore: Map<string, string>;

function makeFetch(store: Map<string, string>, calls: ResendCall[]): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const urlStr = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const url = new URL(urlStr);

    if (url.hostname === "api.resend.com") {
      const headers = init?.headers as Record<string, string> | undefined;
      calls.push({
        url: urlStr,
        body: JSON.parse(String(init?.body ?? "{}")),
        auth: headers?.Authorization ?? headers?.authorization ?? null,
      });
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

async function postJson(path: string, body: unknown, env: Env = baseEnv): Promise<Response> {
  return app.fetch(
    new Request(`http://local.test${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
    env,
  );
}

async function getReq(path: string, env: Env = baseEnv): Promise<Response> {
  return app.fetch(new Request(`http://local.test${path}`), env);
}

function randomHex(bytes: number): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(bytes)), (b) =>
    b.toString(16).padStart(2, "0"),
  ).join("");
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

describe("/v1/auth/email/* adversarial token surface", () => {
  it("1. Bare random forged token (never started) returns 410 mentioning expired/again", async () => {
    const res = await getReq("/v1/auth/email/verify?token=deadbeefdeadbeefdeadbeefdeadbeef");
    expect(res.status).toBe(410);
    const text = (await res.text()).toLowerCase();
    expect(text.includes("expired") || text.includes("again")).toBe(true);
  });

  it("2. Forged token mimicking real format returns 410 expired on poll, never calls Resend", async () => {
    const forged = randomHex(16); // 32-char lowercase hex, real-shape
    const res = await getReq(`/v1/auth/email/poll?token=${forged}`);
    expect(res.status).toBe(410);
    const body = await res.json() as { status: string };
    expect(body.status).toBe("expired");
    expect(resendCalls.length).toBe(0);
  });

  it("3. Token reuse on poll after verified-consume is rejected as expired", async () => {
    const startRes = await postJson("/v1/auth/email/start", { email: "reuse@example.com" });
    const { token } = await startRes.json() as { token: string };

    const verifyRes = await getReq(`/v1/auth/email/verify?token=${token}`);
    expect(verifyRes.status).toBe(200);

    const firstPoll = await getReq(`/v1/auth/email/poll?token=${token}`);
    expect(firstPoll.status).toBe(200);
    const firstBody = await firstPoll.json() as { status: string; api_key: string };
    expect(firstBody.status).toBe("verified");

    const secondPoll = await getReq(`/v1/auth/email/poll?token=${token}`);
    expect(secondPoll.status).toBe(410);
    const secondBody = await secondPoll.json() as { status: string; api_key?: string };
    expect(secondBody.status).toBe("expired");
    expect(secondBody.api_key).toBeUndefined();

    const thirdPoll = await getReq(`/v1/auth/email/poll?token=${token}`);
    expect(thirdPoll.status).toBe(410);
  });

  it("4. Token cannot be elevated by additional query params (user_id/admin/overwrite)", async () => {
    const startRes = await postJson("/v1/auth/email/start", { email: "victim@example.com" });
    const { token } = await startRes.json() as { token: string };

    const verifyRes = await getReq(
      `/v1/auth/email/verify?token=${token}&user_id=root&admin=1&overwrite=true`,
    );
    expect(verifyRes.status).toBe(200);
    const verifyText = (await verifyRes.text()).toLowerCase();
    expect(verifyText.includes("root")).toBe(false);
    expect(verifyText.includes("admin")).toBe(false);
    expect(verifyText.includes("overwrite")).toBe(false);

    const pollRes = await getReq(`/v1/auth/email/poll?token=${token}`);
    expect(pollRes.status).toBe(200);
    const pollBody = await pollRes.json() as {
      status: string; api_key: string; user_id: string; email: string;
    };
    expect(pollBody.status).toBe("verified");
    expect(pollBody.email).toBe("victim@example.com");
    expect(pollBody.user_id).toMatch(/^[0-9a-f]{24}$/);
    expect(pollBody.user_id).not.toBe("root");
    expect(pollBody.api_key).toMatch(/^ubr_[0-9a-f]{48}$/);
  });

  it("5. Token with whitespace/null bytes / empty token returns 400 or 410, never 500", async () => {
    const polluted = await getReq("/v1/auth/email/poll?token=%00%20deadbeef");
    expect([400, 410]).toContain(polluted.status);

    const empty = await getReq("/v1/auth/email/verify?token=");
    expect([400, 410]).toContain(empty.status);

    const emptyPoll = await getReq("/v1/auth/email/poll?token=");
    expect([400, 410]).toContain(emptyPoll.status);

    // No token param at all — still must not 500
    const missing = await getReq("/v1/auth/email/poll");
    expect([400, 410]).toContain(missing.status);
  });

  it("6. Token from email A cannot satisfy a poll for email B (no cross-pollination)", async () => {
    const startA = await postJson("/v1/auth/email/start", { email: "alpha@example.com" });
    const { token: tokenA } = await startA.json() as { token: string };

    const startB = await postJson("/v1/auth/email/start", { email: "bravo@example.com" });
    const { token: tokenB } = await startB.json() as { token: string };

    expect(tokenA).not.toBe(tokenB);

    // Verify A only
    const verifyA = await getReq(`/v1/auth/email/verify?token=${tokenA}`);
    expect(verifyA.status).toBe(200);

    // Poll B — must NOT return verified, must NOT carry A's api_key
    const pollB = await getReq(`/v1/auth/email/poll?token=${tokenB}`);
    expect(pollB.status).toBe(200);
    const pollBBody = await pollB.json() as { status: string; api_key?: string; email?: string };
    expect(pollBBody.status).toBe("pending");
    expect(pollBBody.api_key).toBeUndefined();
    expect(pollBBody.email).toBeUndefined();

    // Poll A — verified, with A's email only
    const pollA = await getReq(`/v1/auth/email/poll?token=${tokenA}`);
    expect(pollA.status).toBe(200);
    const pollABody = await pollA.json() as { status: string; email: string };
    expect(pollABody.status).toBe("verified");
    expect(pollABody.email).toBe("alpha@example.com");
  });

  it("7. Very long token (8KB random hex) returns 410, never crashes the handler", async () => {
    const huge = randomHex(4096); // 8192 hex chars
    const verifyRes = await getReq(`/v1/auth/email/verify?token=${huge}`);
    expect(verifyRes.status).toBe(410);

    const pollRes = await getReq(`/v1/auth/email/poll?token=${huge}`);
    expect(pollRes.status).toBe(410);
    const pollBody = await pollRes.json() as { status: string };
    expect(pollBody.status).toBe("expired");
  });

  it("8. Token query string is case-sensitive (uppercased hex does not satisfy lowercase store)", async () => {
    const startRes = await postJson("/v1/auth/email/start", { email: "case@example.com" });
    const { token } = await startRes.json() as { token: string };
    expect(token).toMatch(/^[0-9a-f]{32}$/);

    const upper = token.toUpperCase();
    expect(upper).not.toBe(token);

    const verifyUpper = await getReq(`/v1/auth/email/verify?token=${upper}`);
    expect(verifyUpper.status).toBe(410);

    const pollUpper = await getReq(`/v1/auth/email/poll?token=${upper}`);
    expect(pollUpper.status).toBe(410);
    const pollUpperBody = await pollUpper.json() as { status: string };
    expect(pollUpperBody.status).toBe("expired");

    // Original lowercase still works
    const pollLower = await getReq(`/v1/auth/email/poll?token=${token}`);
    expect(pollLower.status).toBe(200);
    const pollLowerBody = await pollLower.json() as { status: string };
    expect(pollLowerBody.status).toBe("pending");
  });
});
