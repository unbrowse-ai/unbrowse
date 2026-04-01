/**
 * Tests for telemetry-driven auto issue filing pipeline (issue #228).
 *
 * Covers:
 *   - shouldFileIssue threshold gate (pure)
 *   - buildReproBundle shape (pure)
 *   - buildIssueTemplate shape (pure)
 *   - recordExecutionError: buffers errors and files an issue at threshold
 *   - POST /v1/stats/execution: wires recordExecutionError via waitUntil on failure
 *
 * Run:
 *   bun test backend/tests/auto-issue-filing.test.ts
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  shouldFileIssue,
  buildReproBundle,
  buildIssueTemplate,
  recordExecutionError,
  ISSUE_FILING_THRESHOLD,
} from "../src/services/issues.js";
import { statsKV } from "../src/services/kv.js";
import app from "../src/index.js";
import type { Env } from "../src/types.js";

// ---------------------------------------------------------------------------
// Shared test env + in-memory KV mock
// ---------------------------------------------------------------------------

const env: Env = {
  API_KEY: "admin",
  UNKEY_ROOT_KEY: "root",
  UNKEY_API_ID: "api",
  EMERGENTDB_API_KEY: "test",
  NEBIUS_API_KEY: "nebius",
  STATS_KV: {} as KVNamespace,
  ENVIRONMENT: "staging",
};

function createMockFetch(store: Map<string, string>) {
  return async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(
      typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url
    );
    if (url.hostname !== "api.emergentdb.com") {
      throw new Error(`Unexpected fetch to non-emergentdb host: ${url.toString()}`);
    }

    if (url.pathname === "/qdkv/set") {
      const body = JSON.parse(String(init?.body ?? "{}")) as { key: string; value: string };
      store.set(body.key, body.value);
      return Response.json({ ok: true });
    }

    if (url.pathname.startsWith("/qdkv/get/")) {
      const key = decodeURIComponent(url.pathname.replace("/qdkv/get/", ""));
      const value = store.get(key);
      return Response.json(
        value == null ? { found: false, value: null } : { found: true, value }
      );
    }

    if (url.pathname.startsWith("/qdkv/del/")) {
      const key = decodeURIComponent(url.pathname.replace("/qdkv/del/", ""));
      store.delete(key);
      return Response.json({ ok: true });
    }

    throw new Error(`Unexpected fetch: ${url.toString()}`);
  };
}

// ---------------------------------------------------------------------------
// Pure function tests — no KV needed
// ---------------------------------------------------------------------------

describe("shouldFileIssue", () => {
  it("returns false below threshold", () => {
    expect(shouldFileIssue(ISSUE_FILING_THRESHOLD - 1)).toBe(false);
  });

  it("returns true at exactly threshold", () => {
    expect(shouldFileIssue(ISSUE_FILING_THRESHOLD)).toBe(true);
  });

  it("returns true above threshold", () => {
    expect(shouldFileIssue(ISSUE_FILING_THRESHOLD + 5)).toBe(true);
  });
});

describe("buildReproBundle", () => {
  const errors = [
    { message: "HTTP 500", trace_id: "trace-1", timestamp: "2024-01-01T00:00:00.000Z" },
    { message: "HTTP 500", trace_id: "trace-2", timestamp: "2024-01-01T00:01:00.000Z" },
    { message: "timeout",  trace_id: "trace-3", timestamp: "2024-01-01T00:02:00.000Z" },
  ];

  it("populates all fields from error list", () => {
    const bundle = buildReproBundle("skill-abc", "ep-1", errors, "search products");
    expect(bundle.skill_id).toBe("skill-abc");
    expect(bundle.endpoint_id).toBe("ep-1");
    expect(bundle.intent).toBe("search products");
    expect(bundle.error_message).toBe("HTTP 500");
    expect(bundle.error_count).toBe(3);
    expect(bundle.first_seen).toBe("2024-01-01T00:00:00.000Z");
    expect(bundle.last_seen).toBe("2024-01-01T00:02:00.000Z");
    expect(bundle.sample_trace_ids).toEqual(["trace-1", "trace-2", "trace-3"]);
  });

  it("caps sample_trace_ids at 5", () => {
    const manyErrors = Array.from({ length: 10 }, (_, i) => ({
      message: "err",
      trace_id: `t${i}`,
      timestamp: new Date().toISOString(),
    }));
    const bundle = buildReproBundle("s", "e", manyErrors, "");
    expect(bundle.sample_trace_ids.length).toBeLessThanOrEqual(5);
  });
});

describe("buildIssueTemplate", () => {
  it("includes skill, endpoint, intent, and error in body", () => {
    const bundle = buildReproBundle(
      "skill-xyz",
      "ep-search",
      [{ message: "HTTP 500", trace_id: "t1", timestamp: new Date().toISOString() }],
      "find users",
    );
    const tmpl = buildIssueTemplate(bundle);
    expect(tmpl.title).toContain("ep-search");
    expect(tmpl.body).toContain("skill-xyz");
    expect(tmpl.body).toContain("ep-search");
    expect(tmpl.body).toContain("find users");
    expect(tmpl.body).toContain("HTTP 500");
    expect(tmpl.labels).toContain("auto-filed");
    expect(tmpl.labels).toContain("bug");
  });

  it("routes backend errors (500/timeout) to unbrowse-dev repo", () => {
    const bundle500 = buildReproBundle("s", "e",
      [{ message: "HTTP 500 internal", trace_id: "t", timestamp: new Date().toISOString() }], "");
    expect(buildIssueTemplate(bundle500).repo).toBe("unbrowse-ai/unbrowse-dev");

    const bundleTimeout = buildReproBundle("s", "e",
      [{ message: "timeout after 30s", trace_id: "t", timestamp: new Date().toISOString() }], "");
    expect(buildIssueTemplate(bundleTimeout).repo).toBe("unbrowse-ai/unbrowse-dev");
  });

  it("routes non-backend errors to unbrowse repo", () => {
    const bundle = buildReproBundle("s", "e",
      [{ message: "auth required", trace_id: "t", timestamp: new Date().toISOString() }], "");
    expect(buildIssueTemplate(bundle).repo).toBe("unbrowse-ai/unbrowse");
  });
});

// ---------------------------------------------------------------------------
// recordExecutionError integration — uses mock KV fetch
// ---------------------------------------------------------------------------

describe("recordExecutionError", () => {
  const store = new Map<string, string>();
  const originalFetch = globalThis.fetch;

  beforeEach(async () => {
    globalThis.fetch = createMockFetch(store) as typeof fetch;
    store.clear();
    await statsKV(env).resetSplitIndex();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("accumulates errors below threshold without filing an issue", async () => {
    for (let i = 0; i < ISSUE_FILING_THRESHOLD - 1; i++) {
      await recordExecutionError(env, "skill-1", "ep-1", "search", "HTTP 500", `trace-${i}`);
    }

    // No issue index should have been created for skill-1
    const issueIdx = await statsKV(env).get("issue-idx:skill-1");
    expect(issueIdx).toBeNull();
  });

  it("files an issue and resets buffer when threshold is reached", async () => {
    for (let i = 0; i < ISSUE_FILING_THRESHOLD; i++) {
      await recordExecutionError(env, "skill-2", "ep-2", "find items", "HTTP 500", `trace-${i}`);
    }

    // An issue should have been filed — issue-idx:skill-2 should exist
    const raw = await statsKV(env).get("issue-idx:skill-2");
    expect(raw).not.toBeNull();
    const ids = JSON.parse(raw as string) as string[];
    expect(ids.length).toBeGreaterThanOrEqual(1);

    // Buffer should be reset to empty
    const buf = await statsKV(env).get("err-buf:skill-2:ep-2");
    expect(buf).not.toBeNull();
    const bufArr = JSON.parse(buf as string) as unknown[];
    expect(bufArr.length).toBe(0);
  });

  it("filed issue body contains repro bundle details", async () => {
    for (let i = 0; i < ISSUE_FILING_THRESHOLD; i++) {
      await recordExecutionError(
        env, "skill-3", "ep-3", "intent text", `error msg ${i}`, `trace-${i}`
      );
    }

    const idxRaw = await statsKV(env).get("issue-idx:skill-3");
    expect(idxRaw).not.toBeNull();
    const [issueId] = JSON.parse(idxRaw as string) as string[];

    const issueRaw = await statsKV(env).get(`issue:skill-3:${issueId}`);
    expect(issueRaw).not.toBeNull();
    const issue = JSON.parse(issueRaw as string) as {
      skill_id: string;
      endpoint_id: string;
      category: string;
      description: string;
      status: string;
    };

    expect(issue.skill_id).toBe("skill-3");
    expect(issue.endpoint_id).toBe("ep-3");
    expect(issue.category).toBe("broken");
    expect(issue.status).toBe("open");
    expect(issue.description).toContain("ep-3");
  });
});

// ---------------------------------------------------------------------------
// Route wiring — POST /v1/stats/execution fires recordExecutionError on failure
// ---------------------------------------------------------------------------

describe("POST /v1/stats/execution auto-issue wiring", () => {
  const store = new Map<string, string>();
  const originalFetch = globalThis.fetch;

  beforeEach(async () => {
    globalThis.fetch = createMockFetch(store) as typeof fetch;
    store.clear();
    await statsKV(env).resetSplitIndex();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  function makeTrace(success: boolean, error?: string) {
    const now = new Date().toISOString();
    return {
      trace_id: `tr-${Math.random().toString(36).slice(2)}`,
      skill_id: "skill-route",
      endpoint_id: "ep-route",
      started_at: now,
      completed_at: now,
      success,
      error,
    };
  }

  it("does not touch the error buffer on successful executions", async () => {
    const res = await app.fetch(
      new Request("http://local.test/v1/stats/execution", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: "Bearer admin" },
        body: JSON.stringify({
          skill_id: "skill-route",
          endpoint_id: "ep-route",
          trace: makeTrace(true),
          intent: "lookup data",
        }),
      }),
      env,
      { waitUntil: () => {} } as ExecutionContext,
    );
    expect(res.status).toBe(200);

    const buf = await statsKV(env).get("err-buf:skill-route:ep-route");
    expect(buf).toBeNull();
  });

  it("buffers a failed execution into the error buffer", async () => {
    const trace = makeTrace(false, "HTTP 503 unavailable");
    const res = await app.fetch(
      new Request("http://local.test/v1/stats/execution", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: "Bearer admin" },
        body: JSON.stringify({
          skill_id: "skill-route",
          endpoint_id: "ep-route",
          trace,
          intent: "search query",
        }),
      }),
      env,
      // Run waitUntil promises synchronously in tests
      { waitUntil: (p: Promise<unknown>) => p } as unknown as ExecutionContext,
    );
    expect(res.status).toBe(200);

    // Give the waitUntil promise a tick to resolve
    await new Promise((r) => setTimeout(r, 0));

    const buf = await statsKV(env).get("err-buf:skill-route:ep-route");
    expect(buf).not.toBeNull();
    const arr = JSON.parse(buf as string) as Array<{ message: string }>;
    expect(arr.length).toBe(1);
    expect(arr[0].message).toBe("HTTP 503 unavailable");
  });
});
