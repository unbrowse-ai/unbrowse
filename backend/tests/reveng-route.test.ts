// Backend test: POST /v1/reveng — server-side reverse-engineering of an
// OBFUSCATED capture into endpoint specs (the backend-reveng node).
//
// Two layers, no mocks:
//   1. The backend can CONSUME the reveng + obfuscation engines from src/ and
//      derive endpoint specs from an obfuscated capture — proving the
//      reverse-engineering runs SERVER-SIDE and the server never sees a secret
//      (defensive re-obfuscation strips any raw secret a misbehaving client
//      sends, before extraction touches it).
//   2. The route is mounted on the app — app.fetch reaches the handler (the
//      auth gate rejects an unauthenticated call, proving the route is wired
//      into /v1, not a 404).

import { describe, test, expect } from "bun:test";
import { app } from "../src/index.js";
import { revengObfuscatedCapture } from "../src/routes/reveng.js";
import type { RawRequest } from "../../../src/capture/index.js";

const SECRET_BEARER = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NSJ9.sig_abc123_secret";
const SECRET_KEY = "sk-proj-AbCdEf0123456789AbCdEf0123456789";

// A RAW capture that still carries secrets — the worst case (a misbehaving
// client). The server must strip them before reveng.
const RAW_CAPTURE: RawRequest[] = [{
  url: `https://api.example.com/v1/orders?api_key=${SECRET_KEY}&page=2`,
  method: "POST",
  request_headers: { authorization: `Bearer ${SECRET_BEARER}`, "content-type": "application/json" },
  request_body: JSON.stringify({ password: "hunter2-very-secret", item_id: 42 }),
  response_status: 200,
  response_headers: { "content-type": "application/json" },
  response_body: JSON.stringify({ token: "tok_secret_value_99", order_id: 7788 }),
  timestamp: "2026-06-02T00:00:00Z",
}];

describe("server-side reveng derives a spec from a capture WITHOUT seeing secrets", () => {
  test("revengObfuscatedCapture returns endpoint specs", () => {
    const endpoints = revengObfuscatedCapture(RAW_CAPTURE);
    expect(Array.isArray(endpoints)).toBe(true);
    expect(endpoints.length).toBeGreaterThan(0);
    const ep = endpoints[0]!;
    expect(ep.method).toBe("POST");
    expect(String(ep.url_template)).toContain("api.example.com");
  });

  test("defensive re-obfuscation: NO secret value survives into the derived spec", () => {
    const endpoints = revengObfuscatedCapture(RAW_CAPTURE);
    const blob = JSON.stringify(endpoints);
    expect(blob).not.toContain(SECRET_BEARER);
    expect(blob).not.toContain(SECRET_KEY);
    expect(blob).not.toContain("hunter2");
    expect(blob).not.toContain("tok_secret_value_99");
    expect(blob).not.toContain("sk-proj-");
  });

  test("structure survives — the reveng still gets a usable route template", () => {
    const ep = revengObfuscatedCapture(RAW_CAPTURE)[0]!;
    expect(String(ep.url_template)).toContain("/v1/orders");
    expect(ep.method).toBe("POST");
  });
});

describe("/v1/reveng route is mounted", () => {
  const baseEnv = {} as Parameters<typeof app.fetch>[1];

  test("route exists — unauthenticated POST is rejected by the auth gate, not 404", async () => {
    const res = await app.fetch(
      new Request("http://local.test/v1/reveng", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ capture: RAW_CAPTURE }),
      }),
      baseEnv,
    );
    expect(res.status).not.toBe(404);
  });

  test("GET on the route path is not the POST handler (method-scoped mount)", async () => {
    const res = await app.fetch(
      new Request("http://local.test/v1/reveng", { method: "GET" }),
      baseEnv,
    );
    expect(res.status).not.toBe(200);
  });
});
