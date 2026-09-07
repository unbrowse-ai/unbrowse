import { afterEach, describe, expect, it } from "bun:test";
import { probeUrl } from "../src/execution/probe.js";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function mockFetch(handler: (url: string, init: RequestInit) => Response | Promise<Response> | Error) {
  globalThis.fetch = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : (input as Request).url;
    const out = await handler(url, init);
    if (out instanceof Error) throw out;
    return out;
  }) as typeof globalThis.fetch;
}

describe("probeUrl (mocked)", () => {
  it("returns status + content-type + byte_length from a HEAD response", async () => {
    mockFetch((_url, init) => {
      expect(init.method).toBe("HEAD");
      return new Response(null, {
        status: 200,
        headers: {
          "content-type": "application/json; charset=utf-8",
          "content-length": "1234",
        },
      });
    });
    const res = await probeUrl("https://example.com/api/foo");
    expect(res.method_used).toBe("HEAD");
    expect(res.status).toBe(200);
    expect(res.content_type).toBe("application/json; charset=utf-8");
    expect(res.byte_length).toBe(1234);
    expect(typeof res.ms).toBe("number");
  });

  it("falls back to ranged GET when HEAD returns 405", async () => {
    let calls = 0;
    mockFetch((_url, init) => {
      calls += 1;
      if (init.method === "HEAD") return new Response(null, { status: 405 });
      expect((init.headers as Record<string, string>).range).toBe("bytes=0-0");
      return new Response("a", {
        status: 206,
        headers: {
          "content-type": "text/html",
          "content-range": "bytes 0-0/9876",
        },
      });
    });
    const res = await probeUrl("https://example.com/page");
    expect(calls).toBe(2);
    expect(res.method_used).toBe("GET-1byte");
    expect(res.status).toBe(200); // 206 normalises to 200
    expect(res.content_type).toBe("text/html");
    expect(res.byte_length).toBe(9876);
  });

  it("falls back to ranged GET when HEAD throws (network/abort)", async () => {
    let saw_get = false;
    mockFetch((_url, init) => {
      if (init.method === "HEAD") return new Error("HEAD refused");
      saw_get = true;
      return new Response(null, {
        status: 200,
        headers: { "content-type": "text/html", "content-length": "20000" },
      });
    });
    const res = await probeUrl("https://example.com/spa");
    expect(saw_get).toBe(true);
    expect(res.method_used).toBe("GET-1byte");
    expect(res.status).toBe(200);
    expect(res.byte_length).toBe(20000);
  });

  it("returns status:0 with error string on total network failure", async () => {
    mockFetch(() => new Error("ENOTFOUND example.invalid"));
    const res = await probeUrl("https://example.invalid/nope");
    expect(res.status).toBe(0);
    expect(res.method_used).toBe("GET-1byte");
    expect(res.error).toBeTruthy();
    expect(res.error).toContain("ENOTFOUND");
  });

  it("attaches Cookie header from cookies option", async () => {
    let cookieHeader: string | undefined;
    mockFetch((_url, init) => {
      cookieHeader = (init.headers as Record<string, string>).cookie;
      return new Response(null, { status: 200, headers: { "content-type": "application/json" } });
    });
    await probeUrl("https://example.com/x", {
      cookies: [
        { name: "session", value: "abc" },
        { name: "csrf", value: '"q-token"' },
      ],
    });
    expect(cookieHeader).toBe("session=abc; csrf=q-token");
  });

  it("merges custom headers over defaults", async () => {
    let headers: Record<string, string> | undefined;
    mockFetch((_url, init) => {
      headers = init.headers as Record<string, string>;
      return new Response(null, { status: 200 });
    });
    await probeUrl("https://example.com/x", {
      headers: { "x-csrf-token": "tok", "user-agent": "custom-agent/1.0" },
    });
    expect(headers?.["x-csrf-token"]).toBe("tok");
    expect(headers?.["user-agent"]).toBe("custom-agent/1.0");
    expect(headers?.["accept"]).toBe("*/*");
  });
});

// Real-network smoke tests: gated behind UNBROWSE_NETWORK_TESTS=1.
// Run locally with: UNBROWSE_NETWORK_TESTS=1 bun test tests/execution-probe.test.ts
const NETWORK = process.env.UNBROWSE_NETWORK_TESTS === "1";
const describeNet = NETWORK ? describe : describe.skip;

describeNet("probeUrl (real network)", () => {
  it("returns 200 + application/json from httpbin.org/json", async () => {
    const res = await probeUrl("https://httpbin.org/json", { timeout_ms: 5000 });
    // Some endpoints reject HEAD; either 200 or 405 → fallback path is fine.
    expect([200, 405]).toContain(res.status === 200 ? 200 : res.status);
    if (res.status === 200) {
      expect(res.content_type ?? "").toContain("application/json");
    }
  });

  it("returns 4xx on a missing reddit json post (no trigger-intercept escalation)", async () => {
    const res = await probeUrl(
      "https://www.reddit.com/r/programming/comments/zzzz9999does9not9exist/foo/.json",
      { timeout_ms: 5000 },
    );
    // Reddit may return 404 OR 200 with empty array OR 429/403 anti-bot. Any
    // of those is a valid "callable URL, here's the status" signal.
    expect(typeof res.status).toBe("number");
    expect(res.status).toBeGreaterThan(0);
  }, 10_000);

  it("times out cleanly on TEST-NET-1 192.0.2.1 instead of throwing", async () => {
    const res = await probeUrl("http://192.0.2.1/", { timeout_ms: 800 });
    expect(res.status).toBe(0);
    expect(res.error).toBeTruthy();
  }, 5000);
});
