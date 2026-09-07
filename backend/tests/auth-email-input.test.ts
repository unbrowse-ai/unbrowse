import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { app } from "../src/index.js";
import type { Env } from "../src/types.js";
import { clearKVCacheForTests } from "../src/services/kv.js";

// Adversarial test for the email-input surface of /v1/auth/email/start.
// Real Hono app, real accounts/keys/KV; only network boundary (Resend +
// EmergentDB qdkv) is intercepted via globalThis.fetch — same scaffold as
// auth-routes-magic-flow.test.ts. NEVER mock internal SUT.

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

describe("/v1/auth/email/start adversarial input surface", () => {
  it("1. header injection via newline in email is rejected (or stripped)", async () => {
    const res = await postJson("/v1/auth/email/start", {
      email: "a@b.com\r\nBcc: attacker@evil.com",
    });
    // Either reject with 400, or accept after sanitizing — but Resend body MUST NOT carry the injection.
    if (res.status === 400) {
      expect(resendCalls.length).toBe(0);
    } else {
      expect(res.status).toBe(200);
      expect(resendCalls.length).toBe(1);
      const serialized = JSON.stringify(resendCalls[0]!.body);
      expect(serialized).not.toContain("attacker@evil.com");
      expect(serialized).not.toContain("\\r\\nBcc");
      expect(serialized).not.toContain("\r\nBcc");
    }
  });

  it("2. plus-aliasing preserved end-to-end", async () => {
    const startRes = await postJson("/v1/auth/email/start", { email: "lewis+unbrowse@gmail.com" });
    expect(startRes.status).toBe(200);
    const { token } = await startRes.json() as { token: string };
    expect(resendCalls[0]!.body.to).toEqual(["lewis+unbrowse@gmail.com"]);

    const verifyRes = await getReq(`/v1/auth/email/verify?token=${token}`);
    expect(verifyRes.status).toBe(200);

    const pollRes = await getReq(`/v1/auth/email/poll?token=${token}`);
    expect(pollRes.status).toBe(200);
    const pollBody = await pollRes.json() as { email: string };
    expect(pollBody.email).toBe("lewis+unbrowse@gmail.com");
  });

  it("3. dot-aliasing preserved (string equality, not Gmail dot-equivalence)", async () => {
    const r1 = await postJson("/v1/auth/email/start", { email: "l.e.w.i.s@gmail.com" });
    expect(r1.status).toBe(200);
    const r2 = await postJson("/v1/auth/email/start", { email: "lewis@gmail.com" });
    expect(r2.status).toBe(200);

    // Verify both so the acct: rows actually get written
    const { token: t1 } = await r1.clone().json() as { token: string };
    const { token: t2 } = await r2.clone().json() as { token: string };
    expect((await getReq(`/v1/auth/email/verify?token=${t1}`)).status).toBe(200);
    expect((await getReq(`/v1/auth/email/verify?token=${t2}`)).status).toBe(200);

    // Two distinct acct: rows in KV (namespaced as <ns>:acct:<email>)
    const acctKeys = Array.from(kvStore.keys()).filter((k) => k.includes(":acct:"));
    expect(acctKeys.some((k) => k.endsWith(":acct:l.e.w.i.s@gmail.com"))).toBe(true);
    expect(acctKeys.some((k) => k.endsWith(":acct:lewis@gmail.com"))).toBe(true);
  });

  it("4. empty / whitespace-only / missing email rejected with 400 invalid_email", async () => {
    for (const body of [{ email: "" }, { email: "   " }, {}]) {
      resendCalls.length = 0;
      const res = await postJson("/v1/auth/email/start", body);
      expect(res.status).toBe(400);
      const j = await res.json() as { error: string };
      expect(j.error).toBe("invalid_email");
      expect(resendCalls.length).toBe(0);
    }
  });

  it("5. malformed @-only / missing-@ emails rejected with 400", async () => {
    for (const email of ["@", "a@", "@b", "ab"]) {
      resendCalls.length = 0;
      const res = await postJson("/v1/auth/email/start", { email });
      expect(res.status).toBe(400);
      expect(resendCalls.length).toBe(0);
    }
  });

  it("6. very long email is rejected (400), not 500", async () => {
    const longEmail = "a".repeat(5000) + "@b.com";
    const res = await postJson("/v1/auth/email/start", { email: longEmail });
    // Must NOT 500. Prefer 400 with a length cap.
    expect(res.status).not.toBe(500);
    expect(res.status).toBe(400);
    expect(resendCalls.length).toBe(0);
  });

  it("7. unicode local part does not crash (200 or 400, never 500)", async () => {
    const res = await postJson("/v1/auth/email/start", { email: "lëwis@example.com" });
    expect(res.status).not.toBe(500);
    expect([200, 400]).toContain(res.status);
  });

  it("8. IDN domain does not crash (200 or 400, never 500)", async () => {
    const res = await postJson("/v1/auth/email/start", { email: "lewis@münchen.de" });
    expect(res.status).not.toBe(500);
    expect([200, 400]).toContain(res.status);
  });

  it("9. capitalization normalized end-to-end", async () => {
    const startRes = await postJson("/v1/auth/email/start", { email: "Lewis@EXAMPLE.com" });
    expect(startRes.status).toBe(200);
    const { token } = await startRes.json() as { token: string };
    expect(resendCalls[0]!.body.to).toEqual(["lewis@example.com"]);

    const verifyRes = await getReq(`/v1/auth/email/verify?token=${token}`);
    expect(verifyRes.status).toBe(200);
    expect(Array.from(kvStore.keys()).some((k) => k.endsWith(":acct:lewis@example.com"))).toBe(true);

    const pollRes = await getReq(`/v1/auth/email/poll?token=${token}`);
    const pollBody = await pollRes.json() as { email: string };
    expect(pollBody.email).toBe("lewis@example.com");
  });

  it("10. whitespace-padded email trimmed before storage and Resend send", async () => {
    const startRes = await postJson("/v1/auth/email/start", { email: "   lewis@example.com   " });
    expect(startRes.status).toBe(200);
    const { token } = await startRes.json() as { token: string };
    expect(resendCalls[0]!.body.to).toEqual(["lewis@example.com"]);

    const verifyRes = await getReq(`/v1/auth/email/verify?token=${token}`);
    expect(verifyRes.status).toBe(200);
    expect(Array.from(kvStore.keys()).some((k) => k.endsWith(":acct:lewis@example.com"))).toBe(true);

    const pollRes = await getReq(`/v1/auth/email/poll?token=${token}`);
    const pollBody = await pollRes.json() as { email: string };
    expect(pollBody.email).toBe("lewis@example.com");
  });
});
