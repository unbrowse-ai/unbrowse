// Offline: every action, the provider and the parsing, against a fake hosted MCP and a mock runtime.
import { beforeEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import plugin, { browseAction, discoverAction, resumeAction, runAction, unbrowseProvider, webFetchAction } from "../src/index.ts";
import { answersFrom } from "../src/actions.ts";
import { describeError } from "../src/client.ts";
import { UnbrowseError } from "@unbrowse/sdk";
import { resetConnectionStatus } from "../src/provider.ts";
import { loadSkill, parseSkill } from "../src/skill.ts";
import { extractUrls, parsePairs } from "../src/text.ts";
import { KEY, ROOM, fakeMcp, mockRuntime, msg, recorder, toolResult } from "./helpers.ts";
import type { Action, ActionResult, IAgentRuntime, Memory, State } from "@elizaos/core";

const MCP = "https://mcp.example.test/api/mcp";
const base = { UNBROWSE_API_KEY: KEY, UNBROWSE_MCP_URL: MCP, UNBROWSE_POLL_MS: "1" };

beforeEach(() => {
  // Offline tests must never pick up a real key or endpoint from the shell.
  for (const k of Object.keys(process.env)) if (k.startsWith("UNBROWSE_")) delete process.env[k];
});

async function invoke(action: Action, runtime: IAgentRuntime, message: Memory, options?: Record<string, unknown>) {
  const rec = recorder();
  const result = (await action.handler(runtime, message, {} as State, options, rec.callback)) as ActionResult;
  // The key never leaks into anything the agent sees.
  expect(JSON.stringify(result)).not.toContain(KEY);
  expect(JSON.stringify(rec.sent)).not.toContain(KEY);
  return { result, sent: rec.sent };
}

const scrapeOk = () => toolResult({ url: "https://example.com", finalUrl: "https://example.com/", via: "http", metadata: { title: "Example Domain", statusCode: 200 }, markdown: "# Example Domain\n\nThis domain is for use in documentation examples." });

describe("parsing", () => {
  test("extractUrls: schemes, trailing punctuation, dedupe, bare domains, not emails", () => {
    expect(extractUrls("read https://example.com.")).toEqual(["https://example.com"]);
    expect(extractUrls("see (https://a.test/x?y=1) and https://a.test/x?y=1, then http://b.test/")).toEqual(["https://a.test/x?y=1", "http://b.test/"]);
    expect(extractUrls("what's on news.ycombinator.com today?")).toEqual(["https://news.ycombinator.com"]);
    expect(extractUrls("mail me at bob@example.com")).toEqual([]);
    expect(extractUrls("top stories on hacker news")).toEqual([]);
    expect(extractUrls(undefined)).toEqual([]);
  });

  test("parsePairs reads field: value and field = value, skips URL schemes", () => {
    expect(parsePairs("origin: SFO, date = 2026-10-03; note: \"a, b\"")).toEqual({ origin: "SFO", date: "2026-10-03", note: "a, b" });
    expect(parsePairs("read https://example.com")).toEqual({});
  });

  test("answersFrom maps plain replies, choices by number and label", () => {
    const one = [{ affectedAction: "destination", reason: "Where to?" }];
    expect(answersFrom("JFK", one)).toEqual({ destination: "JFK" });
    const choice = [{ affectedAction: "selected_offer", options: [{ label: "Economy", value: "e1" }, { label: "Business", value: "b1" }] }];
    expect(answersFrom("2", choice)).toEqual({ selected_offer: "b1" });
    expect(answersFrom("selected_offer: economy", choice)).toEqual({ selected_offer: "e1" });
    const two = [{ affectedAction: "origin" }, { affectedAction: "date" }];
    expect(answersFrom("Origin: SFO, date: tomorrow, junk: x", two)).toEqual({ origin: "SFO", date: "tomorrow" });
    expect(answersFrom("x", two, { origin: "LAX" })).toEqual({ origin: "LAX" });
  });

  test("skill: parsed from the shipped SKILL.md", () => {
    const s = loadSkill();
    expect(s.path).toBeDefined();
    expect(existsSync(s.path!)).toBe(true);
    expect(s.steps.length).toBeGreaterThanOrEqual(4);
    expect(s.steps[0]).toContain("unbrowse_discover");
    expect(s.rules.join(" ")).toContain("passwords");
    expect(parseSkill("no frontmatter").steps.length).toBeGreaterThan(0); // falls back
  });
});

describe("plugin shape", () => {
  test("exports actions, provider, no init (1.x first-wins needs it)", () => {
    expect(plugin.name).toBe("unbrowse");
    expect(plugin.actions!.map((a) => a.name)).toEqual(["WEB_FETCH", "UNBROWSE_BROWSE", "UNBROWSE_RUN", "UNBROWSE_DISCOVER", "UNBROWSE_RESUME"]);
    expect(plugin.providers!.map((p) => p.name)).toEqual(["UNBROWSE"]);
    expect(plugin.init).toBeUndefined();
    for (const a of plugin.actions!) {
      expect(a.description.length).toBeGreaterThan(40);
      expect(typeof a.routingHint).toBe("string");
      expect(Array.isArray(a.parameters)).toBe(true);
      expect(a.examples!.length).toBeGreaterThan(0);
      expect(a.similes).not.toContain("BROWSER"); // never shadow plugin-browser's own name
    }
  });

  test("package.json agentConfig declares the settings", async () => {
    const pkg = await import("../package.json", { with: { type: "json" } }).then((m) => m.default as Record<string, any>);
    expect(pkg.name).toBe("@unbrowse/plugin-unbrowse");
    expect(pkg.version).toBe(JSON.parse(require("node:fs").readFileSync(new URL("../../../packages/cli/package.json", import.meta.url), "utf8")).version);
    expect(pkg.agentConfig.pluginType).toBe("elizaos:plugin:1.0.0");
    expect(pkg.agentConfig.pluginParameters.UNBROWSE_API_KEY).toMatchObject({ type: "string", required: true, sensitive: true });
    expect(Object.keys(pkg.agentConfig.pluginParameters)).toEqual(["UNBROWSE_API_KEY", "UNBROWSE_MCP_URL", "UNBROWSE_END_USER"]);
    expect(pkg.files).toEqual(expect.arrayContaining(["dist", "skill", "README.md"]));
    expect(pkg.dependencies).toBeUndefined();
    expect(pkg.peerDependencies["@elizaos/core"]).toBeDefined();
  });
});

describe("WEB_FETCH", () => {
  test("validate: needs a URL in the text or in 2.x parameters", async () => {
    const rt = mockRuntime(base);
    expect(await webFetchAction.validate(rt, msg("read https://example.com"))).toBe(true);
    expect(await webFetchAction.validate(rt, msg("what's the weather"))).toBe(false);
    expect(await (webFetchAction.validate as any)(rt, msg("read it"), {}, { parameters: { url: "https://x.test" } })).toBe(true);
  });

  test("handler: scrape → markdown, callback, headers, endpoint", async () => {
    const mcp = fakeMcp({ "unbrowse.scrape": () => scrapeOk() }, { sse: true });
    const rt = mockRuntime({ ...base, UNBROWSE_END_USER: "user-42" }, mcp.fetch);
    const { result, sent } = await invoke(webFetchAction, rt, msg("read https://example.com"));
    expect(result.success).toBe(true);
    expect(result.text).toContain("Example Domain");
    expect(result.data).toMatchObject({ actionName: "WEB_FETCH", kind: "scraped", url: "https://example.com", title: "Example Domain", statusCode: 200 });
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ actions: ["WEB_FETCH"], source: "unbrowse" });
    expect(sent[0].text).toContain("Example Domain");
    const call = mcp.toolCalls()[0];
    expect(call.url).toBe(MCP);
    expect(call.args).toEqual({ url: "https://example.com" });
    expect(call.headers.authorization).toBe(`Bearer ${KEY}`);
    expect(call.headers["x-unbrowse-end-user"]).toBe("user-42");
    expect(call.headers["user-agent"]).toBe("unbrowse-elizaos");
  });

  test("handler: 2.x parameters.url wins over the text", async () => {
    const mcp = fakeMcp({ "unbrowse.scrape": () => scrapeOk() });
    await invoke(webFetchAction, mockRuntime(base, mcp.fetch), msg("read https://other.test"), { parameters: { url: "https://example.com" } });
    expect(mcp.toolCalls()[0].args).toEqual({ url: "https://example.com" });
  });

  test("long pages are clipped to UNBROWSE_MAX_CHARS", async () => {
    const mcp = fakeMcp({ "unbrowse.scrape": () => toolResult({ markdown: "x".repeat(5000), metadata: {} }) });
    const { result } = await invoke(webFetchAction, mockRuntime({ ...base, UNBROWSE_MAX_CHARS: "1000" }, mcp.fetch), msg("read https://a.test"));
    expect(result.text!.length).toBeLessThan(1200);
    expect(result.text).toContain("more characters");
  });

  test("tool isError → success:false", async () => {
    const mcp = fakeMcp({ "unbrowse.scrape": () => ({ result: { content: [{ type: "text", text: "destination_denied: private address" }], isError: true } }) });
    const { result, sent } = await invoke(webFetchAction, mockRuntime(base, mcp.fetch), msg("read https://10.0.0.1"));
    expect(result.success).toBe(false);
    expect(result.error).toContain("destination_denied");
    expect(sent[0].text).toContain("could not read");
  });

  test("render failure → one plain-HTTP retry (render: never), flagged renderFallback", async () => {
    const mcp = fakeMcp({ "unbrowse.scrape": (a) => (a.render === "never" ? scrapeOk() : { error: { code: -32000, message: "page.goto: net::ERR_TUNNEL_CONNECTION_FAILED at https://example.com/", data: null } }) });
    const { result } = await invoke(webFetchAction, mockRuntime(base, mcp.fetch), msg("read https://example.com"));
    expect(mcp.toolCalls().map((c) => c.args)).toEqual([{ url: "https://example.com" }, { url: "https://example.com", render: "never" }]);
    expect(result.success).toBe(true);
    expect(result.data).toMatchObject({ renderFallback: true });
    expect(result.text).toContain("Example Domain");
  });

  test("render failure and an empty HTTP retry → the original error", async () => {
    const mcp = fakeMcp({ "unbrowse.scrape": (a) => (a.render === "never" ? toolResult({ markdown: "" }) : { error: { code: -32000, message: "page.goto: net::ERR_TUNNEL_CONNECTION_FAILED" } }) });
    const { result } = await invoke(webFetchAction, mockRuntime(base, mcp.fetch), msg("read https://spa.test"));
    expect(result.success).toBe(false);
    expect(result.text).toContain("ERR_TUNNEL_CONNECTION_FAILED");
  });

  test("site errors are not retried", async () => {
    const mcp = fakeMcp({ "unbrowse.scrape": () => ({ error: { code: -32003, message: "destination denied", data: { code: "destination_denied" } } }) });
    const { result } = await invoke(webFetchAction, mockRuntime(base, mcp.fetch), msg("read https://10.0.0.1"));
    expect(result.success).toBe(false);
    expect(mcp.toolCalls()).toHaveLength(1);
  });

  test("no key → clear error, no network", async () => {
    const mcp = fakeMcp({ "unbrowse.scrape": () => scrapeOk() });
    const { result } = await invoke(webFetchAction, mockRuntime({ UNBROWSE_MCP_URL: MCP }, mcp.fetch), msg("read https://example.com"));
    expect(result.success).toBe(false);
    expect(result.text).toContain("UNBROWSE_API_KEY is not set");
    expect(result.data).toMatchObject({ kind: "missing_api_key" });
    expect(mcp.calls).toHaveLength(0);
  });

  test("browser_capacity → success:false with retryAfter", async () => {
    const mcp = fakeMcp({ "unbrowse.scrape": () => ({ error: { code: -32000, message: "Every cloud browser is busy (8 in use); retry in about 30 seconds", data: { code: "browser_capacity", details: { retryAfter: 45, capacity: 8 } } } }) });
    const { result, sent } = await invoke(webFetchAction, mockRuntime(base, mcp.fetch), msg("read https://spa.test"));
    expect(result.success).toBe(false);
    expect(result.data).toMatchObject({ kind: "browser_capacity", error: { code: "browser_capacity", retryAfter: 45 } });
    expect(sent[0].text).toContain("about 45 seconds");
  });

  test("401 invalid_token → tells the owner to replace the key", async () => {
    const mcp = fakeMcp({ "unbrowse.scrape": () => ({ http: 401, body: { error: "invalid_token", error_description: "The access token is invalid" } }) });
    const { result } = await invoke(webFetchAction, mockRuntime(base, mcp.fetch), msg("read https://example.com"));
    expect(result.success).toBe(false);
    expect(result.data).toMatchObject({ kind: "invalid_token" });
    expect(result.text).toContain("Replace UNBROWSE_API_KEY");
  });

  test("quota elicitation carries the top-up link", () => {
    const e = describeError(Object.assign(new Error("Out of credits"), { code: "rpc_-32042" }));
    expect(e.code).toBe("rpc_-32042");
    const withBody = describeError(new UnbrowseError("Out of credits", 200, "quota_exceeded", { data: { details: { topUp: "https://unbrowse.ai/app/billing" } } }));
    expect(withBody.text).toContain("https://unbrowse.ai/app/billing");
  });
});

describe("UNBROWSE_RUN", () => {
  test("succeeded: task routed, result returned", async () => {
    const mcp = fakeMcp({ "unbrowse.run": (a) => toolResult({ runId: "run_1", status: "succeeded", capabilityId: "hn.top_stories", verified: true, result: { stories: [{ title: "PipePipe" }] }, args: a }) });
    const { result, sent } = await invoke(runAction, mockRuntime(base, mcp.fetch), msg("top stories on hacker news"));
    expect(mcp.toolCalls()[0].args).toEqual({ task: "top stories on hacker news" });
    expect(result.success).toBe(true);
    expect(result.text).toContain("hn.top_stories");
    expect(result.text).toContain("PipePipe");
    expect(result.values).toMatchObject({ unbrowseStatus: "succeeded", unbrowseRunId: "run_1" });
    expect(sent[0].actions).toEqual(["UNBROWSE_RUN"]);
  });

  test("URL in the text becomes targetUrl; 2.x parameters pass capability and input", async () => {
    const mcp = fakeMcp({ "unbrowse.run": () => toolResult({ runId: "run_2", status: "succeeded", result: {} }) });
    const rt = mockRuntime(base, mcp.fetch);
    await invoke(runAction, rt, msg("list the jobs on https://jobs.test/board"));
    expect(mcp.toolCalls()[0].args).toEqual({ task: "list the jobs on https://jobs.test/board", targetUrl: "https://jobs.test/board" });
    await invoke(runAction, rt, msg("x"), { parameters: { task: "flights", capability: "air.search", input: '{"origin":"SFO"}' } });
    expect(mcp.toolCalls()[1].args).toEqual({ capability: "air.search", task: "flights", input: { origin: "SFO" } });
  });

  test("still running → polls unbrowse.inspect until terminal", async () => {
    let n = 0;
    const mcp = fakeMcp({
      "unbrowse.run": () => toolResult({ runId: "run_p", status: "running" }),
      "unbrowse.inspect": () => toolResult({ runId: "run_p", status: ++n < 2 ? "running" : "succeeded", result: { ok: 1 } }),
    });
    const { result } = await invoke(runAction, mockRuntime(base, mcp.fetch), msg("slow task"));
    expect(result.success).toBe(true);
    expect(mcp.toolCalls().map((c) => c.name)).toEqual(["unbrowse.run", "unbrowse.inspect", "unbrowse.inspect"]);
  });

  test("input_required → asks for the fields; UNBROWSE_RESUME answers the same run", async () => {
    const mcp = fakeMcp({
      "unbrowse.run": () => toolResult({ runId: "run_q", status: "input_required", requirements: [
        { id: "r1", affectedAction: "origin", reason: "Departure airport", state: "open" },
        { id: "r2", affectedAction: "date", reason: "Travel date", state: "open" },
        { id: "r0", affectedAction: "old", reason: "done", state: "answered" },
      ] }, false),
      "unbrowse.resume": (a) => toolResult({ runId: a.runId, status: "succeeded", result: { price: 199 } }),
    });
    const rt = mockRuntime(base, mcp.fetch);
    const first = await invoke(runAction, rt, msg("cheapest flight to JFK"));
    expect(first.result.success).toBe(true); // paused, not failed
    expect(first.result.values).toMatchObject({ unbrowseStatus: "input_required", unbrowseRunId: "run_q" });
    expect(first.result.data).toMatchObject({ fields: ["origin", "date"] });
    expect(first.sent[0].text).toContain("origin: Departure airport");
    expect(first.sent[0].text).not.toContain("old");

    const provided = await unbrowseProvider.get(rt, msg("hi"), {} as State);
    expect(provided.text).toContain("Paused run run_q waits for: origin, date");

    expect(await resumeAction.validate(rt, msg("origin: SFO, date: 2026-10-03"))).toBe(true);
    expect(await resumeAction.validate(rt, msg("anything", "00000000-0000-0000-0000-00000000ffff" as any))).toBe(false);
    const second = await invoke(resumeAction, rt, msg("origin: SFO, date: 2026-10-03"));
    expect(mcp.toolCalls()[1]).toMatchObject({ name: "unbrowse.resume", args: { runId: "run_q", answers: { origin: "SFO", date: "2026-10-03" } } });
    expect(second.result.success).toBe(true);
    expect(second.result.text).toContain("199");
    expect(await resumeAction.validate(rt, msg("origin: SFO"))).toBe(false); // cleared after success
  });

  test("resume with no answer it can parse asks again, without calling the server", async () => {
    const mcp = fakeMcp({ "unbrowse.run": () => toolResult({ runId: "run_z", status: "input_required", requirements: [{ affectedAction: "a" }, { affectedAction: "b" }] }) });
    const rt = mockRuntime(base, mcp.fetch);
    await invoke(runAction, rt, msg("do it"));
    const { result } = await invoke(resumeAction, rt, msg("hmm not sure"));
    expect(result.success).toBe(false);
    expect(result.text).toContain("(a, b)");
    expect(mcp.toolCalls()).toHaveLength(1);
  });

  test("no_capability with a URL → cloud browser fallback (open, then close)", async () => {
    const mcp = fakeMcp({
      "unbrowse.run": () => toolResult({ runId: "run_n", status: "failed", phase: "no_capability", error: { code: "no_capability", message: "No learned or public capability fits" }, result: { next: { tool: "unbrowse.browse.open", url: "https://shop.test/" } } }, true),
      "unbrowse.browse.open": (a) => toolResult({ sessionId: "s1", url: a.url, title: "Shop", text: "Welcome to the shop", elements: [{ ref: "e1" }] }),
      "unbrowse.browse.close": () => toolResult({ closed: true }),
    });
    const { result } = await invoke(runAction, mockRuntime(base, mcp.fetch), msg("what's on sale at https://shop.test/"));
    expect(mcp.toolCalls().map((c) => c.name)).toEqual(["unbrowse.run", "unbrowse.browse.open", "unbrowse.browse.close"]);
    expect(mcp.toolCalls()[1].args).toEqual({ url: "https://shop.test/", task: "what's on sale at https://shop.test/" });
    expect(result.success).toBe(true);
    expect(result.data).toMatchObject({ kind: "browsed_after_no_capability", fallbackFrom: "no_capability", runId: "run_n", sessionId: "s1" });
    expect(result.text).toContain("Welcome to the shop");
  });

  test("no_capability without any URL → honest failure that suggests UNBROWSE_BROWSE", async () => {
    const mcp = fakeMcp({ "unbrowse.run": () => toolResult({ runId: "run_m", status: "failed", error: { code: "no_capability", message: "nothing fits" }, result: { next: { tool: "unbrowse.browse.open" } } }, true) });
    const { result } = await invoke(runAction, mockRuntime(base, mcp.fetch), msg("book my dentist"));
    expect(result.success).toBe(false);
    expect(result.data).toMatchObject({ kind: "no_capability", suggestion: "UNBROWSE_BROWSE" });
    expect(result.text).toContain("Give me the site's URL");
    expect(mcp.toolCalls()).toHaveLength(1);
  });

  test("UNBROWSE_BROWSE_FALLBACK=false disables the browser fallback", async () => {
    const mcp = fakeMcp({ "unbrowse.run": () => toolResult({ runId: "r", status: "failed", error: { code: "no_capability" } }, true) });
    const { result } = await invoke(runAction, mockRuntime({ ...base, UNBROWSE_BROWSE_FALLBACK: "false" }, mcp.fetch), msg("do x on https://a.test"));
    expect(result.success).toBe(false);
    expect(mcp.toolCalls()).toHaveLength(1);
  });

  test("failed run and outcome_unknown are failures; login needed returns the link", async () => {
    const replies = [
      toolResult({ runId: "r1", status: "failed", error: { code: "upstream_error", message: "site returned 500" } }, true),
      toolResult({ runId: "r2", status: "outcome_unknown" }),
      toolResult({ runId: "r3", status: "failed", error: { code: "login_required", message: "needs login" }, signIn: { url: "https://unbrowse.ai/connect/abc" } }, true),
    ];
    const mcp = fakeMcp({ "unbrowse.run": () => replies.shift()! });
    const rt = mockRuntime(base, mcp.fetch);
    const a = await invoke(runAction, rt, msg("t1"));
    expect(a.result).toMatchObject({ success: false, error: "site returned 500" });
    const b = await invoke(runAction, rt, msg("t2"));
    expect(b.result.success).toBe(false);
    expect(b.result.text).toContain("could not confirm");
    const c = await invoke(runAction, rt, msg("t3"));
    expect(c.result.success).toBe(false);
    expect(c.result.text).toContain("https://unbrowse.ai/connect/abc");
  });

  test("validate: any real message or a task parameter", async () => {
    const rt = mockRuntime(base);
    expect(await runAction.validate(rt, msg("top stories on hacker news"))).toBe(true);
    expect(await runAction.validate(rt, msg(""))).toBe(false);
    expect(await (runAction.validate as any)(rt, msg(""), {}, { parameters: { task: "x" } })).toBe(true);
  });
});

describe("UNBROWSE_DISCOVER and UNBROWSE_BROWSE", () => {
  test("discover lists the recommended capability and inputs", async () => {
    const mcp = fakeMcp({ "unbrowse.discover": (a) => toolResult({ recommended: { id: "hn.top_stories", confidence: 0.97 }, capabilities: [
      { id: "hn.top_stories", title: "Hacker News top stories", origin: "hn.algolia.com", inputs: ["limit"] },
      { id: "learned.x", title: "other" },
    ], query: a.query }) });
    const { result, sent } = await invoke(discoverAction, mockRuntime(base, mcp.fetch), msg("top stories on hacker news"));
    expect(mcp.toolCalls()[0].args).toEqual({ query: "top stories on hacker news" });
    expect(result.success).toBe(true);
    expect(result.text).toContain("Recommended: hn.top_stories (confidence 0.97)");
    expect(result.text).toContain("inputs: limit");
    expect((result.data as any).capabilities).toHaveLength(2);
    expect(sent[0].actions).toEqual(["UNBROWSE_DISCOVER"]);
  });

  test("discover with nothing found says so", async () => {
    const mcp = fakeMcp({ "unbrowse.discover": () => toolResult({ capabilities: [] }) });
    const { result } = await invoke(discoverAction, mockRuntime(base, mcp.fetch), msg("zzz qqq"));
    expect(result.success).toBe(true);
    expect(result.data).toMatchObject({ kind: "none" });
  });

  test("browse opens with the task, returns page text, closes the session", async () => {
    const mcp = fakeMcp({
      "unbrowse.browse.open": (a) => toolResult({ sessionId: "s9", url: a.url, title: "HN", text: "1. Story one", elements: [] }),
      "unbrowse.browse.close": () => toolResult({ closed: true }),
    });
    const rt = mockRuntime(base, mcp.fetch);
    expect(await browseAction.validate(rt, msg("open https://news.ycombinator.com"))).toBe(true);
    expect(await browseAction.validate(rt, msg("open the site"))).toBe(false);
    const { result, sent } = await invoke(browseAction, rt, msg("open https://news.ycombinator.com and read the front page"));
    expect(mcp.toolCalls()[0].args).toEqual({ url: "https://news.ycombinator.com", task: "open https://news.ycombinator.com and read the front page" });
    expect(mcp.toolCalls()[1]).toMatchObject({ name: "unbrowse.browse.close", args: { sessionId: "s9" } });
    expect(result.success).toBe(true);
    expect(result.text).toContain("Story one");
    expect(sent[0].actions).toEqual(["UNBROWSE_BROWSE"]);
  });

  test("browse at capacity reports retryAfter and opens nothing to close", async () => {
    const mcp = fakeMcp({ "unbrowse.browse.open": () => ({ error: { code: -32000, message: "busy", data: { code: "browser_capacity", details: { retryAfter: 30 } } } }) });
    const { result } = await invoke(browseAction, mockRuntime(base, mcp.fetch), msg("open https://a.test"));
    expect(result.success).toBe(false);
    expect(result.data).toMatchObject({ error: { retryAfter: 30 } });
    expect(mcp.toolCalls()).toHaveLength(1);
  });
});

describe("UNBROWSE provider", () => {
  test("not configured: says so, no network", async () => {
    const mcp = fakeMcp({});
    const rt = mockRuntime({}, mcp.fetch);
    const r = await unbrowseProvider.get(rt, msg("hi"), {} as State);
    expect(r.text).toContain("NOT configured");
    expect(r.text).toContain("WEB_FETCH");
    expect(r.values).toMatchObject({ unbrowseConfigured: false, unbrowseConnected: false });
    expect(mcp.calls).toHaveLength(0);
  });

  test("configured: one tools/list, cached; guidance comes from the skill", async () => {
    const mcp = fakeMcp({}, { toolList: [{ name: "unbrowse.run" }, { name: "unbrowse.scrape" }, { name: "unbrowse.discover" }] });
    const rt = mockRuntime(base, mcp.fetch);
    const r = await unbrowseProvider.get(rt, msg("hi"), {} as State);
    await unbrowseProvider.get(rt, msg("again"), {} as State);
    expect(mcp.calls.filter((c) => c.method === "tools/list")).toHaveLength(1);
    expect(r.text).toContain("connected (3 tools available)");
    expect(r.text).toContain("not BROWSER");
    expect(r.text).toContain("unbrowse_discover");
    expect(r.text).toContain("passwords");
    expect(r.text!.length).toBeLessThan(2000);
    expect(r.values).toMatchObject({ unbrowseConfigured: true, unbrowseConnected: true });
    expect((r.data as any).skillPath).toContain("skill/SKILL.md");
    expect(JSON.stringify(r)).not.toContain(KEY);
  });

  test("configured but rejected: reports unreachable with the reason", async () => {
    const mcp = fakeMcp({});
    const failing = (async () => new Response(JSON.stringify({ error: "invalid_token" }), { status: 401 })) as unknown as typeof fetch;
    const rt = mockRuntime(base, failing);
    resetConnectionStatus(rt);
    const r = await unbrowseProvider.get(rt, msg("hi"), {} as State);
    expect(r.text).toContain("unreachable");
    expect(r.text).toContain("Replace UNBROWSE_API_KEY");
    expect(mcp.calls).toHaveLength(0);
  });

  test("settings fall back to process.env", async () => {
    process.env.UNBROWSE_API_KEY = KEY;
    process.env.UNBROWSE_MCP_URL = MCP;
    const mcp = fakeMcp({ "unbrowse.scrape": () => scrapeOk() });
    const { result } = await invoke(webFetchAction, mockRuntime({}, mcp.fetch), msg("read https://example.com"));
    expect(result.success).toBe(true);
    expect(mcp.toolCalls()[0].url).toBe(MCP);
  });
});

test("a callback that throws does not fail the action", async () => {
  const mcp = fakeMcp({ "unbrowse.scrape": () => scrapeOk() });
  const r = (await webFetchAction.handler(mockRuntime(base, mcp.fetch), msg("read https://example.com"), {} as State, {}, async () => {
    throw new Error("host down");
  })) as ActionResult;
  expect(r.success).toBe(true);
});

test("ROOM constant is a uuid", () => expect(ROOM).toMatch(/^[0-9a-f-]{36}$/));
