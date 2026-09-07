import { describe, expect, it, beforeEach, afterAll } from "bun:test";
import { mkdirSync, rmSync, existsSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { storeExecutionTrace, getRecentTraces, findTracesByIntent, getTraceStorePath } from "../src/lib/graph-core/trace-store.js";
import type { StoredTrace } from "../src/lib/graph-core/trace-store.js";

const TEST_DIR = join(tmpdir(), `unbrowse-trace-test-${Date.now()}`);

function makeTrace(overrides: Partial<StoredTrace> = {}): StoredTrace {
  return {
    trace_id: `trace-${Math.random().toString(36).slice(2, 8)}`,
    domain: "example.com",
    intent: "search products",
    endpoint_sequence: ["ep-1", "ep-2"],
    selected_endpoint_id: "ep-1",
    params: { query: "shoes" },
    success: true,
    timestamp: new Date().toISOString(),
    ...overrides,
  };
}

beforeEach(() => {
  // Clean and recreate test directory
  if (existsSync(TEST_DIR)) {
    rmSync(TEST_DIR, { recursive: true });
  }
  mkdirSync(TEST_DIR, { recursive: true });
  process.env.UNBROWSE_TRACE_STORE_DIR = TEST_DIR;
});

afterAll(() => {
  if (existsSync(TEST_DIR)) {
    rmSync(TEST_DIR, { recursive: true });
  }
  delete process.env.UNBROWSE_TRACE_STORE_DIR;
});

describe("trace-store", () => {
  it("storeExecutionTrace creates JSONL file", () => {
    const trace = makeTrace({ domain: "example.com" });
    storeExecutionTrace(trace);

    const filePath = join(TEST_DIR, "example.com.jsonl");
    expect(existsSync(filePath)).toBe(true);

    const content = readFileSync(filePath, "utf-8");
    const lines = content.trim().split("\n");
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0])).toEqual(trace);
  });

  it("getRecentTraces returns traces in most-recent-first order", () => {
    const trace1 = makeTrace({ trace_id: "t1", domain: "example.com", timestamp: "2025-01-01T00:00:00Z" });
    const trace2 = makeTrace({ trace_id: "t2", domain: "example.com", timestamp: "2025-01-02T00:00:00Z" });
    const trace3 = makeTrace({ trace_id: "t3", domain: "example.com", timestamp: "2025-01-03T00:00:00Z" });

    storeExecutionTrace(trace1);
    storeExecutionTrace(trace2);
    storeExecutionTrace(trace3);

    const recent = getRecentTraces("example.com");
    expect(recent).toHaveLength(3);
    // Most recent first (reversed from file order)
    expect(recent[0].trace_id).toBe("t3");
    expect(recent[1].trace_id).toBe("t2");
    expect(recent[2].trace_id).toBe("t1");
  });

  it("findTracesByIntent matches substring", () => {
    storeExecutionTrace(makeTrace({ intent: "search products", domain: "shop.com" }));
    storeExecutionTrace(makeTrace({ intent: "get product details", domain: "shop.com" }));
    storeExecutionTrace(makeTrace({ intent: "list categories", domain: "shop.com" }));

    const results = findTracesByIntent("shop.com", "product");
    expect(results).toHaveLength(2);
    // Both "search products" and "get product details" contain "product"
    const intents = results.map((t) => t.intent);
    expect(intents).toContain("search products");
    expect(intents).toContain("get product details");
  });

  it("findTracesByIntent is case-insensitive", () => {
    storeExecutionTrace(makeTrace({ intent: "Search Products", domain: "shop.com" }));
    storeExecutionTrace(makeTrace({ intent: "FIND products", domain: "shop.com" }));

    const results = findTracesByIntent("shop.com", "search products");
    expect(results).toHaveLength(1);
    expect(results[0].intent).toBe("Search Products");

    // Also test uppercase query against lowercase stored intent
    storeExecutionTrace(makeTrace({ intent: "search items", domain: "shop.com" }));
    const results2 = findTracesByIntent("shop.com", "SEARCH");
    expect(results2).toHaveLength(2);
  });

  it("missing domain file returns empty array", () => {
    const recent = getRecentTraces("nonexistent-domain.com");
    expect(recent).toEqual([]);

    const found = findTracesByIntent("nonexistent-domain.com", "anything");
    expect(found).toEqual([]);
  });

  it("domain normalization strips www. and lowercases", () => {
    storeExecutionTrace(makeTrace({ domain: "www.Example.COM", trace_id: "t1" }));
    storeExecutionTrace(makeTrace({ domain: "example.com", trace_id: "t2" }));

    // Both should go to the same file
    const filePath = join(TEST_DIR, "example.com.jsonl");
    expect(existsSync(filePath)).toBe(true);

    const recent = getRecentTraces("example.com");
    expect(recent).toHaveLength(2);

    // Querying with www. prefix should also work
    const recentWww = getRecentTraces("www.example.com");
    expect(recentWww).toHaveLength(2);

    // Querying with uppercase should also work
    const recentUpper = getRecentTraces("EXAMPLE.COM");
    expect(recentUpper).toHaveLength(2);
  });

  it("limit parameter works", () => {
    for (let i = 0; i < 10; i++) {
      storeExecutionTrace(makeTrace({ trace_id: `t${i}`, domain: "many.com" }));
    }

    const limited = getRecentTraces("many.com", 3);
    expect(limited).toHaveLength(3);
    // Should be the 3 most recent (last appended = most recent)
    expect(limited[0].trace_id).toBe("t9");
    expect(limited[1].trace_id).toBe("t8");
    expect(limited[2].trace_id).toBe("t7");

    const intentLimited = findTracesByIntent("many.com", "search", 2);
    expect(intentLimited).toHaveLength(2);
  });

  it("malformed JSONL lines are skipped", () => {
    const filePath = join(TEST_DIR, "broken.com.jsonl");
    const validTrace = makeTrace({ domain: "broken.com", trace_id: "valid" });
    const content = [
      JSON.stringify(validTrace),
      "this is not valid json",
      "{malformed",
      JSON.stringify(makeTrace({ domain: "broken.com", trace_id: "also-valid" })),
    ].join("\n") + "\n";
    writeFileSync(filePath, content, "utf-8");

    const recent = getRecentTraces("broken.com");
    expect(recent).toHaveLength(2);
    expect(recent[0].trace_id).toBe("also-valid");
    expect(recent[1].trace_id).toBe("valid");
  });

  it("getTraceStorePath returns the configured directory", () => {
    const path = getTraceStorePath();
    expect(path).toBe(TEST_DIR);
  });

  it("appends multiple traces to the same file", () => {
    storeExecutionTrace(makeTrace({ trace_id: "a", domain: "append.com" }));
    storeExecutionTrace(makeTrace({ trace_id: "b", domain: "append.com" }));
    storeExecutionTrace(makeTrace({ trace_id: "c", domain: "append.com" }));

    const filePath = join(TEST_DIR, "append.com.jsonl");
    const lines = readFileSync(filePath, "utf-8").trim().split("\n");
    expect(lines).toHaveLength(3);
    expect(JSON.parse(lines[0]).trace_id).toBe("a");
    expect(JSON.parse(lines[2]).trace_id).toBe("c");
  });

  it("handles failed traces", () => {
    const failedTrace = makeTrace({
      domain: "fail.com",
      success: false,
      selected_endpoint_id: undefined,
      endpoint_sequence: ["ep-1", "ep-2", "ep-3"],
    });
    storeExecutionTrace(failedTrace);

    const recent = getRecentTraces("fail.com");
    expect(recent).toHaveLength(1);
    expect(recent[0].success).toBe(false);
    expect(recent[0].selected_endpoint_id).toBeUndefined();
    expect(recent[0].endpoint_sequence).toEqual(["ep-1", "ep-2", "ep-3"]);
  });
});
