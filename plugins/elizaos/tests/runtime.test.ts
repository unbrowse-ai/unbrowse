// A REAL elizaOS 1.7.2 AgentRuntime (devDependency @elizaos/core@1.7.2), no database: registerPlugin and the
// plugin-loading half of initialize() need none. Pins how name collisions actually resolve in 1.7.2.
import { describe, expect, test } from "bun:test";
import { AgentRuntime, type Action, type ActionResult, type Character, type Plugin, type State } from "@elizaos/core";
import corePkg from "@elizaos/core/package.json" with { type: "json" };
import unbrowsePlugin from "../src/index.ts";
import { KEY, fakeMcp, msg, recorder, toolResult } from "./helpers.ts";

const MCP = "https://mcp.example.test/mcp";
const character = (): Character => ({
  name: "Tester",
  bio: "An agent that reads the web.",
  plugins: [],
  settings: { UNBROWSE_MCP_URL: MCP },
  secrets: { UNBROWSE_API_KEY: KEY },
});

const stubAction = (name: string, similes: string[] = []): Action => ({
  name,
  similes,
  description: `stub ${name}`,
  validate: async () => true,
  handler: async () => ({ success: true, text: `stub ${name}` }),
});
/** Stands in for @elizaos/plugin-browser and a host WEB_FETCH provider. */
const fakeBrowser = (withInit = false): Plugin => ({
  name: withInit ? "fake-browser-init" : "fake-browser",
  description: "stub browser",
  actions: [stubAction("BROWSER", ["BROWSE_SITE", "OPEN_SITE"]), stubAction("WEB_FETCH")],
  ...(withInit ? { init: async () => { await new Promise((r) => setTimeout(r, 5)); } } : {}),
});

const owner = (rt: AgentRuntime, name: string) => (rt.actions.find((a) => a.name === name)?.description ?? "").startsWith("stub") ? "stub" : "unbrowse";

describe(`real AgentRuntime (@elizaos/core ${corePkg.version})`, () => {
  test("is the pinned 1.7.2", () => expect(corePkg.version).toBe("1.7.2"));

  test("registerPlugin: all actions + provider; getSetting reads character secrets/settings", async () => {
    const rt = new AgentRuntime({ character: character() });
    await rt.registerPlugin(unbrowsePlugin);
    expect(rt.actions.map((a) => a.name)).toEqual(["WEB_FETCH", "UNBROWSE_BROWSE", "UNBROWSE_RUN", "UNBROWSE_DISCOVER", "UNBROWSE_RESUME"]);
    expect(rt.providers.map((p) => p.name)).toContain("UNBROWSE");
    expect(rt.getSetting("UNBROWSE_API_KEY")).toBe(KEY);
    expect(rt.getSetting("UNBROWSE_MCP_URL")).toBe(MCP);
  });

  test("first-wins: ours registered before a plugin with WEB_FETCH keeps WEB_FETCH; BROWSER stays theirs", async () => {
    const rt = new AgentRuntime({ character: character() });
    await rt.registerPlugin(unbrowsePlugin);
    await rt.registerPlugin(fakeBrowser());
    expect(owner(rt, "WEB_FETCH")).toBe("unbrowse");
    expect(owner(rt, "BROWSER")).toBe("stub");
    expect(rt.actions.filter((a) => a.name === "WEB_FETCH")).toHaveLength(1);
  });

  test("first-wins the other way: a WEB_FETCH registered earlier keeps it (documented: list unbrowse first)", async () => {
    const rt = new AgentRuntime({ character: character() });
    await rt.registerPlugin(fakeBrowser());
    await rt.registerPlugin(unbrowsePlugin);
    expect(owner(rt, "WEB_FETCH")).toBe("stub");
    expect(owner(rt, "UNBROWSE_RUN")).toBe("unbrowse");
  });

  test("initialize(): plugins register concurrently; an `init` delays a plugin's actions, so init-free unbrowse wins even when listed second", async () => {
    const rt = new AgentRuntime({ character: character(), plugins: [fakeBrowser(true), unbrowsePlugin] });
    // No database adapter: initialize() registers every plugin, then throws for the missing SQL plugin.
    await expect(rt.initialize()).rejects.toThrow(/Database adapter not initialized/);
    expect(owner(rt, "WEB_FETCH")).toBe("unbrowse");

    const rt2 = new AgentRuntime({ character: character(), plugins: [fakeBrowser(false), unbrowsePlugin] });
    await expect(rt2.initialize()).rejects.toThrow(/Database adapter/);
    expect(owner(rt2, "WEB_FETCH")).toBe("stub"); // an init-free plugin listed first still wins: list unbrowse first
  });

  test("handler through the real runtime: runtime.fetch + character secret reach the MCP call", async () => {
    const mcp = fakeMcp({ "unbrowse.scrape": () => toolResult({ markdown: "# Example Domain", metadata: { title: "Example Domain" } }) });
    const rt = new AgentRuntime({ character: character(), fetch: mcp.fetch });
    await rt.registerPlugin(unbrowsePlugin);
    const action = rt.actions.find((a) => a.name === "WEB_FETCH")!;
    const m = msg("read https://example.com");
    expect(await action.validate(rt, m)).toBe(true);
    const rec = recorder();
    const r = (await action.handler(rt, m, {} as State, {}, rec.callback)) as ActionResult;
    expect(r.success).toBe(true);
    expect(r.text).toContain("Example Domain");
    expect(rec.sent[0].actions).toEqual(["WEB_FETCH"]);
    expect(mcp.toolCalls()[0]).toMatchObject({ url: MCP, args: { url: "https://example.com" } });
    expect(mcp.toolCalls()[0].headers.authorization).toBe(`Bearer ${KEY}`);
  });

  test("provider through the real runtime", async () => {
    const mcp = fakeMcp({ "unbrowse.run": () => toolResult({}) });
    const rt = new AgentRuntime({ character: character(), fetch: mcp.fetch });
    await rt.registerPlugin(unbrowsePlugin);
    const p = rt.providers.find((x) => x.name === "UNBROWSE")!;
    const r = await p.get(rt, msg("hi"), {} as State);
    expect(r.text).toContain("Status: connected (1 tools available)");
  });

  test("real processActions: planner names/similes resolve to Unbrowse, results + callbacks flow through", async () => {
    // 1.7.2 resolves a planner action by exact name, then name substring, then similes in registration order.
    // processActions persists memories and logs; those DB calls are stubbed, the routing and handler call are real.
    const mcp = fakeMcp({
      "unbrowse.scrape": () => toolResult({ markdown: "# Example Domain", metadata: { title: "Example Domain" } }),
      "unbrowse.browse.open": (a) => toolResult({ sessionId: "s1", url: a.url, title: "Shop", text: "Welcome" }),
      "unbrowse.browse.close": () => toolResult({ closed: true }),
    });
    const rt = new AgentRuntime({ character: character(), fetch: mcp.fetch });
    await rt.registerPlugin(unbrowsePlugin);
    await rt.registerPlugin(fakeBrowser()); // plugin-browser stand-in, registered after us
    const memories: any[] = [];
    Object.assign(rt, {
      composeState: async () => ({ values: {}, data: {}, text: "" }),
      createMemory: async (m: unknown) => { memories.push(m); return "00000000-0000-0000-0000-000000000001"; },
      adapter: { log: async () => undefined },
    });
    const run = async (text: string, actions: string[]) => {
      const rec = recorder();
      const m = msg(text);
      await rt.processActions(m, [{ ...m, content: { text: "", actions } }], { values: {}, data: {}, text: "" } as State, rec.callback as any);
      return rec.sent;
    };
    expect((await run("read https://example.com", ["WEB_FETCH"]))[0]).toMatchObject({ actions: ["WEB_FETCH"] });
    expect((await run("read https://example.com", ["READ_URL"]))[0].text).toContain("Example Domain");
    const browsed = await run("open https://shop.test", ["BROWSE_SITE"]);
    expect(browsed[0]).toMatchObject({ actions: ["UNBROWSE_BROWSE"] });
    expect(mcp.toolCalls().map((c) => c.name)).toEqual(["unbrowse.scrape", "unbrowse.scrape", "unbrowse.browse.open", "unbrowse.browse.close"]);
    // BROWSER itself still goes to plugin-browser when it is loaded: remove it to hand browsing to Unbrowse.
    expect((await run("open https://shop.test", ["BROWSER"])).length).toBe(0);
    const results = memories.filter((m) => m.content?.type === "action_result").map((m) => [m.content.actionName, m.content.actionStatus]);
    expect(results).toEqual([["WEB_FETCH", "completed"], ["WEB_FETCH", "completed"], ["UNBROWSE_BROWSE", "completed"], ["BROWSER", "completed"]]);
  });
});
