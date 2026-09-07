// Contract test for backend/src/services/email.ts (sendMagicLink).
// The only network boundary stub is globalThis.fetch (Resend's HTTP API).
// No internal SUT modules are mocked.

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { sendMagicLink, EmailNotConfiguredError } from "../backend/src/services/email.js";

let originalFetch: typeof fetch;
let calls: Array<{ url: string; init: RequestInit }> = [];
let nextResponse: { status: number; body: unknown };

beforeEach(() => {
  originalFetch = globalThis.fetch;
  calls = [];
  nextResponse = { status: 200, body: { id: "stub-id" } };
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    return new Response(JSON.stringify(nextResponse.body), {
      status: nextResponse.status,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

const baseEnv = (overrides: Record<string, unknown> = {}) =>
  ({
    RESEND_API_KEY: "re_test_key",
    RESEND_FROM: "Unbrowse <auth@auth.unbrowse.ai>",
    PUBLIC_API_URL: "https://beta-api.unbrowse.ai",
    ...overrides,
  }) as any;

const parseBody = (init: RequestInit): any =>
  JSON.parse(typeof init.body === "string" ? init.body : String(init.body));

const headerValue = (init: RequestInit, name: string): string | undefined => {
  const h = init.headers as Record<string, string> | undefined;
  if (!h) return undefined;
  for (const k of Object.keys(h)) {
    if (k.toLowerCase() === name.toLowerCase()) return h[k];
  }
  return undefined;
};

describe("sendMagicLink contract", () => {
  it("throws EmailNotConfiguredError when RESEND_API_KEY missing", async () => {
    const env = baseEnv({ RESEND_API_KEY: undefined });
    await expect(
      sendMagicLink(env, { email: "lewis@example.com", token: "tok123" })
    ).rejects.toBeInstanceOf(EmailNotConfiguredError);
    expect(calls.length).toBe(0);
  });

  it("POSTs to https://api.resend.com/emails with correct headers", async () => {
    await sendMagicLink(baseEnv(), { email: "lewis@example.com", token: "tok123" });
    expect(calls.length).toBe(1);
    expect(calls[0].url).toBe("https://api.resend.com/emails");
    expect(calls[0].init.method).toBe("POST");
    expect(headerValue(calls[0].init, "Authorization")).toBe("Bearer re_test_key");
    expect(headerValue(calls[0].init, "Content-Type")).toBe("application/json");
  });

  it("body includes the verify URL with token in query string (html + text)", async () => {
    await sendMagicLink(baseEnv(), { email: "lewis@example.com", token: "tok123" });
    const body = parseBody(calls[0].init);
    expect(body.from).toBeTruthy();
    expect(body.to).toEqual(["lewis@example.com"]);
    expect(body.subject).toBe("Sign in to Unbrowse");
    expect(typeof body.html).toBe("string");
    expect(body.html.length).toBeGreaterThan(0);
    expect(typeof body.text).toBe("string");
    expect(body.text.length).toBeGreaterThan(0);
    const verifyUrl = "https://beta-api.unbrowse.ai/v1/auth/email/verify?token=tok123";
    expect(body.html).toContain(verifyUrl);
    expect(body.text).toContain(verifyUrl);
  });

  it("encodes return_url when provided", async () => {
    await sendMagicLink(baseEnv(), {
      email: "lewis@example.com",
      token: "tok123",
      returnUrl: "https://app.unbrowse.ai/welcome?next=hi",
    });
    const body = parseBody(calls[0].init);
    const encoded = "return_url=https%3A%2F%2Fapp.unbrowse.ai%2Fwelcome%3Fnext%3Dhi";
    expect(body.html).toContain(encoded);
    expect(body.text).toContain(encoded);
  });

  it("falls back to a default sender when RESEND_FROM unset", async () => {
    const env = baseEnv({ RESEND_FROM: undefined });
    await sendMagicLink(env, { email: "lewis@example.com", token: "tok123" });
    const body = parseBody(calls[0].init);
    expect(typeof body.from).toBe("string");
    expect(body.from.length).toBeGreaterThan(0);
    expect(body.from).toContain("@");
  });

  it("falls back to https://beta-api.unbrowse.ai when PUBLIC_API_URL unset", async () => {
    const env = baseEnv({ PUBLIC_API_URL: undefined });
    await sendMagicLink(env, { email: "lewis@example.com", token: "tok123" });
    const body = parseBody(calls[0].init);
    const fallbackPrefix = "https://beta-api.unbrowse.ai/v1/auth/email/verify";
    expect(body.html).toContain(fallbackPrefix);
    expect(body.text).toContain(fallbackPrefix);
  });

  it("throws on Resend non-2xx with status and body in the message", async () => {
    nextResponse = {
      status: 422,
      body: { name: "validation_error", message: "domain not verified" },
    };
    await expect(
      sendMagicLink(baseEnv(), { email: "lewis@example.com", token: "tok123" })
    ).rejects.toThrow(/resend.*422/);
  });
});
