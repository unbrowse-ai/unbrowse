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
  expect(DEFAULT_BASE_URL).toBe("https://v3.unbrowse.ai/api/v1");
  await ub.me();
  expect(sent[0]).toMatchObject({ url: "https://v3.unbrowse.ai/api/v1/me", auth: "Bearer ub_live_env" });
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
