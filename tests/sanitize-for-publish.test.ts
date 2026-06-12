import { describe, expect, it } from "bun:test";
import { sanitizeForPublish, looksLikeSecret, redactSecrets } from "../src/publish/sanitize.js";
import type { EndpointDescriptor } from "../src/types/index.js";

function makeEndpoint(overrides: Partial<EndpointDescriptor> = {}): EndpointDescriptor {
  return {
    endpoint_id: "ep-1",
    method: "GET",
    url_template: "https://api.example.com/search?q={q}&page={page}",
    description: "Search items",
    query: { q: "user secret query", page: "1" },
    path_params: { id: "12345" },
    headers_template: { "x-custom": "secret-value", accept: "application/json" },
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
      example_request: { q: "secret query", page: 1 },
      example_response_compact: {
        items: [
          { name: "User's Private Item", id: 42, price: 9.99, owner_email: "user@secret.com" },
        ],
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
    ...overrides,
  };
}

describe("looksLikeSecret", () => {
  it("detects JWTs", () => {
    expect(looksLikeSecret("token", "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkw")).toBe(true);
  });

  it("detects Bearer tokens", () => {
    expect(looksLikeSecret("auth", "Bearer sk-abc123def456ghi789")).toBe(true);
  });

  it("detects GitHub PATs", () => {
    expect(looksLikeSecret("token", "ghp"+"_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghij")).toBe(true);
  });

  it("detects OpenAI keys", () => {
    expect(looksLikeSecret("key", "sk-abcdefghijklmnopqrstuvwxyz1234567890")).toBe(true);
  });

  it("detects Slack tokens", () => {
    expect(looksLikeSecret("token", "xoxb"+"-123456789-abcdefghij")).toBe(true);
  });

  it("detects AWS access keys", () => {
    expect(looksLikeSecret("key", "AKIA"+"IOSFODNN7EXAMPLE")).toBe(true);
  });

  it("detects by key name: password", () => {
    expect(looksLikeSecret("password", "myp@ssw0rd")).toBe(true);
  });

  it("detects by key name: api_key", () => {
    expect(looksLikeSecret("api_key", "some-api-key-value")).toBe(true);
  });

  it("detects by key name: session_token", () => {
    expect(looksLikeSecret("session_token", "sess_abc123xyz")).toBe(true);
  });

  it("does not flag normal values", () => {
    expect(looksLikeSecret("q", "camellia")).toBe(false);
    expect(looksLikeSecret("name", "John")).toBe(false);
    expect(looksLikeSecret("page", "1")).toBe(false);
    expect(looksLikeSecret("url", "https://example.com")).toBe(false);
  });

  it("does not flag short values even with secret key names", () => {
    expect(looksLikeSecret("password", "short")).toBe(false);
  });
});

describe("redactSecrets", () => {
  it("redacts JWT in nested object", () => {
    const result = redactSecrets({
      auth: { token: "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkw" },
      query: "normal value",
    });
    expect((result as Record<string, unknown>).query).toBe("normal value");
    expect(((result as Record<string, Record<string, unknown>>).auth).token).toBe("[REDACTED]");
  });

  it("redacts password fields", () => {
    const result = redactSecrets({ password: "supersecret123", username: "alice" });
    expect((result as Record<string, unknown>).password).toBe("[REDACTED]");
    expect((result as Record<string, unknown>).username).toBe("alice");
  });

  it("redacts secrets in arrays", () => {
    const result = redactSecrets({ items: [{ api_key: "sk-abcdefghijklmnopqrstuvwxyz" }] });
    expect(((result as Record<string, unknown[]>).items[0] as Record<string, unknown>).api_key).toBe("[REDACTED]");
  });

  it("does not mutate input", () => {
    const original = { password: "supersecret123" };
    redactSecrets(original);
    expect(original.password).toBe("supersecret123");
  });
});

describe("sanitizeForPublish", () => {
  it("replaces query values with generic placeholders", () => {
    const [clean] = sanitizeForPublish([makeEndpoint()]);
    expect(clean.query).toEqual({ q: "example", page: "example" });
  });

  it("replaces path_params with generic placeholders", () => {
    const [clean] = sanitizeForPublish([makeEndpoint()]);
    expect(clean.path_params).toEqual({ id: "example" });
  });

  it("removes headers_template entirely — no keys or values published to marketplace", () => {
    const [clean] = sanitizeForPublish([makeEndpoint()]);
    expect(clean.headers_template).toBeUndefined();
  });

  it("strips trigger_url query params", () => {
    const [clean] = sanitizeForPublish([makeEndpoint()]);
    expect(clean.trigger_url).toBe("https://example.com/search");
  });

  it("synthesizes example_response_compact instead of deleting", () => {
    const [clean] = sanitizeForPublish([makeEndpoint()]);
    const resp = clean.semantic?.example_response_compact as Record<string, unknown>;
    expect(resp).toBeDefined();
    // Structure preserved — items array with objects
    expect(resp.items).toBeDefined();
    expect(Array.isArray(resp.items)).toBe(true);
    const item = (resp.items as unknown[])[0] as Record<string, unknown>;
    // Real values replaced — no "User's Private Item" or "user@secret.com"
    expect(item.name).not.toBe("User's Private Item");
    expect(item.owner_email).toBe("user@example.com"); // email → placeholder
    expect(typeof item.id).toBe("number"); // number preserved as number
    expect(typeof item.price).toBe("number");
  });

  it("synthesizes example_request instead of deleting", () => {
    const [clean] = sanitizeForPublish([makeEndpoint()]);
    const req = clean.semantic?.example_request as Record<string, unknown>;
    expect(req).toBeDefined();
    expect(req.q).toBeDefined(); // key preserved
    expect(req.q).not.toBe("secret query"); // value replaced
    expect(typeof req.page).toBe("number"); // type preserved
  });

  it("replaces sample_request_url query param values", () => {
    const [clean] = sanitizeForPublish([makeEndpoint()]);
    const url = clean.semantic?.sample_request_url;
    expect(url).toBeDefined();
    expect(url).toContain("q=example");
    expect(url).toContain("page=example");
    expect(url).not.toContain("secret");
  });

  it("strips example_value from requires/provides bindings", () => {
    const [clean] = sanitizeForPublish([makeEndpoint()]);
    expect((clean.semantic?.requires?.[0] as Record<string, unknown>).example_value).toBeUndefined();
    expect((clean.semantic?.provides?.[0] as Record<string, unknown>).example_value).toBeUndefined();
  });

  it("preserves safe semantic fields", () => {
    const [clean] = sanitizeForPublish([makeEndpoint()]);
    expect(clean.semantic?.action_kind).toBe("search");
    expect(clean.semantic?.resource_kind).toBe("item");
    expect(clean.semantic?.description_out).toBe("Returns items matching query");
    expect(clean.semantic?.example_fields).toEqual(["items[].name", "items[].id", "items[].price"]);
    expect(clean.semantic?.confidence).toBe(0.9);
  });

  it("preserves url_template, method, description", () => {
    const [clean] = sanitizeForPublish([makeEndpoint()]);
    expect(clean.url_template).toBe("https://api.example.com/search?q={q}&page={page}");
    expect(clean.method).toBe("GET");
    expect(clean.description).toBe("Search items");
  });

  it("synthesizes body instead of blanking", () => {
    const [clean] = sanitizeForPublish([makeEndpoint({
      body: { action: "create", name: "Private Name", email: "user@secret.com" },
      body_params: { name: "Private Name" },
    })]);
    const body = clean.body as Record<string, unknown>;
    expect(body.action).toBeDefined();
    expect(body.email).toBe("user@example.com");
    expect(body.name).not.toBe("Private Name");
  });

  it("handles endpoints with no semantic/query/headers", () => {
    const [clean] = sanitizeForPublish([makeEndpoint({
      semantic: undefined,
      query: undefined,
      headers_template: undefined,
      trigger_url: undefined,
      path_params: undefined,
    })]);
    expect(clean.semantic).toBeUndefined();
    expect(clean.query).toBeUndefined();
    expect(clean.headers_template).toBeUndefined();
  });

  it("does not mutate the original endpoint", () => {
    const original = makeEndpoint();
    const originalQuery = { ...original.query as Record<string, string> };
    sanitizeForPublish([original]);
    expect(original.query).toEqual(originalQuery);
    expect(original.semantic?.example_response_compact).toBeDefined();
  });
});
