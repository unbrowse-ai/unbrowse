// Falsifier for plan-v10 Phase A unbrowse-side wire-up — confirms the
// `proxy` field threads through SandboxReplayRequest → runBundleReplay
// → JSON request body.
//
// Pairs with tests/kuri-proxy-patch-shape.test.sh (Kuri-side guard).

import { describe, it, expect } from "bun:test";
import { runBundleReplay } from "../src/sandbox/bundle-replay-client";

describe("proxy passthrough into runBundleReplay request body", () => {
  it("emits `proxy` field when SandboxReplayRequest.proxy is set", async () => {
    let captured: { url?: string; body?: string } = {};
    const origFetch = globalThis.fetch;
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      captured.url = String(url);
      captured.body = init?.body as string;
      return new Response(
        JSON.stringify({ ok: true, status: 200, ms: 1, egress_bytes: 0, cookies: [], routes_observed: [] }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as typeof fetch;

    try {
      await runBundleReplay({
        targetOrigin: "https://example.com",
        targetHref: "https://example.com/",
        bundleSource: "void 0",
        proxy: "http://user:pass@geo.iproyal.com:12321",
      }, { kuriBase: "http://127.0.0.1:9999" });
    } finally {
      globalThis.fetch = origFetch;
    }

    expect(captured.url).toBe("http://127.0.0.1:9999/v1/sandbox/replay");
    const parsed = JSON.parse(captured.body!);
    expect(parsed.proxy).toBe("http://user:pass@geo.iproyal.com:12321");
  });

  it("omits `proxy` field when SandboxReplayRequest.proxy is undefined", async () => {
    let captured: { body?: string } = {};
    const origFetch = globalThis.fetch;
    globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
      captured.body = init?.body as string;
      return new Response(
        JSON.stringify({ ok: true, status: 200, ms: 1, egress_bytes: 0, cookies: [], routes_observed: [] }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as typeof fetch;

    try {
      await runBundleReplay({
        targetOrigin: "https://example.com",
        bundleSource: "void 0",
      }, { kuriBase: "http://127.0.0.1:9999" });
    } finally {
      globalThis.fetch = origFetch;
    }

    const parsed = JSON.parse(captured.body!);
    expect(parsed.proxy).toBeUndefined();
  });

  it("forwards proxy through trySsrFastPathOnBlock (3rd-call-site verified)", async () => {
    let captured: { body?: string } = {};
    const origFetch = globalThis.fetch;
    globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
      captured.body = init?.body as string;
      return new Response(
        JSON.stringify({ ok: true, status: 200, ms: 1, egress_bytes: 0, cookies: [], routes_observed: [], post_eval: JSON.stringify({ status: 200, body: "<html>x</html>" + "x".repeat(2000) }) }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as typeof fetch;

    const { trySsrFastPathOnBlock } = await import("../src/capture/ssr-fastpath");
    try {
      await trySsrFastPathOnBlock({
        url: "https://example.com/",
        proxy: "http://up:pp@geo.iproyal.com:12321",
        kuriBase: "http://127.0.0.1:9999",
      });
    } finally {
      globalThis.fetch = origFetch;
    }
    const parsed = JSON.parse(captured.body!);
    expect(parsed.proxy).toBe("http://up:pp@geo.iproyal.com:12321");
  });
});
