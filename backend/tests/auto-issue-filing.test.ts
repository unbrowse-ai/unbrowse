/**
 * Tests for telemetry-driven auto issue filing pipeline (issue #228).
 *
 * Covers:
 *   - shouldFileIssue threshold gate (pure)
 *   - buildReproBundle shape (pure)
 *   - buildIssueTemplate shape (pure)
 *   - POST /v1/issues/auto-file route wiring
 *
 * Run:
 *   bun test backend/tests/auto-issue-filing.test.ts
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  shouldFileIssue,
  buildReproBundle,
  buildIssueTemplate,
  ISSUE_FILING_THRESHOLD,
} from "../src/services/issues.js";
import { statsKV } from "../src/services/kv.js";
import app from "../src/index.js";
import type { Env } from "../src/types.js";

// ---------------------------------------------------------------------------
// Shared test env + in-memory KV via EDB mock fetch
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
// POST /v1/issues/auto-file route integration tests
// ---------------------------------------------------------------------------

describe("POST /v1/issues/auto-file", () => {
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

  it("returns 400 when required fields are missing", async () => {
    const res = await app.fetch(
      new Request("http://local.test/v1/issues/auto-file", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: "Bearer admin" },
        body: JSON.stringify({ skill_id: "s1" }), // missing endpoint_id, errors
      }),
      env,
      { waitUntil: () => {} } as ExecutionContext,
    );
    expect(res.status).toBe(400);
  });

  it("returns skipped when error count is below threshold", async () => {
    const errors = Array.from({ length: ISSUE_FILING_THRESHOLD - 1 }, (_, i) => ({
      message: "HTTP 500",
      trace_id: `t-${i}`,
      timestamp: new Date().toISOString(),
    }));

    const res = await app.fetch(
      new Request("http://local.test/v1/issues/auto-file", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: "Bearer admin" },
        body: JSON.stringify({
          skill_id: "skill-1",
          endpoint_id: "ep-1",
          intent: "search products",
          errors,
        }),
      }),
      env,
      { waitUntil: () => {} } as ExecutionContext,
    );
    expect(res.status).toBe(200);
    const body = await res.json() as { filed: boolean };
    expect(body.filed).toBe(false);
  });

  it("files an issue when error count meets threshold", async () => {
    const errors = Array.from({ length: ISSUE_FILING_THRESHOLD }, (_, i) => ({
      message: "HTTP 500",
      trace_id: `t-${i}`,
      timestamp: new Date().toISOString(),
    }));

    const res = await app.fetch(
      new Request("http://local.test/v1/issues/auto-file", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: "Bearer admin" },
        body: JSON.stringify({
          skill_id: "skill-af",
          endpoint_id: "ep-af",
          intent: "lookup data",
          errors,
        }),
      }),
      env,
      { waitUntil: () => {} } as ExecutionContext,
    );
    expect(res.status).toBe(201);
    const body = await res.json() as { filed: boolean; issue: { issue_id: string; description: string } };
    expect(body.filed).toBe(true);
    expect(body.issue).toBeDefined();
    expect(body.issue.issue_id).toBeDefined();

    // Verify the issue was persisted in KV
    const idxRaw = await statsKV(env).get("issue-idx:skill-af");
    expect(idxRaw).not.toBeNull();
    const ids = JSON.parse(idxRaw as string) as string[];
    expect(ids.length).toBeGreaterThanOrEqual(1);
  });

  it("filed issue contains repro bundle details in description", async () => {
    const errors = Array.from({ length: ISSUE_FILING_THRESHOLD }, (_, i) => ({
      message: "timeout after 30s",
      trace_id: `trace-${i}`,
      timestamp: new Date().toISOString(),
    }));

    const res = await app.fetch(
      new Request("http://local.test/v1/issues/auto-file", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: "Bearer admin" },
        body: JSON.stringify({
          skill_id: "skill-detail",
          endpoint_id: "ep-detail",
          intent: "find items",
          errors,
        }),
      }),
      env,
      { waitUntil: () => {} } as ExecutionContext,
    );
    expect(res.status).toBe(201);
    const body = await res.json() as { issue: { description: string; endpoint_id: string; category: string } };
    expect(body.issue.description).toContain("ep-detail");
    expect(body.issue.description).toContain("skill-detail");
    expect(body.issue.description).toContain("find items");
    expect(body.issue.endpoint_id).toBe("ep-detail");
    expect(body.issue.category).toBe("broken");
  });

  it("returns 401 without auth", async () => {
    const res = await app.fetch(
      new Request("http://local.test/v1/issues/auto-file", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          skill_id: "s",
          endpoint_id: "e",
          intent: "",
          errors: [{ message: "err", trace_id: "t", timestamp: new Date().toISOString() }],
        }),
      }),
      env,
      { waitUntil: () => {} } as ExecutionContext,
    );
    expect(res.status).toBe(401);
  });
});
