import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { stageGithubIssue, type TriageClusterSummary } from "../src/jobs/triage-telemetry.js";
import type { Env } from "../src/types.js";

// Stager unit test — stubs fetch so the github API call is captured without
// hitting the network. The assertions check what the worker sends (title,
// labels, body shape), not literal copy I authored.

const baseCluster: TriageClusterSummary = {
  cluster_key: "abcdef1234567890",
  host_template: "example.com/api/v1/things",
  tool_sequence: ["unbrowse_resolve", "unbrowse_execute"],
  terminal_error_code: "auth_required",
  reflection_status: "failed",
  session_count: 7,
  representative_sessions: ["s1", "s2", "s3"],
  first_seen_at: Date.now() - 3_600_000,
  last_seen_at: Date.now(),
};

let originalFetch: typeof fetch;
let captured: { url: string; init?: RequestInit }[];

beforeEach(() => {
  originalFetch = globalThis.fetch;
  captured = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    captured.push({ url: typeof input === "string" ? input : input.toString(), init });
    return new Response(
      JSON.stringify({ html_url: "https://github.com/unbrowse-ai/unbrowse-dev/issues/123", number: 123 }),
      { status: 201, headers: { "content-type": "application/json" } },
    );
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("stageGithubIssue", () => {
  test("returns undefined when no token configured", async () => {
    const env = {} as Env;
    const result = await stageGithubIssue(env, baseCluster);
    expect(result).toBeUndefined();
    expect(captured.length).toBe(0);
  });

  test("uses GITHUB_TRIAGE_TOKEN when set, falls back to GITHUB_PR_BOT_TOKEN", async () => {
    const env = { GITHUB_TRIAGE_TOKEN: "ghp_triage" } as unknown as Env;
    await stageGithubIssue(env, baseCluster);
    expect(captured.length).toBe(1);
    const headers = captured[0].init?.headers as Record<string, string>;
    expect(headers.Authorization).toBe("token ghp_triage");
  });

  test("falls back to GITHUB_PR_BOT_TOKEN when no triage token", async () => {
    const env = { GITHUB_PR_BOT_TOKEN: "ghp_prbot" } as Env;
    await stageGithubIssue(env, baseCluster);
    expect(captured.length).toBe(1);
    const headers = captured[0].init?.headers as Record<string, string>;
    expect(headers.Authorization).toBe("token ghp_prbot");
  });

  test("POSTs to default repo unbrowse-ai/unbrowse-dev when no override", async () => {
    const env = { GITHUB_TRIAGE_TOKEN: "ghp_x" } as unknown as Env;
    await stageGithubIssue(env, baseCluster);
    expect(captured[0].url).toBe("https://api.github.com/repos/unbrowse-ai/unbrowse-dev/issues");
  });

  test("respects GITHUB_TRIAGE_REPO override", async () => {
    const env = { GITHUB_TRIAGE_TOKEN: "x", GITHUB_TRIAGE_REPO: "foo/bar" } as unknown as Env;
    await stageGithubIssue(env, baseCluster);
    expect(captured[0].url).toBe("https://api.github.com/repos/foo/bar/issues");
  });

  test("issue body carries the cluster evidence and title is derived from data", async () => {
    const env = { GITHUB_TRIAGE_TOKEN: "x" } as unknown as Env;
    const url = await stageGithubIssue(env, baseCluster);
    expect(url).toBe("https://github.com/unbrowse-ai/unbrowse-dev/issues/123");
    const body = JSON.parse(captured[0].init?.body as string);
    expect(body.title).toContain("example.com/api/v1/things");
    expect(body.title).toContain("auth_required");
    expect(body.title).toContain("×7");
    expect(body.labels).toEqual(["triage-needed"]);
    expect(body.body).toContain(baseCluster.cluster_key);
    expect(body.body).toContain("unbrowse_resolve → unbrowse_execute");
    expect(body.body).toContain("s1");
  });

  test("returns undefined on non-2xx response", async () => {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ error: "forbidden" }), { status: 403 })) as typeof fetch;
    const env = { GITHUB_TRIAGE_TOKEN: "x" } as unknown as Env;
    const result = await stageGithubIssue(env, baseCluster);
    expect(result).toBeUndefined();
  });
});

describe("triage-telemetry hardcoding guards", () => {
  test("no SLOW_THRESHOLD constants in worker source", async () => {
    const fs = await import("node:fs/promises");
    const path = await import("node:path");
    const src = await fs.readFile(path.join(import.meta.dir, "..", "src", "jobs", "triage-telemetry.ts"), "utf8");
    expect(src).not.toMatch(/SLOW_THRESHOLD_MS\s*=/);
    expect(src).not.toMatch(/BAD_PATTERN/);
    expect(src).not.toMatch(/BUG_KEYWORD/);
  });

  test("no per-host registry in worker source", async () => {
    const fs = await import("node:fs/promises");
    const path = await import("node:path");
    const src = await fs.readFile(path.join(import.meta.dir, "..", "src", "jobs", "triage-telemetry.ts"), "utf8");
    expect(src).not.toMatch(/host\s*===\s*"[a-z]+\./);
  });
});
