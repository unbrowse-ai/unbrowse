// Falsifiable signals for trySsrFastPathOnBlock (src/capture/ssr-fastpath.ts).
//
// Mocks the runBundleReplay boundary. The helper does NOT make real Kuri
// sandbox calls in unit tests — that's Step 6 e2e. The signals here cover:
//   - 2xx + html ≥1KB → returns SsrFastPathResult
//   - non-2xx → returns null (mirrors tryHttpFetch behavior)
//   - body <1KB → returns null
//   - resp.ok=false → returns null
//   - post_eval as string vs object — unwraps both
//   - timeout / runBundleReplay throws → returns null (caught)
//   - cookies pass through with domain default
//   - observed_routes returned verbatim
//   - input.url malformed → returns null without throwing

import { describe, it, expect, mock } from "bun:test";

// Mock the runBundleReplay module BEFORE importing the SUT.
const mockReplay = mock(async (_req: unknown) => ({
  ok: true,
  ms: 100,
  egress_bytes: 0,
  cookies: [],
  post_eval: JSON.stringify({ status: 200, body: "<html>" + "x".repeat(2000) + "</html>", final_url: "https://example.com/" }),
  routes_observed: [],
}));

mock.module("../src/sandbox/bundle-replay-client.js", () => ({
  runBundleReplay: mockReplay,
}));

import { trySsrFastPathOnBlock } from "../src/capture/ssr-fastpath";

describe("trySsrFastPathOnBlock", () => {
  it("returns html + status when sandbox returns 2xx + ≥1KB body", async () => {
    mockReplay.mockResolvedValueOnce({
      ok: true, ms: 50, egress_bytes: 0, cookies: [], routes_observed: [],
      post_eval: JSON.stringify({ status: 200, body: "<html>" + "x".repeat(2000) + "</html>", final_url: "https://glassdoor.com/Reviews/" }),
    } as any);
    const r = await trySsrFastPathOnBlock({ url: "https://glassdoor.com/Reviews/" });
    expect(r).not.toBeNull();
    expect(r!.status).toBe(200);
    expect(r!.html.length).toBeGreaterThan(1024);
    expect(r!.final_url).toBe("https://glassdoor.com/Reviews/");
  });

  it("returns null when status is 403 (vendor-blocked even via libcurl)", async () => {
    mockReplay.mockResolvedValueOnce({
      ok: true, ms: 50, egress_bytes: 0, cookies: [], routes_observed: [],
      post_eval: JSON.stringify({ status: 403, body: "<html>blocked</html>" + "x".repeat(2000), final_url: "https://x.com/" }),
    } as any);
    const r = await trySsrFastPathOnBlock({ url: "https://x.com/" });
    expect(r).toBeNull();
  });

  it("returns null when body is <1KB (likely empty / stub)", async () => {
    mockReplay.mockResolvedValueOnce({
      ok: true, ms: 50, egress_bytes: 0, cookies: [], routes_observed: [],
      post_eval: JSON.stringify({ status: 200, body: "<html>tiny</html>", final_url: "https://x.com/" }),
    } as any);
    const r = await trySsrFastPathOnBlock({ url: "https://x.com/" });
    expect(r).toBeNull();
  });

  it("returns null when resp.ok=false (sandbox itself failed)", async () => {
    mockReplay.mockResolvedValueOnce({
      ok: false, ms: 50, egress_bytes: 0, cookies: [], routes_observed: [],
    } as any);
    const r = await trySsrFastPathOnBlock({ url: "https://x.com/" });
    expect(r).toBeNull();
  });

  it("unwraps post_eval whether it's a JSON-string or already an object", async () => {
    // Object form (some sandbox runtimes parse before returning)
    mockReplay.mockResolvedValueOnce({
      ok: true, ms: 50, egress_bytes: 0, cookies: [], routes_observed: [],
      post_eval: { status: 200, body: "<html>" + "x".repeat(2000) + "</html>", final_url: "https://x.com/" },
    } as any);
    const r = await trySsrFastPathOnBlock({ url: "https://x.com/" });
    expect(r).not.toBeNull();
    expect(r!.status).toBe(200);
  });

  it("returns null when runBundleReplay throws (timeout / network)", async () => {
    mockReplay.mockImplementationOnce(async () => { throw new Error("timeout"); });
    const r = await trySsrFastPathOnBlock({ url: "https://x.com/" });
    expect(r).toBeNull();
  });

  it("propagates seedCookies through to the sandbox", async () => {
    let captured: any = null;
    mockReplay.mockImplementationOnce(async (req: any) => {
      captured = req;
      return {
        ok: true, ms: 50, egress_bytes: 0, cookies: [], routes_observed: [],
        post_eval: JSON.stringify({ status: 200, body: "<html>" + "x".repeat(2000) + "</html>", final_url: "https://x.com/" }),
      } as any;
    });
    await trySsrFastPathOnBlock({
      url: "https://x.com/",
      seedCookies: [{ name: "a", value: "b" }],
    });
    expect(captured?.seedCookies).toEqual([{ name: "a", value: "b" }]);
  });

  it("returns observed_routes verbatim from sandbox response", async () => {
    const routes = [
      { url: "https://x.com/api/foo", method: "GET", status: 200, final_url: "https://x.com/api/foo", content_type: "application/json", body_excerpt: "{}", body_size: 2, redirected: false },
    ];
    mockReplay.mockResolvedValueOnce({
      ok: true, ms: 50, egress_bytes: 0, cookies: [], routes_observed: routes,
      post_eval: JSON.stringify({ status: 200, body: "<html>" + "x".repeat(2000) + "</html>", final_url: "https://x.com/" }),
    } as any);
    const r = await trySsrFastPathOnBlock({ url: "https://x.com/" });
    expect(r!.observed_routes).toEqual(routes);
  });

  it("malformed url returns null without throwing", async () => {
    const r = await trySsrFastPathOnBlock({ url: "not a url" });
    expect(r).toBeNull();
  });

  it("default timeoutMs and fingerprint when not provided", async () => {
    let captured: any = null;
    mockReplay.mockImplementationOnce(async (req: any) => {
      captured = req;
      return {
        ok: true, ms: 50, egress_bytes: 0, cookies: [], routes_observed: [],
        post_eval: JSON.stringify({ status: 200, body: "<html>" + "x".repeat(2000) + "</html>", final_url: "https://x.com/" }),
      } as any;
    });
    await trySsrFastPathOnBlock({ url: "https://x.com/" });
    expect(captured?.timeoutMs).toBe(15000);
    expect(captured?.fingerprint).toBe("chrome_mac_arm");
    expect(captured?.impersonate).toBe("chrome131");
  });

  it("lost-sheep: post_eval is malformed JSON string → returns null (caught)", async () => {
    mockReplay.mockResolvedValueOnce({
      ok: true, ms: 50, egress_bytes: 0, cookies: [], routes_observed: [],
      post_eval: "{not json{",
    } as any);
    const r = await trySsrFastPathOnBlock({ url: "https://x.com/" });
    expect(r).toBeNull();
  });

  it("BundleReplayError thrown by sandbox (e.g. 404 from Kuri build without /v1/sandbox/replay) → null", async () => {
    // Real failure mode observed 2026-05-08: Kuri running on 6969 rejected
    // with HTTP 404 because that build did not expose /v1/sandbox/replay.
    // runBundleReplay surfaces a BundleReplayError; helper must catch + null.
    mockReplay.mockImplementationOnce(async () => {
      const err: any = new Error("sandbox replay failed: HTTP 404: not found");
      err.name = "BundleReplayError";
      err.status = 404;
      throw err;
    });
    const r = await trySsrFastPathOnBlock({ url: "https://x.com/" });
    expect(r).toBeNull();
  });
});
