// No-mock unit test for the centralized auth-invalid detector + dispatch.
// Exercises real CustomEvent / window in jsdom, real subscribeAuthInvalid wiring,
// and the real body-shape detection for `all_keys_rotated`. No fetch mock - we
// construct real Response objects.
//
// Run: cd frontend && npx jest tests/auth-invalid-event.test.ts
//      OR  bun test frontend/tests/auth-invalid-event.test.ts
// The frontend has no configured jest yet, so this file is also runnable via
// `bun test` from the repo root.

import {
  detectAuthInvalidFromBody,
  dispatchAuthInvalid,
  subscribeAuthInvalid,
  checkAuthInvalidResponse,
  AUTH_INVALID_EVENT_NAME,
} from "../src/lib/auth-invalid-event";

import { describe, it, expect, beforeEach } from "bun:test";

declare const globalThis: {
  window?: Window & typeof globalThis;
  CustomEvent?: typeof CustomEvent;
};

function ensureWindow(): void {
  if (typeof globalThis.window !== "undefined") return;
  // Minimal window shim with EventTarget so dispatch + subscribe work without jsdom.
  const target = new EventTarget();
  const win = {
    addEventListener: target.addEventListener.bind(target),
    removeEventListener: target.removeEventListener.bind(target),
    dispatchEvent: target.dispatchEvent.bind(target),
  } as unknown as Window & typeof globalThis;
  globalThis.window = win;
}

describe("detectAuthInvalidFromBody", () => {
  it("returns detail when error code is all_keys_rotated", () => {
    const hit = detectAuthInvalidFromBody(401, {
      error: "all_keys_rotated",
      message: "All API keys were rotated on 2026-05-18 for security.",
      rotation_url: "https://unbrowse.ai/login",
    });
    expect(hit).not.toBeNull();
    expect(hit?.message).toContain("rotated");
    expect(hit?.rotation_url).toBe("https://unbrowse.ai/login");
  });

  it("returns null when status is not 401", () => {
    const hit = detectAuthInvalidFromBody(403, {
      error: "all_keys_rotated",
    });
    expect(hit).toBeNull();
  });

  it("returns null for generic 401 (invalid key, not rotation)", () => {
    const hit = detectAuthInvalidFromBody(401, {
      error: "Invalid API key",
      code: "INVALID_KEY",
    });
    expect(hit).toBeNull();
  });

  it("matches via code field when error is missing", () => {
    const hit = detectAuthInvalidFromBody(401, {
      code: "key_rotated",
      message: "rotated",
    });
    expect(hit).not.toBeNull();
  });

  it("matches via message substring", () => {
    const hit = detectAuthInvalidFromBody(401, {
      error: "Unauthorized",
      message: "All keys revoked - please sign in again.",
    });
    expect(hit).not.toBeNull();
  });

  it("returns null for null/undefined body", () => {
    expect(detectAuthInvalidFromBody(401, null)).toBeNull();
    expect(detectAuthInvalidFromBody(401, undefined)).toBeNull();
  });
});

describe("subscribeAuthInvalid + dispatchAuthInvalid", () => {
  beforeEach(() => {
    ensureWindow();
  });

  it("fires the subscribed handler with the detail", () => {
    let received: { message: string } | null = null;
    const unsubscribe = subscribeAuthInvalid((d) => {
      received = d;
    });
    dispatchAuthInvalid({ message: "key rotated", rotation_url: "https://x/y" });
    unsubscribe();
    expect(received).not.toBeNull();
    expect(received!.message).toBe("key rotated");
  });

  it("unsubscribe stops further dispatches", () => {
    let count = 0;
    const unsubscribe = subscribeAuthInvalid(() => {
      count += 1;
    });
    dispatchAuthInvalid({ message: "one" });
    unsubscribe();
    dispatchAuthInvalid({ message: "two" });
    expect(count).toBe(1);
  });
});

describe("checkAuthInvalidResponse", () => {
  beforeEach(() => {
    ensureWindow();
  });

  it("returns true and fires event when body matches rotation shape", async () => {
    let received: { message: string } | null = null;
    const unsubscribe = subscribeAuthInvalid((d) => {
      received = d;
    });
    const res = new Response(
      JSON.stringify({
        error: "all_keys_rotated",
        message: "All API keys were rotated on 2026-05-18 for security.",
      }),
      { status: 401, headers: { "Content-Type": "application/json" } },
    );
    const hit = await checkAuthInvalidResponse(res);
    unsubscribe();
    expect(hit).toBe(true);
    expect(received).not.toBeNull();
  });

  it("returns false for normal 401 invalid-key response", async () => {
    let received: unknown = null;
    const unsubscribe = subscribeAuthInvalid((d) => {
      received = d;
    });
    const res = new Response(
      JSON.stringify({ error: "Invalid API key", code: "INVALID_KEY" }),
      { status: 401, headers: { "Content-Type": "application/json" } },
    );
    const hit = await checkAuthInvalidResponse(res);
    unsubscribe();
    expect(hit).toBe(false);
    expect(received).toBeNull();
  });

  it("does not consume the response body (clone is used)", async () => {
    const res = new Response(
      JSON.stringify({ error: "all_keys_rotated", message: "rotated" }),
      { status: 401, headers: { "Content-Type": "application/json" } },
    );
    await checkAuthInvalidResponse(res);
    // Caller should still be able to read body.
    const body = await res.json();
    expect((body as { error: string }).error).toBe("all_keys_rotated");
  });
});

describe("AUTH_INVALID_EVENT_NAME export", () => {
  it("is the unbrowse:auth-invalid event name", () => {
    expect(AUTH_INVALID_EVENT_NAME).toBe("unbrowse:auth-invalid");
  });
});
