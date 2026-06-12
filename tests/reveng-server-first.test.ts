/**
 * No-raw-secret-leak witness for thin-client checkpoint ① (reverse-engineer).
 *
 * The RE inference moves server-side, so capture egresses to /v1/reveng. This
 * proves the egress payload carries the request STRUCTURE but NONE of the secret
 * values (cookies, auth tokens, api keys) — "credentials never leave the machine"
 * holds even though data flows to the server.
 */
import { describe, expect, test } from "bun:test";
import { revengEgressPayload, revengServerFirst } from "../src/capture/reveng-server-first.js";
import type { RawRequest } from "../src/capture/index.js";

const SECRET_COOKIE = "sid=SUPER_SECRET_SESSION_abc123XYZ";
const SECRET_BEARER = "Bearer tok_LIVE_9f8e7d6c5b4a_SECRET";
const SECRET_APIKEY = "REMOVED_STRIPE_KEY";
const SECRET_BODY_PW = "hunter2_PLAINTEXT_PASSWORD";

const capture: RawRequest[] = [
  {
    url: "https://api.example.com/v1/orders?token=QUERYSECRET_zzz",
    method: "POST",
    request_headers: {
      cookie: SECRET_COOKIE,
      authorization: SECRET_BEARER,
      "x-api-key": SECRET_APIKEY,
      "content-type": "application/json",
    },
    request_body: JSON.stringify({ user: "alice", password: SECRET_BODY_PW }),
    response_status: 200,
    response_headers: { "set-cookie": SECRET_COOKIE },
    response_body: JSON.stringify({ ok: true }),
    timestamp: "2026-06-13T00:00:00Z",
  },
];

const SECRETS = [SECRET_COOKIE, SECRET_BEARER, SECRET_APIKEY, SECRET_BODY_PW, "QUERYSECRET_zzz", "tok_LIVE_9f8e7d6c5b4a_SECRET"];

describe("reveng egress — no raw secret crosses the wire", () => {
  test("the obfuscated egress payload contains the URL structure but NO secret value", () => {
    const wire = revengEgressPayload(capture);
    // structure preserved
    expect(wire).toContain("api.example.com");
    expect(wire).toContain("/v1/orders");
    // every secret value stripped
    for (const secret of SECRETS) {
      expect(wire).not.toContain(secret);
    }
  });

  test("multiple requests: no secret survives obfuscation", () => {
    const many = [capture[0], { ...capture[0], url: "https://api.example.com/v1/users" }];
    const wire = revengEgressPayload(many);
    for (const secret of SECRETS) expect(wire).not.toContain(secret);
  });
});

describe("reveng server-first — degraded fallback path", () => {
  test("falls back to a local result when the server is unreachable (no throw)", async () => {
    const origFetch = globalThis.fetch;
    process.env.UNBROWSE_REVENG_TIMEOUT = "300";
    // Force the server path (not local-only) but make fetch fail.
    const prevLocal = process.env.UNBROWSE_LOCAL_ONLY;
    delete process.env.UNBROWSE_LOCAL_ONLY;
    globalThis.fetch = (async () => { throw new Error("network down"); }) as typeof fetch;
    try {
      const out = await revengServerFirst(capture, undefined, { pageUrl: "https://example.com" });
      expect(Array.isArray(out)).toBe(true); // local fallback produced an array, never threw
    } finally {
      globalThis.fetch = origFetch;
      if (prevLocal !== undefined) process.env.UNBROWSE_LOCAL_ONLY = prevLocal;
      delete process.env.UNBROWSE_REVENG_TIMEOUT;
    }
  });
});
