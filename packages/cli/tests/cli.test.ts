import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { apiResource, clear, currentToken, describe as describeAuth, oauthLogin, save, sharedSignIn, tokenFor, v1Key } from "../src/auth.ts";
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
    if (url.pathname === "/oauth/register") return Response.json({ client_id: "cid_cli" });
    if (url.pathname === "/oauth/token") return Response.json({ access_token: TOKEN, refresh_token: "rtk", expires_in: 3600 });
    const call = /^sites\/([^/]+)\/call\/([^/]+)$/.exec(path);
    if (call && req.method === "POST") {
      if (auth !== `Bearer ${TOKEN}`) return Response.json({ error: { code: "unauthorized", message: "Unauthorized" } }, { status: 401 });
      const headers = Object.fromEntries(["x-unbrowse-deadline-ms", "idempotency-key", "x-unbrowse-end-user"].map((h) => [h, req.headers.get(h)]));
      if (body?.query === "ask") return Response.json({ runId: "c2", status: "input_required", requirements: [{ id: "q_size", affectedAction: "size", state: "open" }] }, { status: 202 });
      if (body?.query === "broken") return Response.json({ runId: "c3", status: "failed", error: { code: "upstream_error", message: "the site answered 500" } });
      return Response.json({ runId: "c1", status: "succeeded", capabilityId: `public.${call[1]}.x`, result: { echo: body, headers } });
    }
    if (path.startsWith("sites")) return Response.json(path === "sites" ? { total: 1, sites: [{ host: "en.wikipedia.org" }] } : { host: path.split("/")[1], tools: [] });
    if (auth !== `Bearer ${TOKEN}`) return Response.json({ error: { code: "unauthorized", message: "Unauthorized" } }, { status: 401 });
    if (req.method === "POST" && path === "runs") {
      if (body.task === "slow") return Response.json(run({ runId: "r2", status: "working" }));
      if (body.task === "login") return Response.json(run({ status: "failed", signIn: { url: "https://x.test/app/vault-request/q1" } }));
      if (body.task === "ask") return Response.json(run({ runId: "r3", status: "input_required", stateRevision: 4, requirements: [{ id: "q_origin", revision: 2, affectedAction: "origin", state: "open" }] }));
      if (body.task === "nothing fits") return Response.json(run({ status: "failed", verified: false, error: { code: "no_capability", message: "unbrowse.browse.open is an MCP tool" }, result: { next: { tool: "unbrowse.index", ...(body.targetUrl ? { url: body.targetUrl } : {}) }, suggestions: { tools: [{ capability: "public.api_weather_gov.get_cwsu", title: "Cwsu" }] } } }));
      return Response.json(run({ events: [{ type: "RunAccepted" }] }));
    }
    if (req.method === "POST" && path === "scrape") return Response.json({ markdown: "# Serde\n\nA framework.", links: ["https://serde.rs"], metadata: { url: body.url, finalUrl: body.url, status: 200, title: "serde - Rust" } });
    if (req.method === "POST" && path === "index") return Response.json({ id: "ix_1", url: body.url, host: new URL(body.url).host, status: "queued", events: [{ step: 1 }] }, { status: 202 });
    if (path === "index/ix_1") return Response.json({ id: "ix_1", url: "https://a.test", host: "a.test", status: ++polls < 2 ? "running" : "done", indexed: polls < 2 ? 0 : 2, events: [{ step: 2 }] });
    if (path === "index") return Response.json({ jobs: [{ id: "ix_1", url: "https://a.test", host: "a.test", status: "done", indexed: 2, events: [] }] });
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

function cli(argv: string[], over: { interactive?: boolean; open?: (u: string) => void } = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const opened: string[] = [];
  const open = (u: string) => (opened.push(u), over.open?.(u));
  return main([...argv, "--base-url", BASE], { out: (s) => out.push(s), err: (s) => err.push(s), open, interactive: over.interactive }).then((code) => ({ code, out, err, opened, json: () => JSON.parse(out[0]!) }));
}

beforeAll(() => {
  process.env.UNBROWSE_CONFIG_DIR = mkdtempSync(join(tmpdir(), "unbrowse-cli-"));
  process.env.CLAUDE_CONFIG_DIR = mkdtempSync(join(tmpdir(), "unbrowse-claude-none-")); // never the developer's real one
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
  expect(typeof post.body.idempotency_key).toBe("string");
});

test("site requests go from this machine by default; --from-unbrowse sends them from Unbrowse", async () => {
  expect((await cli(["run", "--from-here", "top", "stories"])).code).toBe(0);
  expect(seen.find((s) => s.path === "runs")!.body).toMatchObject({ task: "top stories", egress: "client" });
  seen.length = 0;
  expect((await cli(["run", "top", "stories"])).code).toBe(0);
  expect(seen.find((s) => s.path === "runs")!.body.egress).toBe("client");
  seen.length = 0;
  expect((await cli(["run", "--from-unbrowse", "top", "stories"])).code).toBe(0);
  const body = seen.find((s) => s.path === "runs")!.body;
  expect(body.task).toBe("top stories");
  expect(body.egress).toBeUndefined();
});

test("--no-wait sends the site requests from Unbrowse: nothing would be left to send them from here", async () => {
  expect((await cli(["run", "--no-wait", "top", "stories"])).code).toBe(0);
  expect(seen.find((s) => s.path === "runs")!.body.egress).toBeUndefined();
});

test("not signed in with --json: the error is JSON on stdout", async () => {
  delete process.env.UNBROWSE_API_KEY;
  clear();
  const r = await cli(["whoami", "--json"]);
  expect(r.code).toBe(3);
  expect(r.json().error).toMatchObject({ status: 401, code: "not_signed_in" });
});

test("an unreachable server is named, not just 'fetch failed'", async () => {
  const r = await main(["whoami", "--base-url", "http://127.0.0.1:9"], { out: () => {}, err: (s) => errs.push(s), open: () => {} });
  expect(r).toBe(1);
  expect(errs.join(" ")).toContain("could not reach http://127.0.0.1:9");
});
const errs: string[] = [];

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

test("run leaves out the event log unless --events, like MCP", async () => {
  expect((await cli(["run", "top", "stories"])).json().events).toBeUndefined();
  expect((await cli(["run", "top", "stories", "--events"])).json().events).toEqual([{ type: "RunAccepted" }]);
});

test("no_capability: exit 1 and the next steps as CLI commands, not MCP tools or REST routes", async () => {
  const bare = await cli(["run", "nothing", "fits"]);
  expect(bare.code).toBe(1);
  const said = bare.err.join("\n");
  expect(said).toContain('unbrowse run "nothing fits" --url https://');
  expect(said).toContain("unbrowse scrape https://");
  expect(said).toContain("unbrowse run --capability public.api_weather_gov.get_cwsu");
  expect(said).not.toContain("browse.open");
  const named = (await cli(["run", "nothing", "fits", "--url", "https://wttr.in/London"])).err.join("\n");
  expect(named).toContain("unbrowse scrape https://wttr.in/London");
  expect(named).toContain("unbrowse index https://wttr.in/London");
});

test("scrape: the page on stdout as markdown, its title and status on stderr; --json is the whole answer", async () => {
  const r = await cli(["scrape", "https://docs.rs/serde"]);
  expect(r.code).toBe(0);
  expect(seen.find((s) => s.path === "scrape")!.body).toEqual({ formats: ["markdown"], url: "https://docs.rs/serde" });
  expect(r.out).toEqual(["# Serde\n\nA framework."]);
  expect(r.err.join()).toContain("serde - Rust · https://docs.rs/serde · HTTP 200");
  seen.length = 0;
  const j = await cli(["scrape", "https://docs.rs/serde", "--format", "markdown,links", "--full", "--render", "never", "--json"]);
  expect(seen.find((s) => s.path === "scrape")!.body).toEqual({ formats: ["markdown", "links"], url: "https://docs.rs/serde", onlyMainContent: false, render: "never" });
  expect(j.json().links).toEqual(["https://serde.rs"]);
  expect((await cli(["scrape", "https://a.test", "--format", "pdf"])).code).toBe(1);
});

test("index starts a job, follows it to done, and prints it without the step trail", async () => {
  process.env.UNBROWSE_POLL_MS = "1";
  try {
    const r = await cli(["index", "https://a.test", "--focus", "search"]);
    expect(r.code).toBe(0);
    expect(seen.find((s) => s.path === "index")!.body).toEqual({ url: "https://a.test", focus: "search" });
    expect(r.json()).toMatchObject({ id: "ix_1", status: "done", indexed: 2 });
    expect(r.json().events).toBeUndefined();
    expect(r.err.join("\n")).toContain("unbrowse site a.test");
    const list = await cli(["index", "status"]);
    expect(list.json().jobs[0]).toMatchObject({ id: "ix_1", indexed: 2 });
    const quick = await cli(["index", "https://a.test", "--no-wait"]);
    expect(quick.json()).toMatchObject({ id: "ix_1", status: "queued" });
    expect(quick.err.join()).toContain("unbrowse index status ix_1");
  } finally {
    delete process.env.UNBROWSE_POLL_MS;
  }
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

test("first use at a terminal signs in through the browser, then the command carries on", async () => {
  delete process.env.UNBROWSE_API_KEY;
  clear();
  const r = await cli(["usage"], {
    interactive: true,
    open: (authorize) => {
      const u = new URL(authorize);
      const redirect = new URL(u.searchParams.get("redirect_uri")!);
      redirect.searchParams.set("code", "code_1");
      redirect.searchParams.set("state", u.searchParams.get("state")!);
      void fetch(redirect);
    },
  });
  expect(r.code).toBe(0);
  expect(r.err[0]).toContain("Welcome to Unbrowse");
  expect(r.opened[0]).toContain("/authorize");
  expect(r.json()).toEqual({ remaining: 500 });
  expect(await currentToken(BASE)).toBe(TOKEN);
  clear();
});

test("a script with no sign-in is not left waiting on a browser", async () => {
  delete process.env.UNBROWSE_API_KEY;
  clear();
  const r = await cli(["run", "top", "stories"]);
  expect(r.code).toBe(3);
  expect(r.opened).toHaveLength(0);
  expect(r.err[0]).toContain("npx unbrowse login");
  expect(seen.filter((s) => s.path === "runs")).toHaveLength(0);
});

test("a server error prints its message; --json prints it as JSON", async () => {
  const r = await cli(["learned", "missing", "--json"]);
  expect(r.code).toBe(1);
  expect(r.json().error).toMatchObject({ status: 404, message: "No route for /v1/learned/missing" });
});

test("help is the REST client and does not install MCP", async () => {
  const r = await cli(["help"]);
  expect(r.code).toBe(0);
  expect(r.out[0]).not.toContain("install");
  expect(r.out[0]).not.toContain("/mcp");
});

test("install is not a CLI command", async () => {
  const r = await cli(["install"]);
  expect(r.code).toBe(1);
  expect(r.err.join("")).toContain('unknown command "install"');
});

test("oauth login and refresh request the REST API resource, not MCP", async () => {
  const origin = "https://unbrowse.test";
  const seen: Array<{ url: string; body: string }> = [];
  const fetchImpl: typeof fetch = async (url, init) => {
    const u = String(url);
    const body = typeof init?.body === "string" ? init.body : "";
    seen.push({ url: u, body });
    if (u.endsWith("/oauth/register")) return Response.json({ client_id: "cid_test" });
    if (u.endsWith("/oauth/token")) return Response.json({ access_token: "atk_test", refresh_token: "rtk_test", expires_in: 3600 });
    return Response.json({ error: "unexpected" }, { status: 500 });
  };
  await oauthLogin(origin, {
    fetch: fetchImpl,
    log: () => {},
    timeoutMs: 2000,
    open: (authorize) => {
      const u = new URL(authorize);
      expect(u.searchParams.get("resource")).toBe(apiResource(origin));
      expect(u.searchParams.get("resource")).not.toContain("/mcp");
      const redirect = new URL(u.searchParams.get("redirect_uri")!);
      redirect.searchParams.set("code", "code_1");
      redirect.searchParams.set("state", u.searchParams.get("state")!);
      void fetch(redirect);
    },
  });
  const codeGrant = new URLSearchParams(seen.find((s) => s.url.endsWith("/oauth/token"))!.body);
  expect(codeGrant.get("grant_type")).toBe("authorization_code");
  expect(codeGrant.get("resource")).toBe("https://unbrowse.test/api");

  save({ baseUrl: origin, oauth: { clientId: "cid_test", accessToken: "old", refreshToken: "rtk_test", expiresAt: Date.now() - 1000 } });
  delete process.env.UNBROWSE_API_KEY;
  const refreshed = await currentToken(origin, fetchImpl);
  expect(refreshed).toBe("atk_test");
  const refreshGrant = new URLSearchParams(seen.filter((s) => s.url.endsWith("/oauth/token")).at(-1)!.body);
  expect(refreshGrant.get("grant_type")).toBe("refresh_token");
  expect(refreshGrant.get("resource")).toBe("https://unbrowse.test/api");
});

test("call runs one site tool: inputs from JSON and --set, options as headers and body keys", async () => {
  save({ baseUrl: BASE, apiKey: TOKEN });
  const r = await cli(["call", "docs.rs", "docs_rs__get_search", '{"query":"serde"}', "--set", "page=2", "--deadline", "90000", "--select", "results[].title, total", "--idempotency-key", "k1", "--end-user", "u9"]);
  expect(r.code).toBe(0);
  const run = r.json();
  expect(run.status).toBe("succeeded");
  expect(run.result.echo).toEqual({ query: "serde", page: 2, select: ["results[].title", "total"] });
  expect(run.result.headers).toEqual({ "x-unbrowse-deadline-ms": "90000", "idempotency-key": "k1", "x-unbrowse-end-user": "u9" });
  expect(seen.at(-1)).toMatchObject({ method: "POST", path: "sites/docs.rs/call/docs_rs__get_search" });
});

test("call: input_required exits 2 naming the fields; a failed run exits 1 with its error; a bad deadline is a usage error", async () => {
  save({ baseUrl: BASE, apiKey: TOKEN });
  const ask = await cli(["call", "shop.example", "t", '{"query":"ask"}']);
  expect(ask.code).toBe(2);
  expect(ask.err.join("\n")).toContain("unbrowse resume c2 size=");
  const broken = await cli(["call", "shop.example", "t", '{"query":"broken"}']);
  expect(broken.code).toBe(1);
  expect(broken.err.join("\n")).toContain("upstream_error");
  const bad = await cli(["call", "shop.example", "t", "--deadline", "soon"]);
  expect(bad.code).toBe(1);
  expect(bad.err.join("\n")).toContain("--deadline takes milliseconds");
});

test("openapi prints the site's OpenAPI document without an account", async () => {
  clear();
  const r = await cli(["openapi", "docs.rs"]);
  expect(r.code).toBe(0);
  expect(seen.at(-1)).toMatchObject({ method: "GET", path: "sites/docs.rs/openapi.json" });
});

test("a v1 key in ~/.unbrowse/config.json still signs the CLI in to the hosted service", async () => {
  delete process.env.UNBROWSE_API_KEY;
  clear();
  const home = process.env.HOME;
  process.env.HOME = mkdtempSync(join(tmpdir(), "unbrowse-v1-"));
  try {
    const key = `ubr_${"a1".repeat(24)}`;
    mkdirSync(join(process.env.HOME, ".unbrowse"));
    writeFileSync(join(process.env.HOME, ".unbrowse", "config.json"), JSON.stringify({ api_key: key }));
    expect(await currentToken("https://unbrowse.ai")).toBe(key);
    expect(v1Key("http://127.0.0.1:1")).toBeUndefined();
    writeFileSync(join(process.env.HOME, ".unbrowse", "config.json"), JSON.stringify({ api_key: "not-a-v1-key" }));
    expect(await currentToken("https://unbrowse.ai")).toBeUndefined();
    // A sign-in or stored key wins over it.
    writeFileSync(join(process.env.HOME, ".unbrowse", "config.json"), JSON.stringify({ api_key: key }));
    save({ baseUrl: "https://unbrowse.ai", apiKey: "ub_new" });
    expect(await currentToken("https://unbrowse.ai")).toBe("ub_new");
  } finally {
    process.env.HOME = home;
    clear();
  }
});

test("no CLI sign-in: Claude Code's MCP sign-in for this origin's /api audience is shared, never a /mcp or expired one", async () => {
  delete process.env.UNBROWSE_API_KEY;
  clear();
  const dir = mkdtempSync(join(tmpdir(), "unbrowse-claude-"));
  const prev = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = dir;
  const write = (mcpOAuth: Record<string, unknown>) => writeFileSync(join(dir, ".credentials.json"), JSON.stringify({ mcpOAuth }));
  try {
    expect(sharedSignIn(BASE)).toBeUndefined(); // no file
    write({
      "a|1": { serverName: "unbrowse-mcp", serverUrl: `${BASE}/mcp`, accessToken: "mcp-audience" }, // refused on /api by the server
      "b|2": { serverName: "old", serverUrl: `${BASE}/api/mcp`, accessToken: "expired", expiresAt: Date.now() - 1 },
      "c|3": { serverName: "other", serverUrl: "https://elsewhere.example/api/mcp", accessToken: "other-origin" },
      "d|4": { serverName: "empty", serverUrl: `${BASE}/api/mcp`, accessToken: "" },
    });
    expect(await currentToken(BASE)).toBeUndefined();
    write({ "e|5": { serverName: "plugin:unbrowse:unbrowse", serverUrl: `${BASE}/api/mcp`, accessToken: TOKEN, expiresAt: Date.now() + 3_600_000 } });
    expect(await currentToken(BASE)).toBe(TOKEN);
    expect(describeAuth(BASE)).toContain("plugin:unbrowse:unbrowse");
    expect(describeAuth(BASE)).not.toContain(TOKEN);
    // A command runs on it without a sign-in prompt.
    const r = await cli(["whoami"]);
    expect(r.code).toBe(0);
    expect(seen.at(-1)!.auth).toBe(`Bearer ${TOKEN}`);
    // The CLI's own sign-in wins; the switch turns sharing off.
    save({ baseUrl: BASE, apiKey: "ub_own" });
    expect(await currentToken(BASE)).toBe("ub_own");
    clear();
    process.env.UNBROWSE_SHARED_SIGNIN = "0";
    expect(await currentToken(BASE)).toBeUndefined();
  } finally {
    delete process.env.UNBROWSE_SHARED_SIGNIN;
    if (prev === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = prev;
    clear();
  }
});

test("borrowing matches the server's audience rule exactly: same scheme, host and port, /api or below; not for another stored origin", async () => {
  delete process.env.UNBROWSE_API_KEY;
  clear();
  const dir = mkdtempSync(join(tmpdir(), "unbrowse-claude-"));
  const prev = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = dir;
  const only = (serverUrl: string) => writeFileSync(join(dir, ".credentials.json"), JSON.stringify({ mcpOAuth: { "x|1": { serverName: "s", serverUrl, accessToken: "t" } } }));
  const port = new URL(BASE).port;
  try {
    for (const bad of [`${BASE}/apix/mcp`, `${BASE}/apimcp`, `https://127.0.0.1:${port}/api/mcp`, `http://127.0.0.1:${Number(port) + 1}/api/mcp`, `http://localhost:${port}/api/mcp`, "not a url"]) {
      only(bad);
      expect(sharedSignIn(BASE)).toBeUndefined();
    }
    for (const good of [`${BASE}/api/mcp`, `${BASE}/api`, `${BASE}/api/v1/sites/github.com/mcp`]) {
      only(good);
      expect(sharedSignIn(BASE)?.token).toBe("t");
    }
    // A CLI signed in to another origin borrows nothing for this one.
    save({ baseUrl: "https://elsewhere.example", apiKey: "ub_other" });
    expect(sharedSignIn(BASE)?.token).toBe("t");
    expect(await currentToken(BASE)).toBeUndefined();
  } finally {
    process.env.CLAUDE_CONFIG_DIR = prev;
    clear();
  }
});

test("mcp add registers the stdio proxy with Claude Code and Codex, on the CLI's sign-in; an existing name is left alone without --replace", async () => {
  delete process.env.UNBROWSE_API_KEY;
  const calls: string[][] = [];
  const existing = new Set<string>(["claude", "codex"]);
  const exec = (raw: string[]) => {
    const cmd = raw[0] === "cmd" ? raw.slice(2) : raw;
    calls.push(raw);
    const [host, , verb] = cmd;
    if (cmd[1] === "--version") return { status: 0, stdout: "1", stderr: "" };
    if (verb === "get") return existing.has(host!) ? { status: 0, stdout: "unbrowse", stderr: "" } : { status: 1, stdout: "", stderr: "No MCP server" };
    if (verb === "remove") return existing.delete(host!), { status: 0, stdout: "", stderr: "" };
    if (verb === "add") return existing.add(host!), { status: 0, stdout: "", stderr: "" }; // codex really does overwrite: the get guards it
    return { status: 1, stdout: "", stderr: "?" };
  };
  const run = (argv: string[], os?: NodeJS.Platform) => {
    const out: string[] = [];
    const err: string[] = [];
    return main([...argv, "--base-url", BASE], { out: (s) => out.push(s), err: (s) => err.push(s), open: () => {}, exec, service: { node: "/usr/bin/node", cli: "/opt/unbrowse/cli.js", os } }).then((code) => ({ code, out, err }));
  };
  const launch = ["/usr/bin/node", "/opt/unbrowse/cli.js", "mcp", "--base-url", BASE];
  process.env.UNBROWSE_SHARED_SIGNIN = "0";
  try {
    // Whatever of these is set here is passed on (CI also sets XDG_CONFIG_HOME); never the API key.
    const env = ["UNBROWSE_CONFIG_DIR", "XDG_CONFIG_HOME", "CLAUDE_CONFIG_DIR", "UNBROWSE_SHARED_SIGNIN"].flatMap((k) => (process.env[k] ? [`${k}=${process.env[k]}`] : []));
    expect(env).toContain("UNBROWSE_SHARED_SIGNIN=0");
    expect(env.some((e) => e.startsWith("CLAUDE_CONFIG_DIR="))).toBe(true);
    const dry = await run(["mcp", "add", "--dry-run"]);
    expect(dry.code).toBe(0);
    expect(dry.out).toEqual([["claude", "mcp", "add", "--scope", "user", "unbrowse", ...env.flatMap((e) => ["-e", e]), "--", ...launch].join(" "), ["codex", "mcp", "add", "unbrowse", ...env.flatMap((e) => ["--env", e]), "--", ...launch].join(" ")]);
    expect(calls).toEqual([]);
    // Both hosts already have one: nothing is added or removed.
    const clash = await run(["mcp", "add"]);
    expect(clash.code).toBe(1);
    expect(clash.err.filter((l) => l.includes("--replace")).length).toBe(2);
    expect(calls.some((c) => c[2] === "add" || c[2] === "remove")).toBe(false);
    calls.length = 0;
    const ok = await run(["mcp", "add", "codex", "--replace"]);
    expect(ok.code).toBe(0);
    expect(calls.map((c) => c.slice(0, 3).join(" "))).toEqual(["codex mcp get", "codex mcp remove", "codex mcp add"]);
    expect(ok.err.join("\n")).toContain("Not signed in yet");
    expect(calls.flat().join(" ")).not.toContain(TOKEN); // nothing secret goes into a host's config
    // An env-only key is not passed on: say so instead.
    process.env.UNBROWSE_API_KEY = TOKEN;
    existing.clear();
    const envOnly = await run(["mcp", "add", "claude"]);
    expect(envOnly.err.join("\n")).toContain("UNBROWSE_API_KEY, which the hosts do not get");
    expect(calls.flat().join(" ")).not.toContain(TOKEN);
    delete process.env.UNBROWSE_API_KEY;
    // Windows: host commands go through cmd /c (npm's claude.cmd / codex.cmd).
    calls.length = 0;
    existing.clear();
    expect((await run(["mcp", "add", "claude"], "win32")).code).toBe(0);
    expect(calls.every((c) => c[0] === "cmd" && c[1] === "/c")).toBe(true);
    expect((await run(["mcp", "add", "cursor"])).code).toBe(1);
  } finally {
    delete process.env.UNBROWSE_SHARED_SIGNIN;
    process.env.UNBROWSE_API_KEY = TOKEN;
  }
});

test("mcp add with neither host on PATH says how to run the proxy by hand", async () => {
  const err: string[] = [];
  const code = await main(["mcp", "add", "--base-url", BASE], { out: () => {}, err: (s) => err.push(s), open: () => {}, exec: () => ({ status: 1, stdout: "", stderr: "ENOENT" }), service: { node: "/usr/bin/node", cli: "/opt/unbrowse/cli.js" } });
  expect(code).toBe(1);
  expect(err.join("\n")).toContain("No Claude Code or Codex found on PATH");
});

test("several Claude Code sign-ins match: the one valid longest wins, whatever the file order; a borrowed one never goes to another --url", async () => {
  delete process.env.UNBROWSE_API_KEY;
  clear();
  const dir = mkdtempSync(join(tmpdir(), "unbrowse-claude-"));
  const prev = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = dir;
  const now = Date.now();
  try {
    writeFileSync(join(dir, ".credentials.json"), JSON.stringify({ mcpOAuth: {
      "a|1": { serverName: "no-expiry", serverUrl: `${BASE}/api/mcp`, accessToken: "unknown" },
      "b|2": { serverName: "soon", serverUrl: `${BASE}/api/mcp`, accessToken: "soon", expiresAt: now + 600_000 },
      "c|3": { serverName: "later", serverUrl: `${BASE}/api/mcp`, accessToken: "later", expiresAt: now + 3_600_000 },
    } }));
    expect(sharedSignIn(BASE)).toEqual({ token: "later", from: "Claude Code's MCP sign-in (later)" });
    expect(await tokenFor(BASE, `${BASE}/api/mcp`)).toBe("later");
    expect(await tokenFor(BASE, "https://elsewhere.example/mcp")).toBeUndefined();
    // The CLI's own sign-in still goes to an explicit --url, as before.
    save({ baseUrl: BASE, apiKey: "ub_own" });
    expect(await tokenFor(BASE, "https://elsewhere.example/mcp")).toBe("ub_own");
  } finally {
    process.env.CLAUDE_CONFIG_DIR = prev;
    clear();
    process.env.UNBROWSE_API_KEY = TOKEN;
  }
});

test("mcp add says so when Claude Code also has the Unbrowse plugin's server (tools would show twice)", async () => {
  const exec = (cmd: string[]) => {
    if (cmd[2] === "get") return cmd[3] === "plugin:unbrowse:unbrowse" ? { status: 0, stdout: "", stderr: "" } : { status: 1, stdout: "", stderr: "No MCP server" };
    return { status: 0, stdout: "", stderr: "" };
  };
  const err: string[] = [];
  const code = await main(["mcp", "add", "claude", "--base-url", BASE], { out: () => {}, err: (s) => err.push(s), open: () => {}, exec, service: { node: "/usr/bin/node", cli: "/opt/unbrowse/cli.js" } });
  expect(code).toBe(0);
  expect(err.join("\n")).toContain("plugin:unbrowse:unbrowse");
});
