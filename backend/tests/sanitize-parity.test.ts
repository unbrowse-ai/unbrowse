// PARITY FALSIFIER for the ported publish sanitizer.
//
// `backend/src/services/publish-sanitize.ts` is a deliberate dependency-free
// PORT of the canonical client redactors in `src/publish/sanitize.ts` (the
// backend is a Cloudflare Worker with its own tsconfig and no cross-workspace
// imports). The two copies are the "lives in N files, keep in sync" hazard
// from CLAUDE.md. This test is the pin: feed an IDENTICAL fixture through
// BOTH modules and assert deep-equal output. Any redaction drift between
// client and server fails CI here — no heuristic verdict, the falsifier IS
// the equality of two real implementations on real input.
//
// There is no mock: both are the actual exported functions, run on the same
// in-memory object.

import { describe, expect, it } from "bun:test";
import {
  looksLikeSecret as serverLooksLikeSecret,
  redactSecrets as serverRedactSecrets,
  sanitizeForPublish as serverSanitizeForPublish,
} from "../src/services/publish-sanitize.js";
import {
  looksLikeSecret as clientLooksLikeSecret,
  redactSecrets as clientRedactSecrets,
  sanitizeForPublish as clientSanitizeForPublish,
} from "../../src/publish/sanitize.js";
import type { EndpointDescriptor } from "../../src/types/index.js";

// Shared fixture — same shape as tests/sanitize-for-publish.test.ts, with
// extra real-secret payloads to exercise every redaction path.
function fixtureEndpoint(): EndpointDescriptor {
  return {
    endpoint_id: "ep-1",
    method: "GET",
    url_template: "https://api.example.com/search?q={q}&page={page}",
    description: "Search items",
    query: { q: "user secret query", page: "1", api_key: "AKIAIOSFODNN7EXAMPLE" },
    path_params: { id: "12345" },
    headers_template: {
      authorization: "Bearer sk-live-AbCdEf0123456789AbCdEf0123456789",
      cookie: "session_token=eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.QWxpY2U",
      "x-custom": "secret-value",
      accept: "application/json",
    },
    body: { action: "create", name: "Private Name", email: "user@secret.com", password: "supersecret123" },
    body_params: { name: "Private Name" },
    trigger_url: "https://example.com/search?q=secret+query&session=abc123",
    idempotency: "safe",
    verification_status: "verified",
    reliability_score: 0.9,
    semantic: {
      action_kind: "search",
      resource_kind: "item",
      description_in: "Requires q",
      description_out: "Returns items matching query",
      response_summary: "items[].name, items[].id, items[].price",
      example_request: { q: "secret query", page: 1, token: "Bearer sk-secret" },
      example_response_compact: {
        items: [{ name: "User's Private Item", id: 42, price: 9.99, owner_email: "user@secret.com" }],
        total: 100,
      },
      example_fields: ["items[].name", "items[].id", "items[].price"],
      requires: [
        { key: "q", required: true, source: "query", semantic_type: "query_text", example_value: "secret query" },
      ],
      provides: [
        { key: "item_id", source: "response", semantic_type: "item_identifier", example_value: "42" },
      ],
      sample_request_url: "https://api.example.com/search?q=secret+query&page=1",
      negative_tags: [],
      confidence: 0.9,
      observed_at: "2026-04-01T00:00:00.000Z",
    },
  };
}

describe("publish-sanitize parity: backend port == client canonical", () => {
  it("looksLikeSecret agrees across a battery of inputs", () => {
    const cases: Array<[string, unknown]> = [
      ["token", "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkw"],
      ["auth", "Bearer sk-abc123def456ghi789"],
      ["token", "REMOVED_GITHUB_TOKEN"],
      ["key", "sk-abcdefghijklmnopqrstuvwxyz1234567890"],
      ["token", "xoxb-123456789-abcdefghij"],
      ["key", "AKIAIOSFODNN7EXAMPLE"],
      ["password", "myp@ssw0rd"],
      ["api_key", "some-api-key-value"],
      ["session_token", "sess_abc123xyz"],
      ["q", "camellia"],
      ["name", "John"],
      ["page", "1"],
      ["url", "https://example.com"],
      ["password", "short"],
      ["", "AKIAIOSFODNN7EXAMPLE"],
      ["cookie", "session_token=eyJhbGciOiJIUzI1NiJ9.eyJzdWIi.QWxpY2U"],
    ];
    for (const [key, value] of cases) {
      expect(serverLooksLikeSecret(key, value)).toBe(clientLooksLikeSecret(key, value));
    }
  });

  it("redactSecrets produces deep-equal output on a nested secret tree", () => {
    const input = {
      auth: { token: "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkw" },
      query: "normal value",
      password: "supersecret123",
      username: "alice",
      items: [{ api_key: "sk-abcdefghijklmnopqrstuvwxyz" }, { plain: "ok" }],
      nested: { deep: { bearer: "Bearer sk-live-zzzzzzzzzzzzzzzzzzzz" } },
    };
    const serverOut = serverRedactSecrets(structuredClone(input));
    const clientOut = clientRedactSecrets(structuredClone(input));
    expect(serverOut).toEqual(clientOut);
    // And the input is not mutated by either.
    expect(input.password).toBe("supersecret123");
  });

  it("sanitizeForPublish produces byte-identical JSON on the shared fixture", () => {
    const serverOut = serverSanitizeForPublish([fixtureEndpoint() as never]);
    const clientOut = clientSanitizeForPublish([fixtureEndpoint()]);
    expect(JSON.stringify(serverOut)).toBe(JSON.stringify(clientOut));
  });

  it("sanitizeForPublish strips every fixture secret (both implementations)", () => {
    for (const sanitize of [
      () => serverSanitizeForPublish([fixtureEndpoint() as never]),
      () => clientSanitizeForPublish([fixtureEndpoint()]),
    ]) {
      const s = JSON.stringify(sanitize());
      expect(s).not.toContain("sk-live-AbCdEf0123456789");
      expect(s).not.toContain("AKIAIOSFODNN7EXAMPLE");
      expect(s).not.toContain("eyJhbGciOiJIUzI1NiJ9.eyJzdWIi");
      expect(s).not.toContain("supersecret123");
      expect(s).not.toContain("User's Private Item");
      expect(s).not.toContain("user@secret.com");
      expect(s).not.toContain("secret query");
    }
  });
});
