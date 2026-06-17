/**
 * Client → server iProyal residential fallback.
 *
 * North star: when the client's local execution is blocked by a residential-IP
 * rate-limit (HTTP 429) or an IP-level block, the client POINTS TO THE SERVER's
 * POST /v1/proxy route in `residential` mode. The server egresses through the
 * iProyal residential proxy (the client may not hold creds locally) and returns
 * the recovered body — the client RELIES ON the server's iProyal fallback.
 *
 * Three witnesses:
 *   1. unit — `serverProxyFallback` posts to /v1/proxy with proxy:"residential"
 *      and a Bearer key, parses the recovered envelope. Deterministic local stub
 *      (Bun.serve), NO external network, NO mocked fetch.
 *   2. integration — `executeEndpoint` on a 429 with consent falls through to the
 *      server fallback and surfaces the recovered body (httpbin 429 + stub server).
 *   3. live (gated) — real iProyal egress with the configured creds returns a
 *      residential IP distinct from the machine's direct IP. The proxy the server
 *      relies on actually works.
 *
 * Mutation-test gate (memory feedback_xfail_mutation_test): witnesses 1 & 2 MUST
 * fail under HEAD before the build lands (the module does not exist; the
 * decision_trace steps are not emitted). Skipping the live witness is honest
 * absence of an opt-in, not a painted lamp.
 */
import { describe, expect, it, beforeAll, afterAll } from "bun:test";
import { serverProxyFallback } from "../src/execution/server-proxy-fallback.js";
import { resolveProxyUrl, proxiedFetchOnce } from "../src/execution/proxy-fetch.js";
import { executeEndpoint } from "../src/execution/index.js";
import type { SkillManifest, EndpointDescriptor } from "../src/types/skill.js";

// --- local stub of the unbrowse server's POST /v1/proxy route ---------------
let stub: { stop: () => void } | null = null;
let stubPort = 0;
let lastProxyBody: unknown = null;
let lastAuthHeader: string | null = null;

beforeAll(() => {
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const u = new URL(req.url);
      if (u.pathname === "/v1/proxy" && req.method === "POST") {
        lastAuthHeader = req.headers.get("authorization");
        lastProxyBody = await req.json();
        // The server recovered the page via its residential iProyal egress.
        return Response.json({
          status: 200,
          headers: {},
          body: JSON.stringify({ ok: true, via: "iproyal", recovered: true }),
          proxy_used: "residential",
          egress_ip: "202.188.48.57",
          fallback_used: true,
          surcharge_usd: 0.001,
        });
      }
      // A target that always rate-limits, for the integration witness.
      if (u.pathname === "/target") return new Response("rate limited", { status: 429 });
      return new Response("not found", { status: 404 });
    },
  });
  stub = server;
  stubPort = server.port;
});

afterAll(() => stub?.stop());

function traceSteps(res: { trace?: { decision_trace?: Array<{ step: string }> } }): string[] {
  return (res.trace?.decision_trace ?? []).map((s) => s.step);
}

// --- Witness 1: the client → server primitive -------------------------------
describe("serverProxyFallback primitive — client points to the server", () => {
  it("POSTs /v1/proxy with proxy:residential + Bearer, parses recovered body", async () => {
    const out = await serverProxyFallback(
      { url: "https://example.com/page", method: "GET" },
      // This witness asserts the RESIDENTIAL mode wire shape, so request it
      // explicitly — the default is now mode="auto" (server-direct-first, free;
      // see server-proxy-fallback.ts), not residential.
      { apiKey: "ubr_testkey", mode: "residential", env: { UNBROWSE_API_URL: `http://127.0.0.1:${stubPort}` } as NodeJS.ProcessEnv },
    );
    expect(out).not.toBeNull();
    expect(out?.status).toBe(200);
    expect(out?.proxy_used).toBe("residential");
    expect(out?.egress_ip).toBe("202.188.48.57");
    expect(JSON.parse(out!.body)).toMatchObject({ ok: true, via: "iproyal" });
    // The request actually declared residential mode + carried the key.
    expect(lastProxyBody).toMatchObject({ url: "https://example.com/page", proxy: "residential" });
    expect(lastAuthHeader).toBe("Bearer ubr_testkey");
  });

  it("returns null when no API key (server would 402 — honest skip)", async () => {
    const out = await serverProxyFallback(
      { url: "https://example.com" },
      { apiKey: "", env: { UNBROWSE_API_URL: `http://127.0.0.1:${stubPort}` } as NodeJS.ProcessEnv },
    );
    expect(out).toBeNull();
  });

  it("returns null under UNBROWSE_DIRECT_EGRESS=1 (explicit opt-out, no proxying)", async () => {
    const out = await serverProxyFallback(
      { url: "https://example.com" },
      { apiKey: "ubr_testkey", env: { UNBROWSE_API_URL: `http://127.0.0.1:${stubPort}`, UNBROWSE_DIRECT_EGRESS: "1" } as NodeJS.ProcessEnv },
    );
    expect(out).toBeNull();
  });

  it("returns null on a non-OK server envelope (graceful degrade)", async () => {
    const out = await serverProxyFallback(
      { url: "https://example.com" },
      { apiKey: "ubr_testkey", env: { UNBROWSE_API_URL: `http://127.0.0.1:${stubPort}/nope` } as NodeJS.ProcessEnv },
    );
    expect(out).toBeNull();
  });
});

// --- Witness 2: wired into executeEndpoint's block path ---------------------
// owner_type "agent" forces the LOCAL replay path (marketplace skills delegate
// to the backend /v1/execute and never reach the local 429 branch). The target
// is the local stub's /target (always 429); the server fallback hits the same
// stub's /v1/proxy. A dead UNBROWSE_PROXY_URL makes the local residential proxy
// attempt fail fast so the flow falls through to the server fallback — exactly
// the "local egress blocked → rely on the server" case. allowPrivateIps is on
// under `bun test`, so the localhost target is reachable.
describe("executeEndpoint 429 → client relies on server iProyal fallback", () => {
  it("falls through to the server proxy and surfaces the recovered body", async () => {
    const prev = {
      key: process.env.UNBROWSE_API_KEY,
      url: process.env.UNBROWSE_API_URL,
      proxy: process.env.UNBROWSE_PROXY_URL,
    };
    process.env.UNBROWSE_API_KEY = "ubr_testkey";
    process.env.UNBROWSE_API_URL = `http://127.0.0.1:${stubPort}`;
    process.env.UNBROWSE_PROXY_URL = "http://127.0.0.1:1"; // dead → local proxy fails fast
    try {
      const target = `http://127.0.0.1:${stubPort}/target`;
      const ep = {
        endpoint_id: "ep-429",
        method: "GET",
        url_template: target,
        description: "429 probe",
        idempotency: "safe",
        verification_status: "verified",
        reliability_score: 0.9,
      } as EndpointDescriptor;
      const s = {
        skill_id: "local:probe-429",
        version: "1.0.0",
        schema_version: "1",
        name: "429 probe",
        intent_signature: "local probe",
        domain: `127.0.0.1:${stubPort}`,
        description: "server-proxy-fallback probe",
        owner_type: "agent",
        execution_type: "http",
        endpoints: [ep],
        lifecycle: "active",
        base_price_usd: 0,
      } as SkillManifest;
      const res = await executeEndpoint(s, ep, {}, undefined, {
        contextUrl: target,
        paid_proxy_fallback: true,
      } as unknown as Parameters<typeof executeEndpoint>[4]);
      const steps = traceSteps(res);
      expect(steps).toContain("429_server_proxy_fallback_attempted");
      expect(steps).toContain("429_server_proxy_fallback_success");
      const data = (res as { result?: { ok?: boolean; via?: string } }).result;
      expect(data?.ok).toBe(true);
      expect(data?.via).toBe("iproyal");
    } finally {
      for (const [k, v] of [["UNBROWSE_API_KEY", prev.key], ["UNBROWSE_API_URL", prev.url], ["UNBROWSE_PROXY_URL", prev.proxy]] as const) {
        if (v === undefined) delete process.env[k]; else process.env[k] = v;
      }
    }
  }, 60_000);
});

// --- Witness 3: live iProyal egress (gated) ---------------------------------
const LIVE =
  process.env.UNBROWSE_LIVE_PROXY_TEST === "1" && Boolean(resolveProxyUrl());
const live = LIVE ? describe : describe.skip;
live("live iProyal egress — the proxy the server relies on works", () => {
  it("residential egress IP differs from the direct IP", async () => {
    const direct = (await (await fetch("https://ipv4.icanhazip.com")).text()).trim();
    const { response, dispatch } = await proxiedFetchOnce(
      "https://ipv4.icanhazip.com",
      {},
      resolveProxyUrl(),
    );
    const proxied = (await response.text()).trim();
    expect(dispatch.dispatched).toBe(true);
    expect(direct).toMatch(/^\d+\.\d+\.\d+\.\d+$/);
    expect(proxied).toMatch(/^\d+\.\d+\.\d+\.\d+$/);
    expect(proxied).not.toBe(direct);
  }, 30_000);
});
