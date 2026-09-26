import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { main, parseArgs } from "../src/cli.ts";

// A stand-in for the hosted REST API (/api/v1), shaped like unbrowse6's http.ts.
const TOKEN = "ub_live_test_0123456789";
const seen: Array<{ method: string; path: string; body: any; auth: string | null }> = [];
let polls = 0;

const run = (over: Record<string, unknown> = {}) => ({
  runId: "r1", status: "succeeded", verified: true, stateRevision: 1, requirements: [], result: { ok: true }, ...over,
});

const server = Bun.serve({
  port: 0,
  async fetch(req) {
    const url = new URL(req.url);
    const path = url.pathname.replace(/^\/api\/v1\//, "");
    const auth = req.headers.get("authorization");
    const body = req.method === "POST" ? await req.json().catch(() => null) : null;
    seen.push({ method: req.method, path: path + url.search, body, auth });
    if (path.startsWith("sites")) return Response.json(path === "sites" ? { total: 1, sites: [{ host: "en.wikipedia.org" }] } : { host: path.split("/")[1], tools: [] });
    if (auth !== `Bearer ${TOKEN}`) return Response.json({ error: { code: "unauthorized", message: "Unauthorized" } }, { status: 401 });
    if (req.method === "POST" && path === "runs") {
      if (body.task === "slow") return Response.json(run({ runId: "r2", status: "working" }));
      if (body.task === "login") return Response.json(run({ status: "failed", signIn: { url: "https://x.test/app/vault-request/q1" } }));
      if (body.task === "ask") return Response.json(run({ runId: "r3", status: "input_required", stateRevision: 4, requirements: [{ id: "q_origin", revision: 2, affectedAction: "origin", state: "open" }] }));
      return Response.json(run());
    }
    if (path === "runs/r2") return Response.json(run({ runId: "r2", status: ++polls < 2 ? "working" : "succeeded" }));
    if (path === "runs/r3") return Response.json(run({ runId: "r3", status: polls++ ? "succeeded" : "input_required", stateRevision: 4, requirements: [{ id: "q_origin", revision: 2, affectedAction: "origin", state: "open" }] }));
    if (path === "runs/r3/responses") return Response.json({ ok: true });
    if (path === "capabilities/search") return Response.json({ capabilities: [], query: body.query });
    if (path === "me") return Response.json({ workspaceId: "ws_1" });
    if (path === "usage") return Response.json({ remaining: 500 });
    if (path === "learn") return Response.json({ id: "learned.x" }, { status: 201 });
    if (path === "logins") return Response.json({ logins: [] });
    return Response.json({ error: { code: "not_found", message: `No route for /v1/${path}` } }, { status: 404 });
  },
});
const BASE = `http://127.0.0.1:${server.port}`;

function cli(argv: string[]) {
  const out: string[] = [];
  const err: string[] = [];
  const opened: string[] = [];
  return main([...argv, "--base-url", BASE], { out: (s) => out.push(s), err: (s) => err.push(s), open: (u) => opened.push(u) }).then((code) => ({ code, out, err, opened, json: () => JSON.parse(out[0]!) }));
}

beforeAll(() => {
  process.env.UNBROWSE_CONFIG_DIR = mkdtempSync(join(tmpdir(), "unbrowse-cli-"));
});
beforeEach(() => {
  seen.length = 0;
  polls = 0;
  process.env.UNBROWSE_API_KEY = TOKEN;
});
afterAll(() => server.stop(true));

test("parseArgs: flags, values, --set pairs, booleans", () => {
  expect(parseArgs(["run", "a", "b", "--capability", "c", "--set", "q=x", "--json"])).toEqual({ _: ["run", "a", "b"], flags: { capability: "c", json: true }, sets: { q: "x" } });
});

test("run POSTs /runs with task, typed inputs and an idempotency key; exit 0 on verified success", async () => {
  const r = await cli(["run", "top", "stories", "--set", "page=2", "--url", "https://news.ycombinator.com", "--unattended"]);
  expect(r.code).toBe(0);
  const post = seen.find((s) => s.path === "runs")!;
  expect(post.auth).toBe(`Bearer ${TOKEN}`);
  expect(post.body).toMatchObject({ task: "top stories", input: { page: 2 }, targetUrl: "https://news.ycombinator.com", interactionMode: "unattended" });
  expect(typeof post.body.idempotencyKey).toBe("string");
});

test("a working run is polled until it settles", async () => {
  expect((await cli(["run", "slow"])).code).toBe(0);
  expect(seen.filter((s) => s.path === "runs/r2")).toHaveLength(2);
});

test("a login wall opens the save-login page and exits 3; --no-open only prints it", async () => {
  expect((await cli(["run", "login"])).opened).toEqual(["https://x.test/app/vault-request/q1"]);
  const quiet = await cli(["run", "login", "--no-open"]);
  expect(quiet.code).toBe(3);
  expect(quiet.opened).toEqual([]);
  expect(quiet.err.join()).toContain("vault-request/q1");
});

test("input_required exits 2 and names the fields to resume with", async () => {
  const r = await cli(["run", "ask"]);
  expect(r.code).toBe(2);
  expect(r.err.join()).toContain("unbrowse resume r3 origin=…");
});

test("resume answers by field name on the same run, in the wire format the server reads", async () => {
  polls = 0;
  const r = await cli(["resume", "r3", "origin=CDG"]);
  expect(r.code).toBe(0);
  const post = seen.find((s) => s.path === "runs/r3/responses")!;
  expect(post.body).toEqual({
    expected_state_revision: 4,
    responses: [{ requirement_id: "q_origin", expected_revision: 2, action: "accept", values: { origin: "CDG" } }],
  });
});

test("resume refuses a field that is not an open requirement", async () => {
  const r = await cli(["resume", "r3", "nope=1"]);
  expect(r.code).toBe(1);
  expect(r.err[0]).toContain("Open: origin");
});

test("commands map to their REST routes", async () => {
  const cases: Array<[string[], string, string]> = [
    [["discover", "flight", "search"], "POST", "capabilities/search"],
    [["usage"], "GET", "usage"],
    [["whoami"], "GET", "me"],
    [["logins"], "GET", "logins"],
    [["cancel", "r9"], "POST", "runs/r9/cancel"],
    [["learned"], "GET", "learned"],
    [["registry", "wiki"], "GET", "sites?q=wiki"],
    [["site", "www.en.wikipedia.org"], "GET", "sites/en.wikipedia.org"],
  ];
  for (const [argv, method, path] of cases) {
    seen.length = 0;
    await cli(argv);
    expect(seen[0]).toMatchObject({ method, path });
  }
  expect(seen.length).toBe(1);
});

test("learn sends every HAR in one request", async () => {
  const dir = mkdtempSync(join(tmpdir(), "har-"));
  writeFileSync(join(dir, "a.har"), '{"log":{"entries":[1]}}');
  writeFileSync(join(dir, "b.har"), '{"log":{"entries":[2]}}');
  const r = await cli(["learn", join(dir, "a.har"), join(dir, "b.har"), "--title", "Search"]);
  expect(r.code).toBe(0);
  expect(seen[0]!.body).toEqual({ har: [{ log: { entries: [1] } }, { log: { entries: [2] } }], title: "Search" });
});

test("the public registry works without an account and sends no Authorization header", async () => {
  delete process.env.UNBROWSE_API_KEY;
  const r = await cli(["registry"]);
  expect(r.code).toBe(0);
  expect(seen[0]!.auth).toBeNull();
});

test("not signed in: exit 3 with a login hint", async () => {
  delete process.env.UNBROWSE_API_KEY;
  const r = await cli(["usage"]);
  expect(r.code).toBe(3);
  expect(r.err[0]).toContain("unbrowse login");
});

test("a server error prints its message; --json prints it as JSON", async () => {
  const r = await cli(["learned", "missing", "--json"]);
  expect(r.code).toBe(1);
  expect(r.json().error).toMatchObject({ status: 404, message: "No route for /v1/learned/missing" });
});

test("install prints OAuth install commands for the hosted MCP, never a key", async () => {
  const r = await cli(["install"]);
  expect(r.out[0]).toContain(`claude mcp add --transport http unbrowse ${BASE}/mcp`);
  expect(r.out[0]).not.toContain(TOKEN);
});
