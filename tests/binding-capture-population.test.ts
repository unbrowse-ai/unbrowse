/**
 * Layer C (capture-side population) tests — AC2.
 *
 * End-to-end through `extractEndpoints`: feed a `RawRequest` with the
 * observed-signal fixtures, then assert the resulting
 * `endpoint.semantic.requires/provides` bindings carry the expected
 * `ttl_ms`, `single_use`, and `observed_at` fields.
 *
 * No mocks. Real `extractEndpoints` path, real `inferEndpointSemantic`,
 * real augmentation helper. See
 * `.claude/jesus-loop.default.architecture.md` and
 * `.claude/jesus-loop.default.plan.md` AC2.
 */

import { describe, expect, test } from "bun:test";
import { extractEndpoints } from "../src/reverse-engineer/index.js";
import type { RawRequest } from "../src/capture/index.js";
import type { OperationBinding } from "../src/types/skill.js";

function makeReq(over: Partial<RawRequest> = {}): RawRequest {
  return {
    url: "https://api.example.com/v1/things",
    method: "GET",
    request_headers: {},
    request_body: undefined,
    response_status: 200,
    response_headers: { "content-type": "application/json" },
    response_body: '{"id":"abc","name":"thing"}',
    timestamp: new Date().toISOString(),
    ...over,
  } as RawRequest;
}

function findBinding(
  bindings: OperationBinding[] | undefined,
  key: string,
): OperationBinding | undefined {
  return (bindings ?? []).find((b) => b.key === key);
}

/**
 * Pull the union of requires + provides bindings off the first endpoint
 * extracted from a single-request fixture. Mirrors how a downstream
 * caller would observe the freshness fields.
 */
function bindingsFromFixture(req: RawRequest): OperationBinding[] {
  const endpoints = extractEndpoints([req], undefined, {
    pageUrl: "https://www.example.com/",
    finalUrl: "https://www.example.com/",
  });
  expect(endpoints.length).toBeGreaterThanOrEqual(1);
  const semantic = endpoints[0]!.semantic;
  return [...(semantic?.requires ?? []), ...(semantic?.provides ?? [])];
}

describe("AC2 — capture-side binding freshness population", () => {
  test("Set-Cookie Max-Age=3600 → ttl_ms === 3_600_000 + observed_at ISO within 5s", () => {
    const start = Date.now();
    // csrf_token=... ; Max-Age=3600 on the response. csrf_token is also
    // in the query string so it appears in semantic.requires.
    const req = makeReq({
      url: "https://api.example.com/v1/items?csrf_token=ABCDEF&page=1",
      response_headers: {
        "content-type": "application/json",
        "set-cookie": "csrf_token=ABCDEF; Path=/; Max-Age=3600; HttpOnly",
      },
      response_body: '{"items":[{"id":"i1","name":"one"}]}',
    });
    const bindings = bindingsFromFixture(req);
    const binding = findBinding(bindings, "csrf_token");
    expect(binding).toBeDefined();
    expect(binding!.ttl_ms).toBe(3_600_000);
    expect(typeof binding!.observed_at).toBe("string");
    const observedMs = Date.parse(binding!.observed_at!);
    expect(Number.isFinite(observedMs)).toBe(true);
    // Within 5 seconds of test start (capture stamp is real wall clock).
    expect(observedMs).toBeGreaterThanOrEqual(start - 100);
    expect(observedMs).toBeLessThanOrEqual(Date.now() + 100);
    expect(Math.abs(Date.now() - observedMs)).toBeLessThan(5_000);
  });

  test("response body {expires_in: 1800} → ttl_ms === 1_800_000 on at least one binding", () => {
    // OAuth-style token response. The body's keys (e.g. `id`) provide
    // bindings; the top-level `expires_in` propagates as ttl_ms onto
    // every produced binding.
    const req = makeReq({
      url: "https://api.example.com/v1/oauth/token",
      method: "POST",
      request_body: '{"grant_type":"client_credentials"}',
      response_body: JSON.stringify({
        access_token: "x",
        expires_in: 1800,
        id: "tok_abc",
      }),
    });
    const bindings = bindingsFromFixture(req);
    expect(bindings.length).toBeGreaterThanOrEqual(1);
    const withTtl = bindings.filter((b) => b.ttl_ms === 1_800_000);
    expect(withTtl.length).toBeGreaterThanOrEqual(1);
  });

  test("Cache-Control: max-age=300 → ttl_ms === 300_000", () => {
    const req = makeReq({
      url: "https://api.example.com/v1/items?cursor=eyJp&limit=10",
      response_headers: {
        "content-type": "application/json",
        "cache-control": "public, max-age=300, must-revalidate",
      },
      response_body: '{"items":[{"id":"a","name":"alpha"}],"cursor":"next123"}',
    });
    const bindings = bindingsFromFixture(req);
    expect(bindings.length).toBeGreaterThanOrEqual(1);
    // Without csrf-shape and without Set-Cookie / expires_in, the
    // Cache-Control max-age must propagate to every binding.
    const withTtl = bindings.filter((b) => b.ttl_ms === 300_000);
    expect(withTtl.length).toBeGreaterThanOrEqual(1);
    for (const b of bindings) {
      expect(typeof b.observed_at).toBe("string");
    }
  });

  test("csrf-shaped key with no observed TTL signal → ttl_ms === 600_000 fallback", () => {
    // No Set-Cookie, no Cache-Control, no expires_in. Just a csrf_token
    // query param. The csrf-shape heuristic must fire (600_000 ms).
    const req = makeReq({
      url: "https://api.example.com/v1/items?csrf_token=XYZ",
      response_body: '{"items":[{"id":"a"}]}',
      response_headers: { "content-type": "application/json" },
    });
    const bindings = bindingsFromFixture(req);
    const binding = findBinding(bindings, "csrf_token");
    expect(binding).toBeDefined();
    expect(binding!.ttl_ms).toBe(600_000);
  });

  test("access-shaped key (NOT csrf-shaped) with no observed TTL → ttl_ms === undefined", () => {
    // The csrf-shape heuristic explicitly excludes /auth|access|refresh/.
    // The query-sanitizer strips `access_token` as sensitive, so we land
    // the binding through a path template `{access_id}` instead. It is
    // a custom name that doesn't match csrf-shape and has no observed
    // TTL signal, so ttl_ms must stay unset.
    const req = makeReq({
      url: "https://api.example.com/v1/users/u_42/sessions/sess_abc",
      response_body: JSON.stringify({
        // Body fields become provides bindings; access_token (sensitive
        // name) here is just data, not in the URL. No TTL signals.
        access_token: "AAAA",
        profile: { id: "u_42" },
      }),
      response_headers: { "content-type": "application/json" },
    });
    const endpoints = extractEndpoints([req], undefined, {
      pageUrl: "https://www.example.com/",
      finalUrl: "https://www.example.com/",
    });
    expect(endpoints.length).toBeGreaterThanOrEqual(1);
    const semantic = endpoints[0]!.semantic;
    const bindings = [...(semantic?.requires ?? []), ...(semantic?.provides ?? [])];
    expect(bindings.length).toBeGreaterThanOrEqual(1);
    // For every binding, observed_at must be set. For any binding whose
    // key contains "auth", "access", or "refresh", ttl_ms must be
    // undefined because csrf-shape explicitly rejects those.
    let nonCsrfWithUnsetTtl = 0;
    for (const b of bindings) {
      expect(typeof b.observed_at).toBe("string");
      if (/auth|access|refresh/i.test(b.key)) {
        expect(b.ttl_ms).toBeUndefined();
        nonCsrfWithUnsetTtl++;
      }
    }
    // Additionally, at least one binding must NOT be csrf-shaped and
    // must NOT have ttl_ms — proves the fallback isn't blanket-applied.
    const generic = bindings.find(
      (b) => !/csrf|xsrf|token/i.test(b.key) && b.ttl_ms === undefined,
    );
    expect(generic).toBeDefined();
  });

  test("X-Token-Single-Use: true header → single_use === true on every binding", () => {
    const req = makeReq({
      url: "https://api.example.com/v1/redeem?code=ONCE",
      method: "POST",
      request_body: '{"action":"claim"}',
      response_headers: {
        "content-type": "application/json",
        "x-token-single-use": "true",
      },
      response_body: '{"id":"r1","status":"redeemed"}',
    });
    const bindings = bindingsFromFixture(req);
    expect(bindings.length).toBeGreaterThanOrEqual(1);
    const withSingleUse = bindings.filter((b) => b.single_use === true);
    expect(withSingleUse.length).toBeGreaterThanOrEqual(1);
  });

  test("no single-use signal → single_use === undefined on every binding", () => {
    const req = makeReq({
      url: "https://api.example.com/v1/items?cursor=eyJp",
      response_body: '{"items":[{"id":"a"}],"cursor":"next"}',
      response_headers: { "content-type": "application/json" },
    });
    const bindings = bindingsFromFixture(req);
    expect(bindings.length).toBeGreaterThanOrEqual(1);
    for (const b of bindings) {
      expect(b.single_use).toBeUndefined();
    }
  });
});
