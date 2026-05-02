// E2E test for magicRegister CLI helper exercising the REAL Hono backend.
//
// Strategy:
//  - Boot the real backend Hono app from backend/src/index.ts in-process.
//  - Stub globalThis.fetch so:
//      * api.resend.com -> capture body, return 200 (so we can extract the
//        verify URL the user "would have clicked")
//      * api.emergentdb.com -> in-memory KV (mirrors auth-routes-magic-flow.test.ts)
//      * BACKEND_TEST_HOST -> route through app.fetch(req, env) into the real Hono app
//      * anything else -> original fetch
//  - Set UNBROWSE_BACKEND_URL=BACKEND_TEST_HOST BEFORE importing magicRegister
//    (API_URL in src/client/index.ts is captured at module load).
//
// The "user click" is simulated by parsing the verify URL out of the captured
// Resend HTML body and firing a GET against it on the next macrotask, so the
// magicRegister polling loop sees `verified` shortly after.

import { afterEach, beforeEach, describe, expect, it } from "bun:test";

const BACKEND_TEST_HOST = "http://localhost-test";

// IMPORTANT: set env BEFORE importing the client module — API_URL is captured
// at module load time.
process.env.UNBROWSE_BACKEND_URL = BACKEND_TEST_HOST;
process.env.UNBROWSE_LOCAL_ONLY = "0";
process.env.UNBROWSE_NON_INTERACTIVE = "1";

const { app } = await import("../backend/src/index.js");
const { clearKVCacheForTests } = await import("../backend/src/services/kv.js");
const clientMod: any = await import("../src/client/index.js");

interface ResendCall { url: string; body: any; auth: string | null }

const baseEnv: any = {
  API_KEY: "admin",
  EMERGENTDB_API_KEY: "test",
  NEBIUS_API_KEY: "nebius",
  STATS_KV: {} as any,
  ENVIRONMENT: "staging",
  TURBOBOX_URL: "http://turbobox.local",
  R2_BUCKET: {} as any,
  FAL_KEY: "fal",
  RESEND_API_KEY: "re_test",
  RESEND_FROM: "Unbrowse <auth@auth.unbrowse.ai>",
  PUBLIC_API_URL: BACKEND_TEST_HOST,
};

let originalFetch: typeof fetch;
let resendCalls: ResendCall[];
let kvStore: Map<string, string>;
let currentEnv: any;

function makeFetch(store: Map<string, string>, calls: ResendCall[], envRef: { value: any }): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const urlStr = typeof input === "string"
      ? input
      : input instanceof URL ? input.toString() : (input as Request).url;

    // Route backend-host calls into the real Hono app.
    if (urlStr.startsWith(BACKEND_TEST_HOST)) {
      const req = new Request(urlStr, init as any);
      return app.fetch(req, envRef.value);
    }

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

    return originalFetch(input as any, init);
  }) as typeof fetch;
}

const envRef: { value: any } = { value: baseEnv };

beforeEach(() => {
  originalFetch = globalThis.fetch;
  kvStore = new Map();
  resendCalls = [];
  currentEnv = { ...baseEnv };
  envRef.value = currentEnv;
  globalThis.fetch = makeFetch(kvStore, resendCalls, envRef);
  clearKVCacheForTests();
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  clearKVCacheForTests();
});

// Extract verify URL from a Resend email html body.
function extractVerifyUrl(html: string): string {
  // Look for an http(s) URL containing /v1/auth/email/verify?token=
  const m = html.match(/https?:\/\/[^\s"'<>]+\/v1\/auth\/email\/verify\?token=[0-9a-f]{32}/i);
  if (!m) throw new Error(`No verify URL in email body: ${html.slice(0, 400)}`);
  return m[0];
}

// Poll resendCalls until at least one shows up, then "click" the verify URL.
async function clickWhenEmailArrives(): Promise<string> {
  for (let i = 0; i < 200; i++) {
    if (resendCalls.length > 0) {
      const url = extractVerifyUrl(String(resendCalls[0]!.body.html ?? ""));
      // Hit the verify endpoint via the same routed fetch (will dispatch into app).
      const res = await globalThis.fetch(url);
      // Discard body; we only care that the side effect ran.
      await res.text();
      return url;
    }
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error("Resend email never arrived — magicRegister did not call /start");
}

const magicRegister = clientMod.magicRegister as
  | ((opts: {
      email: string;
      openBrowser?: (verifyUrl: string) => void | Promise<void>;
      timeoutMs?: number;
      pollMs?: number;
      returnUrl?: string;
    }) => Promise<{ api_key: string; agent_id: string; email: string; user_id: string }>)
  | undefined;

const HAS_HELPER = typeof magicRegister === "function";
const maybe = (HAS_HELPER ? it : it.skip);

describe("magicRegister CLI helper end-to-end against real backend", () => {
  maybe("1. happy path: /start -> simulated click -> poll returns api_key + agent_id + email + user_id", async () => {
    const opened: string[] = [];
    const [result] = await Promise.all([
      magicRegister!({
        email: "lewis@example.com",
        openBrowser: (u) => { opened.push(u); },
        timeoutMs: 5000,
        pollMs: 50,
      }),
      clickWhenEmailArrives(),
    ]);

    expect(result.api_key).toMatch(/^ubr_[0-9a-f]{48}$/);
    expect(result.agent_id).toMatch(/^[0-9a-f]{24}$/);
    expect(result.email).toBe("lewis@example.com");
    expect(result.user_id).toMatch(/^[0-9a-f]{24}$/);
    // Resend was called exactly once for /start
    expect(resendCalls.length).toBe(1);
    // openBrowser was invoked exactly once
    expect(opened.length).toBe(1);
  });

  maybe("2. openBrowser receives a verify URL with /v1/auth/email/verify?token=<32hex>", async () => {
    const opened: string[] = [];
    await Promise.all([
      magicRegister!({
        email: "alice@example.com",
        openBrowser: (u) => { opened.push(u); },
        timeoutMs: 5000,
        pollMs: 50,
      }),
      clickWhenEmailArrives(),
    ]);
    expect(opened.length).toBe(1);
    expect(opened[0]).toMatch(/\/v1\/auth\/email\/verify\?token=[0-9a-f]{32}/);
  });

  maybe("3. email is normalized end-to-end (whitespace + case)", async () => {
    const [result] = await Promise.all([
      magicRegister!({
        email: "  Lewis@EXAMPLE.com  ",
        openBrowser: () => {},
        timeoutMs: 5000,
        pollMs: 50,
      }),
      clickWhenEmailArrives(),
    ]);
    expect(result.email).toBe("lewis@example.com");
    expect(resendCalls[0]!.body.to).toEqual(["lewis@example.com"]);
  });

  maybe("4. backend without RESEND_API_KEY -> magicRegister throws and Resend is not called", async () => {
    const envNoResend = { ...baseEnv };
    delete envNoResend.RESEND_API_KEY;
    envRef.value = envNoResend;

    let caught: unknown = null;
    try {
      await magicRegister!({
        email: "bob@example.com",
        openBrowser: () => {},
        timeoutMs: 1500,
        pollMs: 50,
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).not.toBeNull();
    const msg = String((caught as Error)?.message ?? caught).toLowerCase();
    expect(
      msg.includes("resend")
        || msg.includes("magic")
        || msg.includes("anon")
        || msg.includes("email_not_configured")
        || msg.includes("not configured"),
    ).toBe(true);
    expect(resendCalls.length).toBe(0);
  });

  maybe("5. magic link never clicked -> magicRegister times out", async () => {
    let caught: unknown = null;
    try {
      await magicRegister!({
        email: "carol@example.com",
        openBrowser: () => {}, // never click
        timeoutMs: 500,
        pollMs: 100,
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).not.toBeNull();
    const msg = String((caught as Error)?.message ?? caught).toLowerCase();
    expect(
      msg.includes("timeout")
        || msg.includes("timed out")
        || msg.includes("expired")
        || msg.includes("pending"),
    ).toBe(true);
    // /start fired exactly once
    expect(resendCalls.length).toBe(1);
  });

  maybe("6. second registration with same email reuses user_id but mints a fresh api_key", async () => {
    const [first] = await Promise.all([
      magicRegister!({
        email: "dave@example.com",
        openBrowser: () => {},
        timeoutMs: 5000,
        pollMs: 50,
      }),
      clickWhenEmailArrives(),
    ]);

    // Reset capture but keep the same KV store so the user record persists.
    resendCalls = [];
    globalThis.fetch = makeFetch(kvStore, resendCalls, envRef);

    const [second] = await Promise.all([
      magicRegister!({
        email: "dave@example.com",
        openBrowser: () => {},
        timeoutMs: 5000,
        pollMs: 50,
      }),
      clickWhenEmailArrives(),
    ]);

    expect(second.user_id).toBe(first.user_id);
    expect(second.api_key).not.toBe(first.api_key);
    expect(second.api_key).toMatch(/^ubr_[0-9a-f]{48}$/);
  });
});
