import { describe, it, expect } from "bun:test";

import { serve } from "bun";

import { inferCorrelationGraphV1, executeCaptureChainForTarget } from "@getfoundry/unbrowse-core";
import type { CapturedExchange } from "@getfoundry/unbrowse-core";

describe("replay-v2: local chain execution via correlations", () => {
  it("executes multi-step flow (csrf -> submit -> data) using captured correlations", { timeout: 30_000 }, async () => {
    // Simple stateful API server.
    const state = {
      csrf: `csrf_${Math.random().toString(16).slice(2)}`,
      session: `sess_${Math.random().toString(16).slice(2)}`,
    };

    const server = serve({
      port: 0,
      fetch(req) {
        const url = new URL(req.url);

        if (url.pathname === "/start" && req.method === "GET") {
          return Response.json({ csrfToken: state.csrf });
        }

        if (url.pathname === "/submit" && req.method === "POST") {
          const csrf = req.headers.get("x-csrf-token") ?? "";
          if (csrf !== state.csrf) return new Response("bad csrf", { status: 403 });
          return Response.json({ sessionId: state.session });
        }

        if (url.pathname === "/data" && req.method === "GET") {
          const sid = url.searchParams.get("sessionId") ?? "";
          if (sid !== state.session) return new Response("bad session", { status: 401 });
          return Response.json({ ok: true, sessionId: sid });
        }

        return new Response("not found", { status: 404 });
      },
    });

    const base = `http://127.0.0.1:${server.port}`;

    // Fake "captured" exchanges (what a real capture session would store).
    const exchanges: CapturedExchange[] = [
      {
        index: 0,
        timestamp: 1,
        request: { method: "GET", url: `${base}/start`, headers: {}, cookies: {}, queryParams: {} },
        response: {
          status: 200,
          headers: { "content-type": "application/json" },
          cookies: {},
          body: { csrfToken: state.csrf },
          bodyRaw: JSON.stringify({ csrfToken: state.csrf }),
          bodyFormat: "json",
          contentType: "application/json",
        },
      },
      {
        index: 1,
        timestamp: 2,
        request: {
          method: "POST",
          url: `${base}/submit`,
          headers: { "x-csrf-token": state.csrf, "content-type": "application/json" },
          cookies: {},
          queryParams: {},
          body: { hello: "world" },
          bodyRaw: JSON.stringify({ hello: "world" }),
          bodyFormat: "json",
          contentType: "application/json",
        },
        response: {
          status: 200,
          headers: { "content-type": "application/json" },
          cookies: {},
          body: { sessionId: state.session },
          bodyRaw: JSON.stringify({ sessionId: state.session }),
          bodyFormat: "json",
          contentType: "application/json",
        },
      },
      {
        index: 2,
        timestamp: 3,
        request: {
          method: "GET",
          url: `${base}/data?sessionId=${encodeURIComponent(state.session)}`,
          headers: {},
          cookies: {},
          queryParams: { sessionId: state.session },
        },
        response: {
          status: 200,
          headers: { "content-type": "application/json" },
          cookies: {},
          body: { ok: true },
          bodyRaw: JSON.stringify({ ok: true }),
          bodyFormat: "json",
          contentType: "application/json",
        },
      },
    ];

    const graph = inferCorrelationGraphV1(exchanges);

    // Now "replay" the final endpoint with a transport that DOES NOT manually set csrf/session.
    // It should succeed only because executeCaptureChainForTarget injects values from prior steps.
    const res = await executeCaptureChainForTarget(
      exchanges,
      graph,
      2,
      async (r) => {
        const resp = await fetch(r.url, {
          method: r.method,
          headers: r.headers,
          body: r.bodyText,
          signal: AbortSignal.timeout(5_000),
        });
        const text = await resp.text();
        const headers: Record<string, string> = {};
        resp.headers.forEach((v, k) => { headers[k] = v; });
        return { status: resp.status, headers, bodyText: text, contentType: headers["content-type"] };
      },
    );

    expect(res.final?.status).toBe(200);
    expect(res.final?.bodyJson).toEqual({ ok: true, sessionId: state.session });

    server.stop(true);
  });
});
