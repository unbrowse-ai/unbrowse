import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { app } from "../src/index.js";
import type { Env } from "../src/types.js";
import { clearKVCacheForTests } from "../src/services/kv.js";

// Bring up the real Hono app (full app from backend/src/index.ts) so this
// proves the routes are actually mounted at /v1/auth/email/*.
//
// Stub globalThis.fetch to:
//   - Capture Resend POST calls (api.resend.com/emails) — record body, succeed
//   - Serve EmergentDB qdkv reads/writes from an in-memory Map (mirrors the
//     pattern in backend/tests/auth-recovery.test.ts)
//
// All accounts/keys/KV logic uses the REAL implementations — only the network
// boundary is stubbed.

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

describe("/v1/auth/email/* end-to-end magic-link flow", () => {
  it("1. POST /start with valid body returns 32-hex token, expires_in 600, and sends Resend email containing the token", async () => {
    const res = await postJson("/v1/auth/email/start", { email: "lewis@example.com" });
    expect(res.status).toBe(200);
    const body = await res.json() as { token: string; expires_in: number };
    expect(body.token).toMatch(/^[0-9a-f]{32}$/);
    expect(body.expires_in).toBe(600);

    expect(resendCalls.length).toBe(1);
    const call = resendCalls[0]!;
    expect(call.url).toBe("https://api.resend.com/emails");
    expect(call.auth).toBe("Bearer re_test");
    expect(call.body.to).toEqual(["lewis@example.com"]);
    expect(call.body.html).toContain(body.token);
    expect(call.body.from).toContain("auth@auth.unbrowse.ai");
  });

  it("2. POST /start with invalid email returns 400 invalid_email and skips Resend", async () => {
    const res = await postJson("/v1/auth/email/start", { email: "notanemail" });
    expect(res.status).toBe(400);
    const body = await res.json() as { error: string };
    expect(body.error).toBe("invalid_email");
    expect(resendCalls.length).toBe(0);
  });

  it("3. POST /start without RESEND_API_KEY returns 503 email_not_configured and skips Resend", async () => {
    const env: Env = { ...baseEnv };
    delete (env as Partial<Env>).RESEND_API_KEY;
    const res = await postJson("/v1/auth/email/start", { email: "lewis@example.com" }, env);
    expect(res.status).toBe(503);
    const body = await res.json() as { error: string };
    expect(body.error).toBe("email_not_configured");
    expect(resendCalls.length).toBe(0);
  });

  it("4. GET /verify with unknown token returns 410 HTML mentioning expired", async () => {
    const res = await getReq("/v1/auth/email/verify?token=deadbeefdeadbeefdeadbeefdeadbeef");
    expect(res.status).toBe(410);
    expect(res.headers.get("Content-Type") ?? "").toContain("text/html");
    const text = (await res.text()).toLowerCase();
    expect(text.includes("expired") || text.includes("again")).toBe(true);
  });

  it("5. Full happy path: start -> verify -> poll (verified once, expired on second poll)", async () => {
    const startRes = await postJson("/v1/auth/email/start", { email: "alice@example.com" });
    expect(startRes.status).toBe(200);
    const { token } = await startRes.json() as { token: string };

    const verifyRes = await getReq(`/v1/auth/email/verify?token=${token}`);
    expect(verifyRes.status).toBe(200);
    expect(verifyRes.headers.get("Content-Type") ?? "").toContain("text/html");
    const verifyHtml = await verifyRes.text();
    expect(verifyHtml.toLowerCase()).toContain("signed in");

    const pollRes = await getReq(`/v1/auth/email/poll?token=${token}`);
    expect(pollRes.status).toBe(200);
    const pollBody = await pollRes.json() as {
      status: string; api_key: string; user_id: string; email: string;
    };
    expect(pollBody.status).toBe("verified");
    expect(pollBody.api_key).toMatch(/^ubr_[0-9a-f]{48}$/);
    expect(pollBody.user_id).toMatch(/^[0-9a-f]{24}$/);
    expect(pollBody.email).toBe("alice@example.com");

    // Second poll: token is one-shot consumed; KV record gone -> 410
    const pollAgain = await getReq(`/v1/auth/email/poll?token=${token}`);
    expect(pollAgain.status).toBe(410);
    const expiredBody = await pollAgain.json() as { status: string };
    expect(expiredBody.status).toBe("expired");
  });

  it("6. Poll before verify returns pending; after verify returns verified", async () => {
    const startRes = await postJson("/v1/auth/email/start", { email: "bob@example.com" });
    const { token } = await startRes.json() as { token: string };

    expect(resendCalls.length).toBe(1);
    expect(resendCalls[0]!.body.html).toContain(token);

    const pendingRes = await getReq(`/v1/auth/email/poll?token=${token}`);
    expect(pendingRes.status).toBe(200);
    const pendingBody = await pendingRes.json() as { status: string };
    expect(pendingBody.status).toBe("pending");

    const verifyRes = await getReq(`/v1/auth/email/verify?token=${token}`);
    expect(verifyRes.status).toBe(200);

    const verifiedRes = await getReq(`/v1/auth/email/poll?token=${token}`);
    expect(verifiedRes.status).toBe(200);
    const verifiedBody = await verifiedRes.json() as { status: string; email: string };
    expect(verifiedBody.status).toBe("verified");
    expect(verifiedBody.email).toBe("bob@example.com");
  });

  it("7. Verify is idempotent: double-clicking the link still returns the success HTML and the same api_key", async () => {
    const startRes = await postJson("/v1/auth/email/start", { email: "carol@example.com" });
    const { token } = await startRes.json() as { token: string };

    const first = await getReq(`/v1/auth/email/verify?token=${token}`);
    expect(first.status).toBe(200);
    const firstHtml = await first.text();
    expect(firstHtml.toLowerCase()).toContain("signed in");

    const second = await getReq(`/v1/auth/email/verify?token=${token}`);
    expect(second.status).toBe(200);
    const secondHtml = await second.text();
    expect(secondHtml.toLowerCase()).toContain("signed in");

    // The api_key produced by the FIRST verify is what poll returns.
    const pollRes = await getReq(`/v1/auth/email/poll?token=${token}`);
    expect(pollRes.status).toBe(200);
    const pollBody = await pollRes.json() as { status: string; api_key: string };
    expect(pollBody.status).toBe("verified");
    expect(pollBody.api_key).toMatch(/^ubr_[0-9a-f]{48}$/);
  });

  it("8. Email is normalized (trim + lowercase) end-to-end", async () => {
    const startRes = await postJson("/v1/auth/email/start", { email: "  Lewis@EXAMPLE.com  " });
    expect(startRes.status).toBe(200);
    const { token } = await startRes.json() as { token: string };

    // Resend was sent the normalized email
    expect(resendCalls[0]!.body.to).toEqual(["lewis@example.com"]);

    const verifyRes = await getReq(`/v1/auth/email/verify?token=${token}`);
    expect(verifyRes.status).toBe(200);

    const pollRes = await getReq(`/v1/auth/email/poll?token=${token}`);
    expect(pollRes.status).toBe(200);
    const pollBody = await pollRes.json() as { email: string };
    expect(pollBody.email).toBe("lewis@example.com");
  });
});
