/**
 * tests/run-planner-integration.test.ts — Step 6 (Great Commission).
 *
 * End-to-end: stand up a real Bun.serve() stub returning the same JSON
 * shapes the live backend emits (src/api/routes.ts), build CLI-style fetch
 * deps over that stub, run the planner across the resolve/execute/capture/
 * browse seams, and assert the full chain. This is the wire-format proof
 * that runPlanner is host-portable: the same deps factory will plug into
 * the future POST /v1/run handler and the unbrowse_run MCP tool.
 *
 * Run: bun test tests/run-planner-integration.test.ts
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";

import {
  runPlanner,
  type RunPlannerDeps,
} from "../src/orchestrator/run-planner.js";

type StubHandler = (req: Request, body: unknown) => Promise<Response> | Response;

let server: ReturnType<typeof Bun.serve> | null = null;
let baseUrl = "";
let handlers: Record<string, StubHandler> = {};
const calls: Array<{ path: string; body: unknown }> = [];

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      const body = req.body ? await req.json().catch(() => null) : null;
      calls.push({ path: url.pathname, body });
      const handler = handlers[url.pathname];
      if (!handler) {
        return new Response(JSON.stringify({ error: `no stub for ${url.pathname}` }), {
          status: 404,
          headers: { "content-type": "application/json" },
        });
      }
      return handler(req, body);
    },
  });
  baseUrl = `http://127.0.0.1:${server.port}`;
});

afterAll(() => {
  server?.stop(true);
});

function jsonRes(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function buildFetchDeps(base: string): RunPlannerDeps {
  const post = async <T>(path: string, body: unknown): Promise<T> => {
    const res = await fetch(`${base}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    return (await res.json()) as T;
  };
  return {
    resolve: async ({ url, intent, params }) =>
      post("/v1/intent/resolve", { intent, context: { url }, params }),
    execute: async ({ skill_id, endpoint_id, url, intent, params }) =>
      post(`/v1/skills/${skill_id}/execute`, {
        params: { ...(params ?? {}), endpoint_id, url },
        intent,
        projection: { raw: true },
      }),
    capture: async ({ url, intent }) => post("/v1/capture", { url, intent }),
    browse: async ({ url }) => post("/v1/browse/go", { url }),
  };
}

function resetStubs() {
  handlers = {};
  calls.length = 0;
}

describe("runPlanner integration: real fetch over Bun.serve stub", () => {
  it("golden path: resolve hit + safe GET → execute → ok (full wire chain)", async () => {
    resetStubs();
    handlers["/v1/intent/resolve"] = (_req, body) => {
      expect((body as { intent: string }).intent).toBe("find hello");
      return jsonRes({
        status: "hit",
        source: "local_cache",
        skill: { skill_id: "skill-int-1" },
        available_endpoints: [
          { endpoint_id: "ep-int-1", method: "GET", needs_params: false },
        ],
      });
    };
    handlers["/v1/skills/skill-int-1/execute"] = (_req, body) => {
      const params = (body as { params: Record<string, unknown> }).params;
      expect(params.endpoint_id).toBe("ep-int-1");
      return jsonRes({
        trace: { success: true, endpoint_id: "ep-int-1", trace_id: "t-1" },
        result: { items: [{ title: "hello world" }] },
      });
    };

    const deps = buildFetchDeps(baseUrl);
    const out = await runPlanner(
      { url: "https://example.com/search?q=hello", intent: "find hello" },
      deps,
    );

    expect(out.status).toBe("ok");
    expect(calls.map((c) => c.path)).toEqual([
      "/v1/intent/resolve",
      "/v1/skills/skill-int-1/execute",
    ]);
    expect(out.run_plan).toEqual([
      expect.objectContaining({ step: "resolve", status: "hit", source: "local_cache" }),
      expect.objectContaining({ step: "execute", status: "complete", endpoint_id: "ep-int-1" }),
    ]);
  });

  it("miss → capture → re-resolve hit → execute (full 4-hop chain)", async () => {
    resetStubs();
    let resolveCount = 0;
    handlers["/v1/intent/resolve"] = (_req, _body) => {
      resolveCount++;
      if (resolveCount === 1) return jsonRes({ status: "miss" });
      return jsonRes({
        status: "hit",
        source: "fresh_capture",
        skill: { skill_id: "skill-int-2" },
        available_endpoints: [{ endpoint_id: "ep-int-2", method: "GET" }],
      });
    };
    handlers["/v1/capture"] = (_req, body) => {
      expect((body as { url: string }).url).toBe("https://example.com/x");
      return jsonRes({
        skill_id: "skill-int-2",
        endpoints_discovered: 3,
        capture_pattern: "json",
        ms: 421,
        endpoints: [],
      });
    };
    handlers["/v1/skills/skill-int-2/execute"] = () =>
      jsonRes({
        trace: { success: true, endpoint_id: "ep-int-2" },
        result: { ok: true },
      });

    const deps = buildFetchDeps(baseUrl);
    const out = await runPlanner(
      { url: "https://example.com/x", intent: "fetch x" },
      deps,
    );

    expect(out.status).toBe("ok");
    expect(calls.map((c) => c.path)).toEqual([
      "/v1/intent/resolve",
      "/v1/capture",
      "/v1/intent/resolve",
      "/v1/skills/skill-int-2/execute",
    ]);
    expect(out.run_plan).toEqual([
      expect.objectContaining({ step: "resolve", status: "miss" }),
      expect.objectContaining({ step: "index", status: "complete", endpoints_discovered: 3 }),
      expect.objectContaining({ step: "resolve", status: "hit", label: "after_index" }),
      expect.objectContaining({ step: "execute", status: "complete", endpoint_id: "ep-int-2" }),
    ]);
  });

  it("miss → thin capture → browse → browse_required (real /v1/browse/go shape)", async () => {
    resetStubs();
    handlers["/v1/intent/resolve"] = () => jsonRes({ status: "miss" });
    handlers["/v1/capture"] = () =>
      jsonRes({ skill_id: null, endpoints_discovered: 0, ms: 200, endpoints: [] });
    handlers["/v1/browse/go"] = () =>
      jsonRes({
        ok: true,
        session_id: "sess-int-9",
        url: "https://example.com/y",
        tab_id: "tab-1",
        auth_profile: "default",
      });

    const deps = buildFetchDeps(baseUrl);
    const out = await runPlanner(
      { url: "https://example.com/y", intent: "browse y" },
      deps,
    );

    expect(out.status).toBe("browse_required");
    expect(out.next_action?.command).toBe(
      "unbrowse snap --session sess-int-9 --filter interactive",
    );
    expect(calls.map((c) => c.path)).toEqual([
      "/v1/intent/resolve",
      "/v1/capture",
      "/v1/browse/go",
    ]);
    expect(out.run_plan).toContainEqual(
      expect.objectContaining({ step: "browse", status: "opened", session_id: "sess-int-9" }),
    );
  });

  it("auth_required short-circuits before any side-channel call", async () => {
    resetStubs();
    handlers["/v1/intent/resolve"] = () =>
      jsonRes({ error: "auth_required", login_url: "https://example.com/login" });

    const deps = buildFetchDeps(baseUrl);
    const out = await runPlanner(
      { url: "https://example.com/profile", intent: "view profile" },
      deps,
    );

    expect(out.status).toBe("auth_required");
    expect(out.next_action?.command).toBe('unbrowse auth "https://example.com/login"');
    expect(calls.map((c) => c.path)).toEqual(["/v1/intent/resolve"]);
  });
});
