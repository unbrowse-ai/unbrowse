import { afterEach, expect, test } from "bun:test";
import { DEFAULT_BASE_URL, Unbrowse, UnbrowseError } from "../src/index.ts";

type Sent = { method: string; url: string; auth: string | null; body: unknown };

/** A fetch that records every request and answers from `reply`. */
function stub(reply: (s: Sent) => Response = () => Response.json({ ok: true })) {
  const sent: Sent[] = [];
  const fetch = (async (url: string, init: RequestInit = {}) => {
    const headers = new Headers(init.headers);
    const s = { method: init.method ?? "GET", url, auth: headers.get("authorization"), body: init.body ? JSON.parse(String(init.body)) : undefined };
    sent.push(s);
    return reply(s);
  }) as typeof globalThis.fetch;
  return { sent, fetch };
}

const envKey = process.env.UNBROWSE_API_KEY;
afterEach(() => {
  if (envKey === undefined) delete process.env.UNBROWSE_API_KEY;
  else process.env.UNBROWSE_API_KEY = envKey;
  delete process.env.UNBROWSE_BASE_URL;
});

test("defaults to the v3 API and UNBROWSE_API_KEY", async () => {
  process.env.UNBROWSE_API_KEY = "ub_live_env";
  const { sent, fetch } = stub();
  const ub = new Unbrowse({ fetch });
  expect(ub.baseUrl).toBe(DEFAULT_BASE_URL);
  expect(DEFAULT_BASE_URL).toBe("https://unbrowse.ai/api/v1");
  await ub.me();
  expect(sent[0]).toMatchObject({ url: "https://unbrowse.ai/api/v1/me", auth: "Bearer ub_live_env" });
});

test("an origin or an /api/v1 URL both work as baseUrl", () => {
  expect(new Unbrowse({ baseUrl: "https://example.test/" }).baseUrl).toBe("https://example.test/api/v1");
  expect(new Unbrowse({ baseUrl: "https://example.test/api/v1" }).baseUrl).toBe("https://example.test/api/v1");
});

test("no key → no Authorization header (public registry)", async () => {
  delete process.env.UNBROWSE_API_KEY;
  const { sent, fetch } = stub();
  await new Unbrowse({ fetch }).sites("wiki");
  expect(sent[0]!.auth).toBeNull();
});

test("every method maps to its /api/v1 route", async () => {
  const { sent, fetch } = stub();
  const ub = new Unbrowse({ apiKey: "k", baseUrl: "https://x.test", fetch });
  const calls: Array<[() => Promise<unknown>, string, string, unknown?]> = [
    [() => ub.run({ task: "t", idempotencyKey: "i" }), "POST", "/runs", { task: "t", idempotency_key: "i" }],
    [() => ub.run({ task: "t" }), "POST", "/runs", { task: "t" }],
    [() => ub.inspect("r1"), "GET", "/runs/r1"],
    [() => ub.events("r1"), "GET", "/runs/r1/events"],
    [() => ub.cancel("r1"), "POST", "/runs/r1/cancel"],
    [() => ub.discover("hn"), "POST", "/capabilities/search", { query: "hn" }],
    [() => ub.capability("hn.top_stories"), "GET", "/capabilities/hn.top_stories"],
    [() => ub.skills(), "GET", "/skills"],
    [() => ub.learn({ har: { log: {} }, title: "T" }), "POST", "/learn", { har: { log: {} }, title: "T" }],
    [() => ub.learned(), "GET", "/learned"],
    [() => ub.learned("learned.a"), "GET", "/learned/learned.a"],
    [() => ub.usage(), "GET", "/usage"],
    [() => ub.me(), "GET", "/me"],
    [() => ub.logins.list(), "GET", "/logins"],
    [() => ub.logins.save({ origin: "https://a.test", username: "u", password: "p" }), "POST", "/logins", { origin: "https://a.test", username: "u", password: "p" }],
    [() => ub.logins.remove({ origin: "https://a.test" }), "POST", "/logins/remove", { origin: "https://a.test" }],
    [() => ub.accounts.connect({ origin: "https://a.test", username: "u", password: "p" }), "POST", "/accounts/connections", { origin: "https://a.test", username: "u", password: "p" }],
    [() => ub.accounts.register({ origin: "https://a.test", username: "u" }), "POST", "/accounts/register", { origin: "https://a.test", username: "u" }],
    [() => ub.vault(), "GET", "/vault"],
    [() => ub.sites("rust docs"), "GET", "/sites?q=rust%20docs"],
    [() => ub.site("https://www.en.wikipedia.org/wiki/X"), "GET", "/sites/en.wikipedia.org"],
    [() => ub.openapi("en.wikipedia.org"), "GET", "/sites/en.wikipedia.org/openapi.json"],
    [() => ub.callTool("en.wikipedia.org", "en_wikipedia_org__get_search_title", { query: "rust" }), "POST", "/sites/en.wikipedia.org/call/en_wikipedia_org__get_search_title", { query: "rust" }],
  ];
  for (const [call, method, path, body] of calls) {
    sent.length = 0;
    await call();
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ method, url: `https://x.test/api/v1${path}`, auth: "Bearer k" });
    if (body !== undefined) expect(sent[0]!.body).toEqual(body);
  }
  expect(ub.siteMcpUrl("www.en.wikipedia.org")).toBe("https://x.test/api/v1/sites/en.wikipedia.org/mcp");
});

test("resume sends snake_case (the route's format) from the documented camelCase", async () => {
  const { sent, fetch } = stub();
  await new Unbrowse({ apiKey: "k", fetch }).resume("r1", 4, [{ requirementId: "q1", expectedRevision: 2, action: "accept", values: { origin: "SIN" } }]);
  expect(sent[0]!.body).toEqual({ expected_state_revision: 4, responses: [{ requirement_id: "q1", expected_revision: 2, action: "accept", values: { origin: "SIN" } }] });
});

const asking = { runId: "r1", status: "input_required", stateRevision: 4, requirements: [{ id: "q1", revision: 2, affectedAction: "origin", state: "open" }] };

test("answer maps field names to open requirements, resumes, and returns the new view", async () => {
  let inspected = 0;
  const { sent, fetch } = stub((s) => (s.method === "GET" ? Response.json(inspected++ ? { ...asking, status: "succeeded" } : asking) : Response.json({})));
  const view = await new Unbrowse({ apiKey: "k", fetch }).answer("r1", { origin: "SIN" });
  expect(view.status).toBe("succeeded");
  expect(sent.map((s) => `${s.method} ${s.url.replace(DEFAULT_BASE_URL, "")}`)).toEqual(["GET /runs/r1", "POST /runs/r1/responses", "GET /runs/r1"]);
  expect((sent[1]!.body as { responses: unknown[] }).responses).toEqual([{ requirement_id: "q1", expected_revision: 2, action: "accept", values: { origin: "SIN" } }]);
});

test("answer refuses a field that is not open, before sending anything", async () => {
  const { sent, fetch } = stub(() => Response.json(asking));
  const err = await new Unbrowse({ apiKey: "k", fetch }).answer("r1", { nope: 1 }).catch((e) => e);
  expect(err).toBeInstanceOf(UnbrowseError);
  expect(err.message).toContain("Open: origin");
  expect(sent.filter((s) => s.method === "POST")).toHaveLength(0);
});

test("wait polls until the run leaves accepted/working", async () => {
  let n = 0;
  const { sent, fetch } = stub(() => Response.json({ runId: "r1", status: ++n < 3 ? "working" : "succeeded" }));
  expect((await new Unbrowse({ apiKey: "k", fetch }).wait("r1")).status).toBe("succeeded");
  expect(sent).toHaveLength(3);
});

test("errors carry status, code and body", async () => {
  const { fetch } = stub(() => Response.json({ error: { code: "quota_exceeded", message: "Monthly quota used" } }, { status: 402 }));
  const err = await new Unbrowse({ apiKey: "k", fetch }).run({ task: "t", idempotencyKey: "i" }).catch((e) => e);
  expect(err).toBeInstanceOf(UnbrowseError);
  expect(err).toMatchObject({ status: 402, code: "quota_exceeded", message: "Monthly quota used" });
});

test("harness.yaml and skill.md come back as text", async () => {
  const { fetch } = stub((s) => new Response(s.url.endsWith(".yaml") ? "apiVersion: unbrowse/v1alpha1" : "# Skill"));
  const ub = new Unbrowse({ apiKey: "k", fetch });
  expect(await ub.harnessYaml("learned.a")).toBe("apiVersion: unbrowse/v1alpha1");
  expect(await ub.skillMd("learned.a")).toBe("# Skill");
});

test("run sends the idempotency key the way the route reads it: idempotency_key and the header", async () => {
  const seen: Array<{ body: unknown; header: string | null }> = [];
  const fetch = (async (_url: string, init: RequestInit = {}) => {
    seen.push({ body: JSON.parse(String(init.body)), header: new Headers(init.headers).get("idempotency-key") });
    return Response.json({ runId: "r1", status: "succeeded" });
  }) as typeof globalThis.fetch;
  await new Unbrowse({ apiKey: "k", fetch }).run({ task: "t", idempotencyKey: "retry-1" });
  expect(seen[0]).toEqual({ body: { task: "t", idempotency_key: "retry-1" }, header: "retry-1" });
});

test("runOnClient sends each site request itself and posts the response back until the run finishes", async () => {
  const site: string[] = [];
  const api = stub((s) => {
    if (s.url.endsWith("/runs")) {
      expect(s.body).toMatchObject({ capability: "hn.top_stories", egress: "client" });
      return Response.json({ status: "egress_required", egressId: "eg_1", requests: [{ id: "rq_1", method: "GET", url: "https://site.example/api?q=1", headers: { accept: "application/json" }, redirect: "manual", curl: "curl …" }] }, { status: 202 });
    }
    expect(s.url).toBe("https://unbrowse.ai/api/v1/egress/eg_1");
    const b = s.body as { requestId: string; response: { status: number; body: string; bodyEncoding: string; headers: [string, string][] } };
    expect(b.requestId).toBe("rq_1");
    expect(b.response.status).toBe(200);
    expect(atob(b.response.body)).toBe('{"hits":[1]}');
    expect(b.response.headers).toContainEqual(["x-site", "yes"]);
    return Response.json({ runId: "run_1", status: "succeeded", result: { stories: [1] } });
  });
  const ub = new Unbrowse({ apiKey: "ub_live_x", fetch: api.fetch });
  const siteFetch = (async (url: string, init: RequestInit = {}) => {
    site.push(`${init.method} ${url} redirect=${init.redirect}`);
    return new Response('{"hits":[1]}', { status: 200, headers: { "x-site": "yes" } });
  }) as typeof globalThis.fetch;
  const run = await ub.runOnClient({ capability: "hn.top_stories" }, { fetch: siteFetch });
  expect(run.status).toBe("succeeded");
  expect(site).toEqual(["GET https://site.example/api?q=1 redirect=manual"]);
  // The API key went to Unbrowse only, never to the site.
  expect(api.sent.every((s) => s.auth === "Bearer ub_live_x")).toBe(true);
});

test("runOnClient reports a request it could not send, or one onRequest refused, as an error", async () => {
  const answers: unknown[] = [];
  let n = 0;
  const api = stub((s) => {
    if (s.url.endsWith("/runs")) return Response.json({ status: "egress_required", egressId: "eg_2", requests: [{ id: "rq_1", method: "GET", url: "https://a.example/", headers: {}, redirect: "follow", curl: "" }] }, { status: 202 });
    answers.push(s.body);
    return ++n === 1
      ? Response.json({ status: "egress_required", egressId: "eg_2", requests: [{ id: "rq_2", method: "POST", url: "https://b.example/", headers: {}, body: "aGk=", bodyEncoding: "base64", redirect: "follow", curl: "" }] }, { status: 202 })
      : Response.json({ runId: "run_2", status: "failed", error: { code: "upstream_error" } });
  });
  const ub = new Unbrowse({ apiKey: "k", fetch: api.fetch });
  const failing = (async () => {
    throw new TypeError("getaddrinfo ENOTFOUND a.example");
  }) as typeof globalThis.fetch;
  const run = await ub.runOnClient({ task: "x" }, { fetch: failing, onRequest: (r) => (r.url.startsWith("https://b.") ? false : undefined) });
  expect(run.status).toBe("failed");
  expect(answers).toEqual([
    { requestId: "rq_1", error: "getaddrinfo ENOTFOUND a.example" },
    { requestId: "rq_2", error: "refused by onRequest" },
  ]);
});

/** A fetch that also records request headers. */
function stubWithHeaders(reply: () => Response = () => Response.json({ runId: "lrun_1", status: "succeeded", result: { title: "serde" } })) {
  const sent: { method: string; url: string; headers: Headers; body: unknown }[] = [];
  const fetch = (async (url: string, init: RequestInit = {}) => {
    sent.push({ method: init.method ?? "GET", url, headers: new Headers(init.headers), body: init.body ? JSON.parse(String(init.body)) : undefined });
    return reply();
  }) as typeof globalThis.fetch;
  return { sent, fetch };
}

test("callTool sends the call options as the headers and body keys the endpoint reads", async () => {
  const { sent, fetch } = stubWithHeaders();
  const ub = new Unbrowse({ apiKey: "ub_live_k", fetch });
  const run = await ub.callTool<{ title: string }>("https://www.Docs.rs/x", "docs_rs__get_search", { query: "serde" }, { deadlineMs: 90000, idempotencyKey: "job-7", select: ["results[].title"], endUser: "u_42" });
  expect(run.result?.title).toBe("serde");
  const s = sent[0]!;
  expect(s).toMatchObject({ method: "POST", url: "https://unbrowse.ai/api/v1/sites/docs.rs/call/docs_rs__get_search", body: { query: "serde", select: ["results[].title"] } });
  expect(s.headers.get("x-unbrowse-deadline-ms")).toBe("90000");
  expect(s.headers.get("idempotency-key")).toBe("job-7");
  expect(s.headers.get("x-unbrowse-end-user")).toBe("u_42");
  expect(s.headers.get("authorization")).toBe("Bearer ub_live_k");
});

test("callTool without options sends exactly the inputs, as before", async () => {
  const { sent, fetch } = stubWithHeaders();
  await new Unbrowse({ fetch }).callTool("docs.rs", "docs_rs__get_search", { query: "serde" });
  expect(sent[0]!.body).toEqual({ query: "serde" });
  expect(sent[0]!.headers.get("x-unbrowse-deadline-ms")).toBeNull();
  expect(sent[0]!.headers.get("idempotency-key")).toBeNull();
});

test("a run_timeout throws with the runId to wait on", async () => {
  const { fetch } = stubWithHeaders(() => Response.json({ error: { code: "run_timeout", message: "did not finish", runId: "prun_9", poll: "GET /api/v1/runs/prun_9" } }, { status: 504 }));
  const err = await new Unbrowse({ fetch }).callTool("docs.rs", "t", {}).catch((e) => e);
  expect(err).toBeInstanceOf(UnbrowseError);
  expect(err.code).toBe("run_timeout");
  expect((err.body as { error: { runId: string } }).error.runId).toBe("prun_9");
});

test("forSite: one site's tools, OpenAPI, calls by name and its MCP URL", async () => {
  const { sent, fetch } = stubWithHeaders();
  const ub = new Unbrowse({ fetch });
  const docs = ub.forSite("WWW.docs.rs");
  expect(docs.host).toBe("docs.rs");
  await docs.tools();
  await docs.openapi();
  await docs.call("docs_rs__get_search", { query: "a" }, { deadlineMs: 5000 });
  const search = docs.tool("docs_rs__get_search");
  await search({ query: "b" });
  expect(sent.map((s) => `${s.method} ${s.url}`)).toEqual([
    "GET https://unbrowse.ai/api/v1/sites/docs.rs",
    "GET https://unbrowse.ai/api/v1/sites/docs.rs/openapi.json",
    "POST https://unbrowse.ai/api/v1/sites/docs.rs/call/docs_rs__get_search",
    "POST https://unbrowse.ai/api/v1/sites/docs.rs/call/docs_rs__get_search",
  ]);
  expect(sent[2]!.headers.get("x-unbrowse-deadline-ms")).toBe("5000");
  expect(sent[3]!.body).toEqual({ query: "b" });
  expect(docs.mcpUrl).toBe("https://unbrowse.ai/api/v1/sites/docs.rs/mcp");
});
