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

// Regression: SSR sites like lobste.rs serve a small `content-length` on HEAD
// when the request advertises `accept-encoding: gzip` (default for bun fetch).
// The Content-Length reflects the compressed transfer size, so decideFromProbe
// mistakes a 57KB SSR page for a tiny SPA shell and routes resolve through
// trigger-intercept/browser instead of fast SSR fetch + extract.
//
// Fix: request `accept-encoding: identity` on the probe so Content-Length
// reflects the decoded body size. Verified live against lobste.rs:
//   accept-encoding: gzip      -> content-length: 20
//   accept-encoding: identity  -> content-length: 57676
describe("probeUrl content-encoding handling", () => {
  it("sends accept-encoding: identity so SSR Content-Length is decoded bytes", async () => {
    let sawAcceptEncoding: string | undefined;
    mockFetch((_url, init) => {
      const headers = (init.headers as Record<string, string>) || {};
      sawAcceptEncoding = headers["accept-encoding"];
      return new Response(null, {
        status: 200,
        headers: {
          "content-type": "text/html; charset=utf-8",
          "content-length": "57676",
        },
      });
    });
    const res = await probeUrl("https://lobste.rs/");
    expect(sawAcceptEncoding).toBe("identity");
    expect(res.byte_length).toBe(57676);
    expect(res.method_used).toBe("HEAD");
  });

  it("ranged GET fallback also sends accept-encoding: identity", async () => {
    let headEncoding: string | undefined;
    let getEncoding: string | undefined;
    mockFetch((_url, init) => {
      const headers = (init.headers as Record<string, string>) || {};
      if (init.method === "HEAD") {
        headEncoding = headers["accept-encoding"];
        return new Response(null, { status: 405 });
      }
      getEncoding = headers["accept-encoding"];
      return new Response("<", {
        status: 206,
        headers: {
          "content-type": "text/html",
          "content-range": "bytes 0-0/57676",
        },
      });
    });
    const res = await probeUrl("https://lobste.rs/");
    expect(headEncoding).toBe("identity");
    expect(getEncoding).toBe("identity");
    expect(res.method_used).toBe("GET-1byte");
    expect(res.byte_length).toBe(57676);
  });

  it("opts.headers can still override accept-encoding when a caller needs compression", async () => {
    let sawAcceptEncoding: string | undefined;
    mockFetch((_url, init) => {
      const headers = (init.headers as Record<string, string>) || {};
      sawAcceptEncoding = headers["accept-encoding"];
      return new Response(null, {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    await probeUrl("https://example.com/x", {
      headers: { "accept-encoding": "gzip, deflate" },
    });
    expect(sawAcceptEncoding).toBe("gzip, deflate");
  });
});
