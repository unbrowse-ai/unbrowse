// Falsifier for plan-v10 Phase A unbrowse-side wire-up — confirms the
// `proxy` field threads through SandboxReplayRequest → runBundleReplay
// → JSON request body.
//
// Pairs with tests/kuri-proxy-patch-shape.test.sh (Kuri-side guard).

import { describe, it, expect, mock } from "bun:test";

describe("proxy passthrough into runBundleReplay request body", () => {
  it("emits `proxy` field when SandboxReplayRequest.proxy is set", async () => {
    const { runBundleReplay } = await import(`../src/sandbox/bundle-replay-client.ts?proxy=${Date.now()}-${Math.random()}`);
    let captured: { url?: string; body?: string } = {};
    const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
      captured.url = String(url);
      captured.body = init?.body as string;
      return new Response(
        JSON.stringify({ ok: true, status: 200, ms: 1, egress_bytes: 0, cookies: [], routes_observed: [] }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as typeof fetch;

    await runBundleReplay({
      targetOrigin: "https://example.com",
      targetHref: "https://example.com/",
      bundleSource: "void 0",
      proxy: "http://user:pass@geo.iproyal.com:12321",
    }, { kuriBase: "http://127.0.0.1:9999", fetchImpl });

    expect(captured.url).toBe("http://127.0.0.1:9999/v1/sandbox/replay");
    const parsed = JSON.parse(captured.body!);
    expect(parsed.proxy).toBe("http://user:pass@geo.iproyal.com:12321");
  });

  it("omits `proxy` field when SandboxReplayRequest.proxy is undefined", async () => {
    const { runBundleReplay } = await import(`../src/sandbox/bundle-replay-client.ts?proxy=${Date.now()}-${Math.random()}`);
    let captured: { body?: string } = {};
    const fetchImpl = (async (_url: string | URL | Request, init?: RequestInit) => {
      captured.body = init?.body as string;
      return new Response(
        JSON.stringify({ ok: true, status: 200, ms: 1, egress_bytes: 0, cookies: [], routes_observed: [] }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as typeof fetch;

    await runBundleReplay({
      targetOrigin: "https://example.com",
      bundleSource: "void 0",
    }, { kuriBase: "http://127.0.0.1:9999", fetchImpl });

    const parsed = JSON.parse(captured.body!);
    expect(parsed.proxy).toBeUndefined();
  });

  it("forwards proxy through trySsrFastPathOnBlock (3rd-call-site verified)", async () => {
    let replayProxy: string | undefined;
    mock.module("../src/sandbox/bundle-replay-client.js", () => ({
      runBundleReplay: async (req: unknown) => {
        const request = req as { proxy?: string };
        replayProxy = request.proxy;
        return {
          ok: true,
          status: 200,
          ms: 1,
          egress_bytes: 0,
          cookies: [],
          routes_observed: [],
          post_eval: JSON.stringify({
            status: 200,
            body: "<html>x</html>" + "x".repeat(2000),
            final_url: "https://example.com/",
          }),
          _proxy_seen: request.proxy,
        };
      },
    }));

    const { trySsrFastPathOnBlock } = await import(`../src/capture/ssr-fastpath.ts?proxy=${Date.now()}-${Math.random()}`);
    await trySsrFastPathOnBlock({
      url: "https://example.com/",
      proxy: "http://up:pp@geo.iproyal.com:12321",
      kuriBase: "http://127.0.0.1:9999",
    });
    expect(replayProxy).toBe("http://up:pp@geo.iproyal.com:12321");
  });
});
