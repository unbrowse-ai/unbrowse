import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import app from "../src/index.js";
import type { Env } from "../src/types.js";
import {
  flushQueuedGithubNotifications,
  verifyGithubWebhookSignature,
} from "../src/services/github-webhooks.js";
import { statsKV } from "../src/services/kv.js";

const env: Env = {
  API_KEY: "admin",
  UNKEY_ROOT_KEY: "root",
  UNKEY_API_ID: "api",
  EMERGENTDB_API_KEY: "test",
  NEBIUS_API_KEY: "nebius",
  GITHUB_WEBHOOK_SECRET: "test-secret",
  GITHUB_PR_BOT_TOKEN: "gh-token",
  GITHUB_PR_AGENT_WORKFLOW: "pr-agent.yml",
  GITHUB_PR_AGENT_WORKFLOW_REF: "main",
  TELEGRAM_BOT_TOKEN: "tg-token",
  TELEGRAM_CHAT_ID: "1234",
  STATS_KV: {} as KVNamespace,
  ENVIRONMENT: "staging",
};

const sampleSecret = "It's a Secret to Everybody";
const samplePayload = "Hello, World!";
const sampleSignature = "sha256=757107ea0eb2509fc211221cce984b8a37570b6d7586c22c46f4379c8b043e17";

function createSignature(secret: string, payload: string): Promise<string> {
  const encoder = new TextEncoder();
  return crypto.subtle
    .importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"])
    .then((key) => crypto.subtle.sign("HMAC", key, encoder.encode(payload)))
    .then((signature) => `sha256=${Array.from(new Uint8Array(signature)).map((value) => value.toString(16).padStart(2, "0")).join("")}`);
}

function createMockFetch(store: Map<string, string>) {
  return async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url);

    if (url.hostname === "api.emergentdb.com") {
      if (url.pathname === "/qdkv/set") {
        const body = JSON.parse(String(init?.body ?? "{}")) as { key: string; value: string };
        store.set(body.key, body.value);
        return Response.json({ ok: true });
      }
      if (url.pathname.startsWith("/qdkv/get/")) {
        const key = decodeURIComponent(url.pathname.replace("/qdkv/get/", ""));
        const value = store.get(key);
        return Response.json(value == null ? { found: false, value: null } : { found: true, value });
      }
      if (url.pathname.startsWith("/qdkv/del/")) {
        const key = decodeURIComponent(url.pathname.replace("/qdkv/del/", ""));
        store.delete(key);
        return Response.json({ ok: true });
      }
    }

    if (url.hostname === "api.github.com") {
      if (url.pathname === "/repos/unbrowse-ai/unbrowse-dev/pulls/42" && (!init?.method || init.method === "GET")) {
        return Response.json({
          number: 42,
          title: "Test PR",
          html_url: "https://github.com/unbrowse-ai/unbrowse-dev/pull/42",
          state: "open",
          draft: false,
          labels: [{ name: "codex:auto-maintain" }],
          head: {
            sha: "abc123",
            ref: "feature/test-pr",
            repo: { full_name: "unbrowse-ai/unbrowse-dev" },
          },
          base: {
            ref: "main",
            repo: { full_name: "unbrowse-ai/unbrowse-dev" },
          },
        });
      }
      if (url.pathname === "/repos/unbrowse-ai/unbrowse-dev/pulls/43" && (!init?.method || init.method === "GET")) {
        return Response.json({
          number: 43,
          title: "Clean PR",
          html_url: "https://github.com/unbrowse-ai/unbrowse-dev/pull/43",
          state: "open",
          draft: false,
          labels: [{ name: "codex:auto-maintain" }],
          head: {
            sha: "def456",
            ref: "feature/clean-pr",
            repo: { full_name: "unbrowse-ai/unbrowse-dev" },
          },
          base: {
            ref: "main",
            repo: { full_name: "unbrowse-ai/unbrowse-dev" },
          },
        });
      }
      if (url.pathname === "/repos/unbrowse-ai/unbrowse-dev/actions/workflows/pr-agent.yml/dispatches" && init?.method === "POST") {
        return new Response(null, { status: 204 });
      }
    }

    if (url.hostname === "api.telegram.org" && init?.method === "POST") {
      return Response.json({ ok: true });
    }

    throw new Error(`Unexpected fetch: ${url.toString()}`);
  };
}

describe("github webhook automation", () => {
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

  it("matches GitHub's published signature example", async () => {
    expect(await verifyGithubWebhookSignature(sampleSecret, samplePayload, sampleSignature)).toBe(true);
  });

  it("rejects invalid signatures", async () => {
    expect(await verifyGithubWebhookSignature(env.GITHUB_WEBHOOK_SECRET!, "{\"a\":1}", "sha256=deadbeef")).toBe(false);
  });

  it("accepts ping events", async () => {
    const body = JSON.stringify({ zen: "keep it logically awesome" });
    const signature = await createSignature(env.GITHUB_WEBHOOK_SECRET!, body);
    const response = await app.fetch(
      new Request("http://local.test/v1/webhooks/github", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-GitHub-Event": "ping",
          "X-GitHub-Delivery": "delivery-ping",
          "X-Hub-Signature-256": signature,
        },
        body,
      }),
      env,
      { waitUntil: () => {} } as ExecutionContext,
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ kind: "ping" });
  });

  it("dispatches the agent workflow for managed pull_request events", async () => {
    const body = JSON.stringify({
      action: "synchronize",
      repository: { full_name: "unbrowse-ai/unbrowse-dev" },
      pull_request: {
        number: 42,
        title: "Test PR",
        html_url: "https://github.com/unbrowse-ai/unbrowse-dev/pull/42",
      },
    });
    const signature = await createSignature(env.GITHUB_WEBHOOK_SECRET!, body);

    const response = await app.fetch(
      new Request("http://local.test/v1/webhooks/github", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-GitHub-Event": "pull_request",
          "X-GitHub-Delivery": "delivery-dirty",
          "X-Hub-Signature-256": signature,
        },
        body,
      }),
      env,
      { waitUntil: () => {} } as ExecutionContext,
    );

    expect(response.status).toBe(202);
    expect(await response.json()).toMatchObject({ kind: "dispatched" });
  });

  it("dispatches the agent workflow for managed labeled PRs", async () => {
    const body = JSON.stringify({
      action: "labeled",
      repository: { full_name: "unbrowse-ai/unbrowse-dev" },
      pull_request: {
        number: 43,
        title: "Clean PR",
        html_url: "https://github.com/unbrowse-ai/unbrowse-dev/pull/43",
      },
    });
    const signature = await createSignature(env.GITHUB_WEBHOOK_SECRET!, body);

    const response = await app.fetch(
      new Request("http://local.test/v1/webhooks/github", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-GitHub-Event": "pull_request",
          "X-GitHub-Delivery": "delivery-clean",
          "X-Hub-Signature-256": signature,
        },
        body,
      }),
      env,
      { waitUntil: () => {} } as ExecutionContext,
    );

    expect(response.status).toBe(202);
    expect(await response.json()).toMatchObject({ kind: "dispatched" });
  });

  it("dispatches for failed check suites on the current PR head", async () => {
    const body = JSON.stringify({
      action: "completed",
      repository: { full_name: "unbrowse-ai/unbrowse-dev" },
      check_suite: {
        status: "completed",
        conclusion: "failure",
        head_sha: "def456",
        pull_requests: [{ number: 43 }],
      },
    });
    const signature = await createSignature(env.GITHUB_WEBHOOK_SECRET!, body);

    const response = await app.fetch(
      new Request("http://local.test/v1/webhooks/github", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-GitHub-Event": "check_suite",
          "X-GitHub-Delivery": "delivery-check-suite",
          "X-Hub-Signature-256": signature,
        },
        body,
      }),
      env,
      { waitUntil: () => {} } as ExecutionContext,
    );

    expect(response.status).toBe(202);
    expect(await response.json()).toMatchObject({ kind: "dispatched" });
  });

  it("flushes queued digest notifications to Telegram", async () => {
    await statsKV(env).put(
      "gh-notify:2026-04-03T01:00:00.000Z:delivery-1",
      JSON.stringify({
        delivery_id: "delivery-1",
        repo: "unbrowse-ai/unbrowse-dev",
        pr_number: 42,
        title: "Test PR",
        url: "https://github.com/unbrowse-ai/unbrowse-dev/pull/42",
        status: "needs-human",
        note: "merge conflict detected",
        queued_at: "2026-04-03T01:00:00.000Z",
      }),
    );

    const result = await flushQueuedGithubNotifications(env);
    expect(result).toEqual({ sent: true, count: 1 });

    const queued = await statsKV(env).listWithValues("gh-notify:");
    expect(queued).toHaveLength(0);
  });
});
