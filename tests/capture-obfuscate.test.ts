/**
 * obfuscateCaptureForReveng — the foundation of "browse with credentials fully
 * obfuscated, let the backend reverse-engineer the route". Proves every secret
 * VALUE is redacted while the reveng-able STRUCTURE survives (so a backend
 * reveng never sees the agent's secrets but can still derive the endpoint).
 */
import { describe, it, expect } from "bun:test";
import { obfuscateCaptureForReveng } from "../src/capture/obfuscate.js";
import { extractEndpoints } from "../backend/src/services/reverse-engineer/index.js";
import type { RawRequest } from "../src/capture/index.js";

const SECRETS = {
  bearer: "eyJhbGciOiJIUzI1Ni"+"J9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abc123signature456",
  cookie: "sessionid=supersecretsession9999; csrf=tok_aBcDeF123456",
  apiKey: "sk-proj-AbCdEf0123456789AbCdEf0123456789",
  password: "hunter2-very-secret",
  email: "alice@private.example.com",
  respToken: "ghp"+"_AbCdEf0123456789AbCdEf0123456789AbCd",
  uuid: "550e8400-e29b-41d4-a716-446655440000",
};

const CAP: RawRequest[] = [{
  url: `https://api.example.com/v1/users/${SECRETS.uuid}/orders?api_key=${SECRETS.apiKey}&page=2`,
  method: "POST",
  request_headers: { authorization: `Bearer ${SECRETS.bearer}`, cookie: SECRETS.cookie, "content-type": "application/json", accept: "application/json" },
  request_body: JSON.stringify({ password: SECRETS.password, email: SECRETS.email, item_id: 42, quantity: 3 }),
  response_status: 200,
  response_headers: { "set-cookie": `auth=${SECRETS.bearer}; HttpOnly`, "content-type": "application/json" },
  response_body: JSON.stringify({ token: SECRETS.respToken, user: { id: SECRETS.uuid, email: SECRETS.email }, order_id: 7788 }),
  timestamp: "2026-06-02T00:00:00Z",
}];

describe("obfuscateCaptureForReveng — secrets out, structure in", () => {
  const out = obfuscateCaptureForReveng(CAP);
  const blob = JSON.stringify(out);

  it("redacts EVERY secret value (none survive anywhere)", () => {
    for (const [label, secret] of Object.entries(SECRETS)) {
      // the email/uuid get replaced by safe placeholders; assert the ORIGINAL is gone
      expect(blob.includes(secret)).toBe(false);
    }
    // and the obvious raw fragments
    expect(blob).not.toContain("hunter2");
    expect(blob).not.toContain("supersecretsession");
    expect(blob).not.toContain("sk-proj-");
    expect(blob).not.toContain("ghp_");
    expect(blob).not.toContain("alice@private");
  });

  it("preserves reveng-able STRUCTURE (route, method, header + field names, schema)", () => {
    const r = out[0]!;
    expect(r.method).toBe("POST");
    expect(r.url).toContain("api.example.com/v1/users/");
    expect(r.url).toContain("/orders");             // route shape kept
    expect(r.url).toContain("{id}");                // the uuid path segment -> {id}
    expect(r.url).toContain("page=2");              // non-secret query kept
    expect(Object.keys(r.request_headers)).toContain("authorization"); // header NAME kept
    expect(Object.keys(r.request_headers)).toContain("content-type");
    // body param NAMES + non-secret values kept; secret values redacted
    const body = JSON.parse(r.request_body!);
    expect(Object.keys(body).sort()).toEqual(["email", "item_id", "password", "quantity"]);
    expect(body.item_id).toBe(42);
    expect(body.quantity).toBe(3);
    expect(String(body.password)).not.toBe(SECRETS.password);
    // response schema (field names) kept
    const resp = JSON.parse(r.response_body!);
    expect(Object.keys(resp).sort()).toEqual(["order_id", "token", "user"]);
    expect(resp.order_id).toBe(7788);
  });

  it("the reverse-engineer still derives an endpoint from the OBFUSCATED capture", () => {
    const endpoints = extractEndpoints(out);
    expect(Array.isArray(endpoints)).toBe(true);
    expect(endpoints.length).toBeGreaterThan(0);
    const ep = endpoints[0]!;
    expect(ep.method).toBe("POST");
    expect(ep.url_template).toContain("api.example.com");
    // crucially: no secret leaked into the derived endpoint either
    expect(JSON.stringify(ep)).not.toContain("hunter2");
    expect(JSON.stringify(ep)).not.toContain(SECRETS.bearer);
  });
});
