import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, rmSync, existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  hashValue,
  safeBindingNames,
  anonymizeUrl,
  hashResponseBody,
  classifyFailure,
  emitRouteTrace,
  isTracingEnabled,
} from "../src/telemetry.js";

// ---------------------------------------------------------------------------
// Unit tests for pure utility functions
// ---------------------------------------------------------------------------

describe("hashValue", () => {
  it("returns a 16-char hex string", () => {
    const h = hashValue("secret-value");
    expect(h).toMatch(/^[0-9a-f]{16}$/);
  });

  it("is deterministic", () => {
    expect(hashValue("foo")).toBe(hashValue("foo"));
  });

  it("differs for different inputs", () => {
    expect(hashValue("a")).not.toBe(hashValue("b"));
  });
});

describe("safeBindingNames", () => {
  it("strips sensitive keys", () => {
    const bindings = {
      query: "hotels",
      auth_token: "secret",
      cookie: "session=x",
      api_key: "key123",
      city: "London",
      password: "hunter2",
    };
    const safe = safeBindingNames(bindings);
    expect(safe).toContain("query");
    expect(safe).toContain("city");
    expect(safe).not.toContain("auth_token");
    expect(safe).not.toContain("cookie");
    expect(safe).not.toContain("api_key");
    expect(safe).not.toContain("password");
  });

  it("returns empty array for all-sensitive bindings", () => {
    expect(safeBindingNames({ token: "x", cookie: "y" })).toEqual([]);
  });

  it("returns all keys when none are sensitive", () => {
    const b = { q: "1", limit: "10" };
    expect(safeBindingNames(b)).toEqual(["q", "limit"]);
  });
});

describe("anonymizeUrl", () => {
  it("strips query string", () => {
    expect(anonymizeUrl("https://example.com/search?q=secret&page=2"))
      .toBe("https://example.com/search");
  });

  it("strips fragment", () => {
    expect(anonymizeUrl("https://example.com/page#section"))
      .toBe("https://example.com/page");
  });

  it("preserves origin + path", () => {
    expect(anonymizeUrl("https://api.example.com/v1/hotels/123"))
      .toBe("https://api.example.com/v1/hotels/123");
  });
});

describe("hashResponseBody", () => {
  it("returns a 32-char hex string", () => {
    const h = hashResponseBody({ results: [1, 2, 3] });
    expect(h).toMatch(/^[0-9a-f]{32}$/);
  });

  it("is consistent for the same input", () => {
    const obj = { data: "same" };
    expect(hashResponseBody(obj)).toBe(hashResponseBody(obj));
  });

  it("differs for different inputs", () => {
    expect(hashResponseBody("a")).not.toBe(hashResponseBody("b"));
  });
});

describe("classifyFailure", () => {
  it("classifies auth errors", () => {
    expect(classifyFailure("401 Unauthorized")).toBe("auth_failed");
    expect(classifyFailure("auth token missing")).toBe("auth_failed");
  });

  it("classifies timeout errors", () => {
    expect(classifyFailure("request timed out")).toBe("timeout");
    expect(classifyFailure("Operation timeout")).toBe("timeout");
  });

  it("classifies schema mismatch", () => {
    expect(classifyFailure("schema mismatch detected")).toBe("schema_mismatch");
  });

  it("classifies robots disallowed", () => {
    expect(classifyFailure("robots_txt_disallowed: /search")).toBe("robots_disallowed");
  });

  it("classifies empty response", () => {
    expect(classifyFailure("empty response from endpoint")).toBe("empty_response");
  });

  it("returns unknown for unrecognized errors", () => {
    expect(classifyFailure("some random error")).toBe("unknown");
    expect(classifyFailure(undefined)).toBe("unknown");
  });
});

// ---------------------------------------------------------------------------
// emitRouteTrace — writes and reads artifacts
// ---------------------------------------------------------------------------

const TEST_TRACE_DIR = join(process.cwd(), ".test-traces-telemetry");

describe("emitRouteTrace", () => {
  beforeEach(() => {
    process.env.UNBROWSE_TRACES_DIR = TEST_TRACE_DIR;
    process.env.UNBROWSE_DISABLE_TRACES = "";
    if (existsSync(TEST_TRACE_DIR)) rmSync(TEST_TRACE_DIR, { recursive: true });
  });

  afterEach(() => {
    if (existsSync(TEST_TRACE_DIR)) rmSync(TEST_TRACE_DIR, { recursive: true });
    delete process.env.UNBROWSE_TRACES_DIR;
    delete process.env.UNBROWSE_DISABLE_TRACES;
  });

  it("writes a positive trace file on success", () => {
    const file = emitRouteTrace({
      trace_id: "test-trace-001",
      session_scope: "global",
      goal: "search hotels in Paris",
      domain: "booking.com",
      started_at: new Date().toISOString(),
      skill_id: "skill-booking",
      endpoint_id: "ep-search",
      source: "marketplace",
      status_code: 200,
      response_bytes: 512,
      result: { hotels: [{ name: "Hotel A" }] },
      schema_match: true,
      candidates_considered: 3,
      bindings_before: { query: "hotels Paris", city: "Paris" },
      bindings_resolved: { query: "hotels Paris" },
      bindings_missing: [],
      outcome: "success",
    });

    expect(file).toBeTruthy();
    expect(existsSync(file!)).toBe(true);

    const artifact = JSON.parse(readFileSync(file!, "utf-8"));
    expect(artifact.outcome).toBe("success");
    expect(artifact.trace_id).toBe("test-trace-001");
    expect(artifact.goal).toBe("search hotels in Paris");
    expect(artifact.domain).toBe("booking.com");
    expect(artifact.skill_id).toBe("skill-booking");
    expect(artifact.status_code).toBe(200);
    expect(artifact.response_hash).toMatch(/^[0-9a-f]{32}$/);
    // Sensitive bindings must be stripped
    expect(artifact.bindings_before).not.toContain("auth_token");
    expect(artifact.failure_reason).toBeUndefined();
  });

  it("writes a negative trace file on failure", () => {
    const file = emitRouteTrace({
      trace_id: "test-trace-002",
      session_scope: "global",
      goal: "get account details",
      domain: "example.com",
      started_at: new Date().toISOString(),
      source: "marketplace",
      response_bytes: 0,
      candidates_considered: 1,
      bindings_before: { auth_token: "bearer xyz", user_id: "123" },
      bindings_resolved: {},
      bindings_missing: ["user_id"],
      outcome: "failure",
      error: "401 Unauthorized — auth token missing",
    });

    expect(file).toBeTruthy();
    const artifact = JSON.parse(readFileSync(file!, "utf-8"));
    expect(artifact.outcome).toBe("failure");
    expect(artifact.failure_reason).toBe("auth_failed");
    // Auth token must be stripped from bindings_before
    expect(artifact.bindings_before).not.toContain("auth_token");
    // Non-sensitive binding names can appear
    expect(artifact.bindings_missing).not.toContain("auth_token");
  });

  it("does not write when UNBROWSE_DISABLE_TRACES=1", () => {
    process.env.UNBROWSE_DISABLE_TRACES = "1";
    const file = emitRouteTrace({
      trace_id: "test-trace-003",
      session_scope: "global",
      goal: "list products",
      domain: "shop.com",
      started_at: new Date().toISOString(),
      source: "marketplace",
      response_bytes: 100,
      candidates_considered: 2,
      bindings_before: {},
      bindings_resolved: {},
      bindings_missing: [],
      outcome: "success",
    });

    expect(file).toBeNull();
    expect(existsSync(TEST_TRACE_DIR)).toBe(false);
  });

  it("creates separate files for separate calls", () => {
    const base = { session_scope: "global", goal: "test", domain: "x.com", started_at: new Date().toISOString(), source: "marketplace" as const, response_bytes: 0, candidates_considered: 0, bindings_before: {}, bindings_resolved: {}, bindings_missing: [], outcome: "skip" as const };
    emitRouteTrace({ ...base, trace_id: "t1" });
    emitRouteTrace({ ...base, trace_id: "t2" });
    const files = readdirSync(TEST_TRACE_DIR);
    expect(files.length).toBe(2);
  });

  it("never stores raw result bodies — only a hash", () => {
    const sensitiveResult = { password: "hunter2", creditCard: "4111-1111-1111-1111" };
    const file = emitRouteTrace({
      trace_id: "test-trace-004",
      session_scope: "global",
      goal: "get profile",
      domain: "myapp.com",
      started_at: new Date().toISOString(),
      source: "marketplace",
      response_bytes: 200,
      result: sensitiveResult,
      candidates_considered: 1,
      bindings_before: {},
      bindings_resolved: {},
      bindings_missing: [],
      outcome: "success",
    });

    const raw = readFileSync(file!, "utf-8");
    // The file must not contain the raw sensitive values
    expect(raw).not.toContain("hunter2");
    expect(raw).not.toContain("4111-1111-1111-1111");
    // But it must contain a hash
    const artifact = JSON.parse(raw);
    expect(artifact.response_hash).toMatch(/^[0-9a-f]{32}$/);
  });
});
