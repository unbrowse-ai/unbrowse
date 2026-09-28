import assert from "node:assert/strict";
import { test } from "node:test";
import {
  callTool,
  normalizeUrl,
  pageMarkdown,
  runMarkdown,
  runTask,
  scrapePage,
  UnbrowseError,
} from "../src/lib/unbrowse.ts";

function rpc(payload: unknown, status = 200) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    const next = Array.isArray(payload) ? payload.shift() : payload;
    return new Response(JSON.stringify(next), { status });
  }) as unknown as typeof fetch;
  return { calls, fetchImpl };
}

const text = (value: unknown) => ({
  jsonrpc: "2.0",
  id: 1,
  result: { content: [{ type: "text", text: JSON.stringify(value) }] },
});

test("scrapePage sends the JSON-RPC tools/call with the bearer key", async () => {
  const { calls, fetchImpl } = rpc(
    text({ url: "https://example.com", metadata: { title: "Example" }, markdown: "Hi" }),
  );
  const page = await scrapePage(" ub_live_x ", "https://example.com/", { fetchImpl });
  assert.equal(page.metadata?.title, "Example");
  assert.equal(calls[0].url, "https://unbrowse.ai/api/mcp");
  const headers = calls[0].init.headers as Record<string, string>;
  assert.equal(headers.Authorization, "Bearer ub_live_x");
  assert.deepEqual(JSON.parse(String(calls[0].init.body)).params, {
    name: "unbrowse.scrape",
    arguments: { url: "https://example.com/", formats: ["markdown"] },
  });
});

test("401 becomes a key error", async () => {
  const { fetchImpl } = rpc({ error: "invalid_token" }, 401);
  await assert.rejects(callTool("bad", "unbrowse.scrape", {}, { fetchImpl }), /API key/);
});

test("isError results throw their text", async () => {
  const { fetchImpl } = rpc({ result: { isError: true, content: [{ type: "text", text: "blocked" }] } });
  await assert.rejects(
    callTool("k", "unbrowse.scrape", {}, { fetchImpl }),
    (e: Error) => e instanceof UnbrowseError && e.message === "blocked",
  );
});

test("normalizeUrl adds https and rejects other schemes", () => {
  assert.equal(normalizeUrl("example.com"), "https://example.com/");
  assert.throws(() => normalizeUrl("file:///etc/passwd"), /http/);
  assert.throws(() => normalizeUrl("  "), /Enter a URL/);
});

test("runTask polls inspect while the run is working", async () => {
  const { calls, fetchImpl } = rpc([
    text({ runId: "run_1", status: "working" }),
    text({ runId: "run_1", status: "succeeded", result: { ok: true } }),
  ]);
  const run = await runTask("k", "top stories on HN", undefined, { fetchImpl, pollMs: 1 });
  assert.equal(run.status, "succeeded");
  assert.equal(JSON.parse(String(calls[0].init.body)).params.arguments.interactionMode, "unattended");
  assert.deepEqual(JSON.parse(String(calls[1].init.body)).params, {
    name: "unbrowse.inspect",
    arguments: { runId: "run_1" },
  });
});

test("markdown renderers", () => {
  assert.equal(pageMarkdown({ url: "u", metadata: { title: "T" }, markdown: "body" }), "# T\n\nbody");
  assert.match(runMarkdown("t", { runId: "r", status: "succeeded", result: { a: 1 } }), /"a": 1/);
  assert.match(runMarkdown("t", { runId: "r", status: "failed", error: { message: "nope" } }), /failed\*\*: nope/);
});

test(
  "live: scrape and run against unbrowse.ai",
  { skip: !process.env.UNBROWSE_LIVE || !process.env.UNBROWSE_API_KEY },
  async () => {
    const key = process.env.UNBROWSE_API_KEY!;
    const page = await scrapePage(key, "https://example.com");
    assert.match(page.metadata?.title ?? "", /Example Domain/);
    const run = await runTask(key, "top 3 stories on Hacker News right now", undefined);
    assert.equal(run.status, "succeeded");
  },
);
