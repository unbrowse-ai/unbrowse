// Regression test for the "raw fetch site bypassing the detector" gap.
//
// The 2026-05-18 rotation surfaced two raw fetches with `Authorization: Bearer`
// that did NOT route through `checkAuthInvalidResponse`:
//   1. lib/api.ts::updateAccountPreferences (PATCH /v1/account/preferences)
//   2. app/account/page.tsx::upgrade (POST /api/billing/checkout + direct
//      backend fallback)
// Both threw a generic HTTP error or swallowed the 401 silently, so the
// global AuthInvalidGlobalBanner never received the event.
//
// This test wires the REAL `updateAccountPreferences` against an HTTP-layer
// fetch interceptor (not a jest.mock of the wrapper itself) and asserts the
// `unbrowse:auth-invalid` event fires before the wrapper throws.
//
// Run: cd frontend && bun test tests/auth-invalid-wrapper-coverage.test.ts

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import {
  subscribeAuthInvalid,
  AUTH_INVALID_EVENT_NAME,
} from "../src/lib/auth-invalid-event";
import { updateAccountPreferences } from "../src/lib/api";

declare const globalThis: {
  window?: Window & typeof globalThis;
  fetch: typeof fetch;
  localStorage?: Storage;
};

function ensureWindow(): void {
  if (typeof globalThis.window === "undefined") {
    const target = new EventTarget();
    globalThis.window = {
      addEventListener: target.addEventListener.bind(target),
      removeEventListener: target.removeEventListener.bind(target),
      dispatchEvent: target.dispatchEvent.bind(target),
    } as unknown as Window & typeof globalThis;
  }
  if (typeof globalThis.localStorage === "undefined") {
    const store = new Map<string, string>();
    globalThis.localStorage = {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => store.set(k, v),
      removeItem: (k: string) => store.delete(k),
      clear: () => store.clear(),
      key: (i: number) => Array.from(store.keys())[i] ?? null,
      get length() {
        return store.size;
      },
    } as Storage;
  }
}

describe("updateAccountPreferences surfaces rotated-key recovery", () => {
  let originalFetch: typeof fetch;

  beforeEach(() => {
    ensureWindow();
    originalFetch = globalThis.fetch;
    // Seed a fake stored auth so the wrapper attaches a Bearer header
    // (the value does not matter, the interceptor returns 401 anyway).
    globalThis.localStorage!.setItem(
      "unbrowse_auth",
      JSON.stringify({ apiKey: "rotated-key-from-test" }),
    );
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    globalThis.localStorage?.removeItem("unbrowse_auth");
  });

  it("dispatches unbrowse:auth-invalid before throwing on 401 all_keys_rotated", async () => {
    let received: { message: string } | null = null;
    const unsubscribe = subscribeAuthInvalid((d) => {
      received = d;
    });

    // HTTP-layer interceptor returning the real rotation shape. The wrapper
    // is the SUT, not the interceptor: we observe its behavior on a real
    // Response object.
    globalThis.fetch = (async (
      input: RequestInfo | URL,
    ): Promise<Response> => {
      const url = typeof input === "string" ? input : input.toString();
      if (!url.includes("/v1/account/preferences")) {
        throw new Error(`unexpected fetch URL in test: ${url}`);
      }
      return new Response(
        JSON.stringify({
          error: "all_keys_rotated",
          message: "All API keys were rotated on 2026-05-18 for security.",
        }),
        { status: 401, headers: { "Content-Type": "application/json" } },
      );
    }) as typeof fetch;

    let threw: Error | null = null;
    try {
      await updateAccountPreferences({ share_pointers: true });
    } catch (err) {
      threw = err as Error;
    }
    unsubscribe();

    // The wrapper STILL throws (its non-2xx contract), but the event must
    // have fired first so the global banner can render the recovery CTA.
    expect(threw).not.toBeNull();
    expect(received).not.toBeNull();
    expect(received!.message).toContain("rotated");
  });

  it("does NOT dispatch on a normal 401 invalid-key response", async () => {
    let received: unknown = null;
    const unsubscribe = subscribeAuthInvalid((d) => {
      received = d;
    });

    globalThis.fetch = (async (): Promise<Response> => {
      return new Response(
        JSON.stringify({ error: "Invalid API key", code: "INVALID_KEY" }),
        { status: 401, headers: { "Content-Type": "application/json" } },
      );
    }) as typeof fetch;

    try {
      await updateAccountPreferences({ share_pointers: false });
    } catch {
      // expected throw
    }
    unsubscribe();
    expect(received).toBeNull();
  });
});

describe("event-name constant stays stable", () => {
  it("is unbrowse:auth-invalid (the global banner subscribes to this exact name)", () => {
    expect(AUTH_INVALID_EVENT_NAME).toBe("unbrowse:auth-invalid");
  });
});
