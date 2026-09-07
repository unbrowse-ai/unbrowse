/**
 * unbrowse-testing-privacy.test — repro suite for the gitea Unbrowse/unbrowse-testing
 * PRIVACY issues U-9 and U-12. One real repro per issue: RED before the fix,
 * GREEN after. Each `it(...)` is a concrete behavior check (code-level guard or
 * stub-fetch interception), NOT a placeholder.
 *
 *   U-9  — verbatim user intent + domains egress to beta-api by default;
 *          UNBROWSE_LOCAL_ONLY=1 must suppress ALL routing-telemetry egress,
 *          and the literal intent must never be sent even when telemetry is on.
 *   U-12 — POST /v1/sandbox/replay ships the local proxy URL + executable
 *          bundle_source to beta-api; this must be gated behind LOCAL_ONLY
 *          (no remote POST) and the proxy must not be shipped when LOCAL_ONLY.
 *
 * Witness: `bun test tests/unbrowse-testing-privacy.test.ts` exits 0.
 */
import { afterEach, describe, expect, it } from "bun:test";
import {
  recordRoutingTelemetry,
} from "../src/client/index.ts";
import {
  redactIntent,
  sanitizeRoutingEventBatch,
} from "../src/routing-telemetry.ts";
import {
  runBundleReplay,
  isLoopbackBase,
  LocalOnlyReplayError,
} from "../src/sandbox/bundle-replay-client.ts";
import type { RoutingTelemetryEvent } from "../src/types/index.ts";

const ORIGINAL_LOCAL_ONLY = process.env.UNBROWSE_LOCAL_ONLY;

afterEach(() => {
  if (ORIGINAL_LOCAL_ONLY === undefined) delete process.env.UNBROWSE_LOCAL_ONLY;
  else process.env.UNBROWSE_LOCAL_ONLY = ORIGINAL_LOCAL_ONLY;
});

const VERBATIM_INTENT = "find my email password reset link";

function makeSessionEvent(intent: string): RoutingTelemetryEvent {
  return {
    event_id: "evt-1",
    event_type: "routing_session_started",
    session_id: "sess-1",
    created_at: new Date().toISOString(),
    top_level_intent: intent,
    normalized_domains: ["mail.example.com"],
    run_type: "live",
    context_buckets: {} as RoutingTelemetryEvent extends { context_buckets: infer C } ? C : never,
  } as RoutingTelemetryEvent;
}

/** Intercept global fetch; record every URL POSTed and the body, fail nothing. */
function captureFetch() {
  const calls: Array<{ url: string; body: string }> = [];
  const stub = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    calls.push({ url, body: typeof init?.body === "string" ? init.body : "" });
    // Pretend the backend accepted it, so callers proceed normally.
    return new Response(JSON.stringify({ ok: true, ms: 1, egress_bytes: 0, cookies: [], routes_observed: [] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
  return { calls, stub };
}

describe("U-9 — intent/domain telemetry egress", () => {
  it("UNBROWSE_LOCAL_ONLY=1 suppresses the /v1/telemetry/routing POST entirely", async () => {
    process.env.UNBROWSE_LOCAL_ONLY = "1";
    const { calls, stub } = captureFetch();
    const realFetch = globalThis.fetch;
    globalThis.fetch = stub;
    try {
      await recordRoutingTelemetry([makeSessionEvent(VERBATIM_INTENT)]);
    } finally {
      globalThis.fetch = realFetch;
    }
    // No fetch at all — the guard must short-circuit before any network call.
    expect(calls.length).toBe(0);
    expect(calls.some((c) => c.url.includes("/v1/telemetry/routing"))).toBe(false);
  });

  it("with telemetry ON, the verbatim intent is redacted to a hash+shape (never sent literally)", () => {
    delete process.env.UNBROWSE_LOCAL_ONLY;
    const sanitized = sanitizeRoutingEventBatch([makeSessionEvent(VERBATIM_INTENT)]);
    const serialized = JSON.stringify(sanitized);
    // The literal text the user typed must not appear anywhere in the egress body.
    expect(serialized).not.toContain(VERBATIM_INTENT);
    // It is replaced by an irreversible redaction signature.
    expect(sanitized[0].top_level_intent).toMatch(/^intent:sha256-[0-9a-f]{16}:len\d+:w\d+$/);
  });

  it("redactIntent is deterministic and irreversible (same input → same hash, different text → different hash)", () => {
    const a = redactIntent(VERBATIM_INTENT);
    const b = redactIntent(VERBATIM_INTENT);
    const c = redactIntent("buy concert tickets");
    expect(a).toBe(b);
    expect(a).not.toBe(c);
    expect(a).not.toContain("password");
  });

  it("intent is redacted on EVERY event type, not just session_started", () => {
    const stepEvent = {
      ...makeSessionEvent(VERBATIM_INTENT),
      event_id: "evt-2",
      event_type: "routing_step_executed",
      step_id: "s1",
      step_index: 0,
    } as unknown as RoutingTelemetryEvent;
    const out = sanitizeRoutingEventBatch([stepEvent]);
    expect(JSON.stringify(out)).not.toContain(VERBATIM_INTENT);
  });
});

describe("U-12 — sandbox/replay proxy + bundle egress", () => {
  it("isLoopbackBase distinguishes the user's machine from a remote host", () => {
    expect(isLoopbackBase("http://127.0.0.1:8080")).toBe(true);
    expect(isLoopbackBase("http://localhost:6969")).toBe(true);
    expect(isLoopbackBase("https://beta-api.unbrowse.ai")).toBe(false);
  });

  it("UNBROWSE_LOCAL_ONLY=1 refuses to POST bundle_source/proxy to a non-loopback host", async () => {
    process.env.UNBROWSE_LOCAL_ONLY = "1";
    const { calls, stub } = captureFetch();
    let threw: unknown;
    try {
      await runBundleReplay(
        {
          targetOrigin: "https://reddit.com",
          targetHref: "https://reddit.com/search",
          bundleSource: "(() => { __nativeFetch('GET','https://reddit.com/search',{},null); })()",
          proxy: "http://corp-proxy.internal:8888",
        },
        { kuriBase: "https://beta-api.unbrowse.ai", fetchImpl: stub },
      );
    } catch (e) {
      threw = e;
    }
    expect(threw).toBeInstanceOf(LocalOnlyReplayError);
    // Crucially: NO POST was issued to the remote sandbox endpoint.
    expect(calls.length).toBe(0);
    expect(calls.some((c) => c.url.includes("/v1/sandbox/replay"))).toBe(false);
  });

  it("UNBROWSE_LOCAL_ONLY=1 allows a loopback replay but strips the local proxy URL from the body", async () => {
    process.env.UNBROWSE_LOCAL_ONLY = "1";
    const { calls, stub } = captureFetch();
    await runBundleReplay(
      {
        targetOrigin: "https://reddit.com",
        targetHref: "https://reddit.com/search",
        bundleSource: "(() => {})()",
        proxy: "http://corp-proxy.internal:8888",
      },
      { kuriBase: "http://127.0.0.1:8080", fetchImpl: stub },
    );
    // Loopback replay is permitted (runs on the user's own machine)...
    expect(calls.length).toBe(1);
    expect(calls[0].url).toContain("/v1/sandbox/replay");
    // ...but the local proxy URL must NOT be in the body.
    expect(calls[0].body).not.toContain("corp-proxy.internal");
    expect(JSON.parse(calls[0].body).proxy).toBeUndefined();
  });

  it("with telemetry ON (default), proxy IS forwarded to a loopback Kuri (no regression to capture)", async () => {
    delete process.env.UNBROWSE_LOCAL_ONLY;
    const { calls, stub } = captureFetch();
    await runBundleReplay(
      {
        targetOrigin: "https://reddit.com",
        bundleSource: "(() => {})()",
        proxy: "http://residential-proxy:12321",
      },
      { kuriBase: "http://127.0.0.1:8080", fetchImpl: stub },
    );
    expect(calls.length).toBe(1);
    expect(JSON.parse(calls[0].body).proxy).toBe("http://residential-proxy:12321");
  });
});
