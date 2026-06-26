/**
 * Real-world integration test for Aiko Chat Fallback Routing.
 * NO MOCKS (CLAUDE.md "Never mock in tests").
 * Tests the real request-parsing, validation, and unreachable-network fallback
 * mechanisms of the Next.js POST handler by calling it directly.
 */
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { POST } from "../app/api/aiko-chat/route";

describe("Aiko Chat POST Route - Real-World Behavior", () => {
  let originalAikoUrl: string | undefined;
  let originalLocalUrl: string | undefined;

  beforeAll(() => {
    originalAikoUrl = process.env.AIKO_CHAT_URL;
    originalLocalUrl = process.env.LOCAL_AIKO_URL;
  });

  afterAll(() => {
    process.env.AIKO_CHAT_URL = originalAikoUrl;
    process.env.LOCAL_AIKO_URL = originalLocalUrl;
  });

  // ——— GOLDEN PATH & SCHEMA VALIDATIONS ———
  test("returns 400 Bad Request on invalid non-JSON body", async () => {
    const req = new Request("http://localhost/api/aiko-chat", {
      method: "POST",
      body: "not-json",
    });
    const res = await POST(req);
    expect(res.status).toBe(400);
    const data = await res.json() as { error?: string };
    expect(data.error).toBe("invalid JSON body");
  });

  test("returns 400 Bad Request on empty messages array", async () => {
    const req = new Request("http://localhost/api/aiko-chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ messages: [] }),
    });
    const res = await POST(req);
    expect(res.status).toBe(400);
    const data = await res.json() as { error?: string };
    expect(data.error).toBe("messages required");
  });

  // ——— ADVERSARIAL PAYLOAD ———
  test("gracefully rejects or ignores nested malformed message structure", async () => {
    const req = new Request("http://localhost/api/aiko-chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ messages: "should-be-array" }),
    });
    const res = await POST(req);
    expect(res.status).toBe(400);
  });

  // ——— DEGRADED REAL-WORLD FALLBACK ———
  test("handles complete network unreachable condition and gracefully returns 504", async () => {
    // Force invalid local socket addresses to guarantee immediate connection failure on host
    process.env.AIKO_CHAT_URL = "http://127.0.0.1:65530/invalid";
    process.env.LOCAL_AIKO_URL = "http://127.0.0.1:65531/invalid";

    const req = new Request("http://localhost/api/aiko-chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        messages: [{ role: "user", content: "ping" }],
      }),
    });

    const res = await POST(req);
    // Should fallback to local, both fail, resulting in a 504 Gateway Timeout / Unreachable
    expect(res.status).toBe(504);
    const data = await res.json() as { error?: string };
    expect(data.error).toContain("unreachable");
  });
});
