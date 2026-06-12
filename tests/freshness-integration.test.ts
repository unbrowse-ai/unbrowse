/**
 * Day 6 Worker 7 — full-flywheel integration smoke.
 *
 * Walks the entire freshness pipeline end-to-end against a real loopback
 * HTTP server (no mocks). Each test drives a real GET, runs the captured
 * response through `extractEndpoints`, then wires the captured binding's
 * metadata (ttl_ms / observed_at / single_use) into a chain-walk scenario
 * the wrapper at `executeEndpointWithChain` must honor.
 *
 *   Test 1: real GET → capture as `RawRequest` → `extractEndpoints` →
 *     assert the binding for `csrf_token` carries `ttl_ms === 2000`
 *     (derived from `Set-Cookie: csrf_token=...; Max-Age=2`) AND
 *     `observed_at` ISO within the last 5s. Then pre-populate a
 *     SessionYieldCache with that captured metadata and call
 *     `executeEndpointWithChain` against a synthetic consumer INSIDE the
 *     TTL window. Assert decision_trace contains `chain_walk_fresh_reused`
 *     (NOT `chain_walk_refetched_*`).
 *
 *   Test 2: same setup, but advance `ctx.now` past `observed_at + ttl_ms`.
 *     Assert the producer is refetched exactly once, the leaf fires, the
 *     decision_trace shows `chain_walk_refetched_success` for `csrf_token`,
 *     the cache holds the fresh value with observed_at === ctx.now, and
 *     the leaf's mutation echo contains the fresh value.
 *
 *   Test 3: drive `/api/prefs` whose response has no Set-Cookie, no
 *     Cache-Control, no `expires_in`, and whose binding key is NOT
 *     csrf-shaped (`user_pref_color`). Run extractEndpoints. Assert the
 *     binding has `observed_at` set but `ttl_ms === undefined` — proves
 *     the freshness extractor doesn't hallucinate a TTL where no signal
 *     exists.
 *
 * Companion to `tests/dag-walk-staleness.test.ts` (which tests the
 * wrapper against synthetic, hand-built bindings). This test refuses to
 * skip the capture-side step: every ttl_ms/observed_at the wrapper
 * evaluates was emitted by `extractEndpoints` over a real `RawRequest`
 * for at least one binding per chain walk.
 *
 * Judgment call on "real capture": `extractEndpoints` populates the
 * `csrf_token` binding under `semantic.requires` (URL query param) with
 * ttl_ms=2000, but `inferProvidesFromFields` does NOT auto-emit
 * `provides[csrf_token]` for a body field of that name (it only emits
 * IDs/URLs/names — see `src/lib/graph-core/index.ts:inferProvidesFromFields`).
 * In production the indexer or agent enriches `provides` after capture;
 * here the tests construct the producer endpoint by reusing the
 * captured binding's metadata (ttl_ms / observed_at / single_use)
 * verbatim. The capture-side population is the path under test; the
 * wrapper's reaction to that captured metadata is what we assert.
 *
 * Worker 1 is concurrently fixing wrapper bugs in
 * `src/execution/index.ts`. If their fixes haven't landed, Test 2 may
 * fail (the refetch path). Test 1 should pass independently of Worker 1
 * because the fresh-reused branch doesn't exercise the refetch ladder.
 * Test 3 doesn't touch the wrapper at all.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import http from "node:http";
import type { AddressInfo } from "node:net";

import type { RawRequest } from "../src/capture/index.js";
import { extractEndpoints } from "../src/reverse-engineer/index.js";
import { executeEndpointWithChain } from "../src/execution/index.js";
import type {
  ChainWalkContext,
  EndpointDescriptor,
  OperationBinding,
  SessionYieldCache,
  SkillManifest,
} from "../src/types/skill.js";

// --- Loopback server ----------------------------------------------------------

let server: http.Server;
let baseUrl: string;
let host: string;
let authHits = 0;
let protectedHits = 0;
let liveCsrf: string | null = null;
let lastProtectedCsrf: string | null = null;

beforeAll(async () => {
  server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (url.pathname === "/api/auth") {
      authHits += 1;
      const value = `fresh-${authHits}`;
      liveCsrf = value;
      res.writeHead(200, {
        "content-type": "application/json",
        // Cookie name matches binding key `csrf_token` so the freshness
        // extractor's keyMatch regex fires and ttl_ms === 2000 instead of
        // falling through to the csrf-shape default of 600_000.
        "set-cookie": `csrf_token=${value}; Path=/; Max-Age=2`,
      });
      res.end(JSON.stringify({ csrf_token: value }));
      return;
    }
    if (url.pathname === "/api/protected") {
      protectedHits += 1;
      const chunks: Buffer[] = [];
      req.on("data", (c) => chunks.push(c as Buffer));
      req.on("end", () => {
        let token: string | null = null;
        const raw = Buffer.concat(chunks).toString("utf8");
        try {
          const parsed = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
          if (typeof parsed.csrf_token === "string") token = parsed.csrf_token;
        } catch {
          /* swallow */
        }
        if (!token) token = url.searchParams.get("csrf_token");
        if (!token) {
          const hdr = req.headers["x-csrf-token"];
          token = typeof hdr === "string" ? hdr : Array.isArray(hdr) ? (hdr[0] ?? null) : null;
        }
        lastProtectedCsrf = token;
        // Always 200 — the harness collects evidence and the test judges.
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true, csrf_token: token, ts: Date.now() }));
      });
      return;
    }
    if (url.pathname === "/api/prefs") {
      // No Set-Cookie, no Cache-Control. Body has non-csrf-shaped keys.
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ user_pref_color: "blue", user_pref_lang: "en" }));
      return;
    }
    res.writeHead(404).end();
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const addr = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${addr.port}`;
  host = `127.0.0.1:${addr.port}`;
});

afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
});

beforeEach(() => {
  authHits = 0;
  protectedHits = 0;
  liveCsrf = null;
  lastProtectedCsrf = null;
});

// --- Fixture helpers ----------------------------------------------------------

/**
 * Drive a real GET against the server and capture into a `RawRequest`
 * with the same flat header shape the HAR/passive interceptor emits in
 * production (`src/capture/index.ts`). Headers are lowercased to match
 * the production HAR normalizer.
 */
async function captureGet(path: string): Promise<RawRequest> {
  const fullUrl = `${baseUrl}${path}`;
  const startedAt = new Date().toISOString();
  const res = await fetch(fullUrl, { method: "GET" });
  const responseHeaders: Record<string, string> = {};
  res.headers.forEach((value, key) => {
    responseHeaders[key.toLowerCase()] = value;
  });
  const responseBody = await res.text();
  return {
    url: fullUrl,
    method: "GET",
    request_headers: {},
    request_body: undefined,
    response_status: res.status,
    response_headers: responseHeaders,
    response_body: responseBody,
    timestamp: startedAt,
  };
}

function findBinding(
  bindings: OperationBinding[] | undefined,
  key: string,
): OperationBinding | undefined {
  return (bindings ?? []).find((b) => b.key === key);
}

/**
 * Build a producer EndpointDescriptor by anchoring on the real captured
 * endpoint and lifting the captured binding metadata into `provides[]`.
 * The ttl_ms / observed_at / single_use values come from the real
 * capture-side population (the path under test); only the producer
 * topology (placing the binding under `provides` rather than `requires`)
 * is constructed by the test.
 */
function makeProducerFromCapture(
  capturedEndpoint: EndpointDescriptor,
  capturedBinding: OperationBinding,
): EndpointDescriptor {
  return {
    ...capturedEndpoint,
    endpoint_id: "csrf-producer",
    // Drop the captured `?csrf_token=...` query string from the URL
    // template so the producer re-fetch hits /api/auth cleanly. The
    // captured query was an artifact of the original request; the
    // producer's job is to MINT a fresh csrf, not to consume one.
    url_template: `${baseUrl}/api/auth`,
    method: "GET",
    idempotency: "safe",
    verification_status: "verified",
    reliability_score: 1,
    query: undefined,
    semantic: {
      action_kind: "read",
      resource_kind: "token",
      provides: [
        {
          ...capturedBinding,
          // The binding came in via `requires`; flip it to provides
          // semantics. ttl_ms / observed_at / single_use are
          // preserved verbatim from the real capture.
          required: undefined,
          source: "response",
        },
      ],
    },
  };
}

function makeConsumer(over: Partial<EndpointDescriptor> = {}): EndpointDescriptor {
  return {
    endpoint_id: "mutation-consumer",
    method: "POST",
    url_template: `${baseUrl}/api/protected`,
    description: "Mutation endpoint that echoes the csrf_token it received",
    // `safe` sidesteps the unsafe-confirmation gate; the freshness
    // wrapper is what's under test, not the mutation-safety branch.
    idempotency: "safe",
    verification_status: "verified",
    reliability_score: 1,
    body: { csrf_token: "{csrf_token}" } as Record<string, unknown>,
    semantic: {
      action_kind: "mutate",
      resource_kind: "session",
      requires: [{ key: "csrf_token", required: true, type: "string" }],
    },
    ...over,
  };
}

function makeSkill(endpoints: EndpointDescriptor[]): SkillManifest {
  return {
    // `local:` prefix bypasses the marketplace payment gate in
    // `executeEndpoint`. The freshness pipeline is what we're testing,
    // not the paid-skill flow.
    skill_id: "local:freshness-integration-fixture",
    version: "1.0.0",
    schema_version: "1",
    name: "freshness-integration-fixture",
    intent_signature: "csrf chain walk (capture→extract→wrapper)",
    domain: host,
    description: "Integration smoke for capture-side population + chain-walk freshness",
    owner_type: "agent",
    execution_type: "http",
    endpoints,
    lifecycle: "active",
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };
}

function makeCtx(over: Partial<ChainWalkContext> = {}): ChainWalkContext {
  return {
    now: Date.now(),
    consumed: new Map<string, boolean>(),
    depth: 0,
    visited: new Set<string>(),
    maxDepth: 4,
    trace: [],
    ...over,
  };
}

// --- Tests --------------------------------------------------------------------

describe("freshness integration — capture → extractEndpoints → wrapper (full flywheel)", () => {
  test("Test 1: real capture populates ttl_ms+observed_at; wrapper reuses fresh binding", async () => {
    const startMs = Date.now();

    // 1. Drive a real GET against /api/auth?csrf_token=<initial>
    //    so the URL query carries the binding key. captureGet returns
    //    a RawRequest with the real Set-Cookie header.
    const captured = await captureGet("/api/auth?csrf_token=seed");
    expect(captured.response_status).toBe(200);
    expect(captured.response_headers["set-cookie"]).toMatch(/Max-Age=2/);
    expect(liveCsrf).not.toBeNull();

    // 2. Run extractEndpoints on the captured RawRequest array.
    const extracted = extractEndpoints([captured], undefined, {
      pageUrl: `${baseUrl}/`,
      finalUrl: `${baseUrl}/`,
    });
    expect(extracted.length).toBeGreaterThanOrEqual(1);
    const capturedEndpoint = extracted[0]!;
    const requires = capturedEndpoint.semantic?.requires ?? [];
    const provides = capturedEndpoint.semantic?.provides ?? [];
    const allBindings = [...requires, ...provides];

    // 3. Capture-side population assertions — the heart of Test 1.
    const csrfBinding = findBinding(allBindings, "csrf_token");
    expect(csrfBinding).toBeDefined();
    // Max-Age=2 → ttl_ms === 2000. Falsifier: cookie-name regex broke,
    // freshness fell through to csrf-shape fallback (600_000).
    expect(csrfBinding!.ttl_ms).toBe(2_000);
    expect(typeof csrfBinding!.observed_at).toBe("string");
    const observedMs = Date.parse(csrfBinding!.observed_at!);
    expect(Number.isFinite(observedMs)).toBe(true);
    expect(observedMs).toBeGreaterThanOrEqual(startMs - 100);
    expect(observedMs).toBeLessThanOrEqual(Date.now() + 100);
    expect(Math.abs(Date.now() - observedMs)).toBeLessThan(5_000);

    // 4. Pre-populate SessionYieldCache from the captured binding.
    const yields: SessionYieldCache = new Map([
      [
        "csrf_token",
        {
          value: liveCsrf,
          observed_at: csrfBinding!.observed_at!,
          ttl_ms: csrfBinding!.ttl_ms,
          single_use: csrfBinding!.single_use,
        },
      ],
    ]);

    // 5. Build skill: producer (carries the captured binding under
    //    provides[]) + a synthetic consumer that requires csrf_token.
    const producer = makeProducerFromCapture(capturedEndpoint, csrfBinding!);
    const consumer = makeConsumer();
    const skill = makeSkill([producer, consumer]);

    // 6. Run the wrapper inside the TTL window. observed_at + 500ms
    //    leaves 1500ms of slack before the 2s deadline.
    const ctx = makeCtx({ now: observedMs + 500 });
    const result = await executeEndpointWithChain(
      skill,
      consumer,
      { csrf_token: "{csrf_token}" },
      undefined,
      { session_yields: yields },
      ctx,
    );

    // 7. The capture's GET already incremented authHits to 1. If the
    //    wrapper did NOT refetch, authHits stays at 1.
    expect(authHits).toBe(1);
    expect(protectedHits).toBe(1);

    // 8. decision_trace contains chain_walk_fresh_reused for csrf_token
    //    and NO chain_walk_refetched_success entry.
    const trace = ctx.trace;
    const freshStep = trace.find(
      (s) => s.step === "chain_walk_fresh_reused" && s.binding_key === "csrf_token",
    );
    expect(freshStep).toBeDefined();
    const refetchStep = trace.find((s) => s.step === "chain_walk_refetched_success");
    expect(refetchStep).toBeUndefined();
    expect(result).toBeDefined();
  });

  test("Test 2: stale binding → wrapper refetches producer, decision_trace shows chain_walk_refetched_success", async () => {
    // 1. Real capture.
    const captured = await captureGet("/api/auth?csrf_token=seed");
    expect(captured.response_status).toBe(200);

    // 2. Real extract — the binding's ttl_ms / observed_at must come
    //    from the capture-side pipeline.
    const extracted = extractEndpoints([captured], undefined, {
      pageUrl: `${baseUrl}/`,
      finalUrl: `${baseUrl}/`,
    });
    const capturedEndpoint = extracted[0]!;
    const allBindings = [
      ...(capturedEndpoint.semantic?.requires ?? []),
      ...(capturedEndpoint.semantic?.provides ?? []),
    ];
    const csrfBinding = findBinding(allBindings, "csrf_token");
    expect(csrfBinding).toBeDefined();
    expect(csrfBinding!.ttl_ms).toBe(2_000);
    const observedMs = Date.parse(csrfBinding!.observed_at!);
    const captureTimeCsrf = liveCsrf!;

    // 3. SessionYieldCache pre-populated with the captured value.
    const yields: SessionYieldCache = new Map([
      [
        "csrf_token",
        {
          value: captureTimeCsrf,
          observed_at: csrfBinding!.observed_at!,
          ttl_ms: csrfBinding!.ttl_ms,
          single_use: csrfBinding!.single_use,
        },
      ],
    ]);

    const producer = makeProducerFromCapture(capturedEndpoint, csrfBinding!);
    const consumer = makeConsumer();
    const skill = makeSkill([producer, consumer]);

    // 4. ctx.now = observed_at + ttl_ms + 1000ms → 1s past TTL.
    const now = observedMs + (csrfBinding!.ttl_ms ?? 0) + 1_000;
    const ctx = makeCtx({ now });

    const preWrapperAuthHits = authHits; // 1 (the capture GET)

    await executeEndpointWithChain(
      skill,
      consumer,
      { csrf_token: "{csrf_token}" },
      undefined,
      { session_yields: yields },
      ctx,
    );

    // 5. The wrapper refetched the producer exactly once.
    expect(authHits).toBe(preWrapperAuthHits + 1);
    expect(protectedHits).toBe(1);

    // 6. decision_trace shows chain_walk_refetched_success for csrf_token.
    const refetchStep = ctx.trace.find(
      (s) => s.step === "chain_walk_refetched_success" && s.binding_key === "csrf_token",
    );
    expect(refetchStep).toBeDefined();

    // 7. Cache now holds the fresh value. The server emitted `fresh-2`
    //    (auth was hit twice: captureGet → fresh-1, wrapper refetch →
    //    fresh-2). The refresh writes a SessionYield whose observed_at
    //    is the frozen-clock ctx.now ISO.
    const refreshed = yields.get("csrf_token");
    expect(refreshed).toBeDefined();
    expect(refreshed!.value).toBe("fresh-2");
    expect(refreshed!.value).not.toBe(captureTimeCsrf);
    expect(Date.parse(refreshed!.observed_at)).toBe(now);

    // 8. Leaf's mutation echo carries the fresh value. If Worker 1's
    //    fix substitutes cached values into the leaf's params, the
    //    server receives `fresh-2` in the body. If not, this assertion
    //    fails — the trail marker that pins Worker 1's contract.
    expect(lastProtectedCsrf).toBe("fresh-2");
  });

  test("Test 3: no TTL signal + non-csrf key → observed_at set, ttl_ms undefined", async () => {
    // /api/prefs has no Set-Cookie, no Cache-Control, no expires_in.
    // The body fields are non-csrf-shaped, so the csrf-shape fallback
    // must NOT fire.
    const captured = await captureGet("/api/prefs?user_pref_color=blue");
    expect(captured.response_status).toBe(200);
    expect(captured.response_headers["set-cookie"]).toBeUndefined();
    expect(captured.response_headers["cache-control"]).toBeUndefined();

    const extracted = extractEndpoints([captured], undefined, {
      pageUrl: `${baseUrl}/`,
      finalUrl: `${baseUrl}/`,
    });
    expect(extracted.length).toBeGreaterThanOrEqual(1);
    const semantic = extracted[0]!.semantic;
    const bindings = [
      ...(semantic?.requires ?? []),
      ...(semantic?.provides ?? []),
    ];
    expect(bindings.length).toBeGreaterThanOrEqual(1);

    const colorBinding = findBinding(bindings, "user_pref_color");
    expect(colorBinding).toBeDefined();
    // Every binding must carry observed_at (the capture's wall-clock).
    expect(typeof colorBinding!.observed_at).toBe("string");
    // Falsifier: a future blanket-default TTL would set ttl_ms here.
    expect(colorBinding!.ttl_ms).toBeUndefined();
  });
});
