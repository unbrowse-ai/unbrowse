/**
 * GATE: the server's browse-session interface is satisfiable from obscura.
 *
 * browse-session.ts depends on a narrow six-method BrowseSessionClient, not on
 * kuri. If obscura can satisfy that interface, the server session registry runs
 * Chrome-free with none of its own logic changed — which is what makes
 * src/kuri/client.ts deletable. Hermetic: an injected client, no broker spawn.
 */

import { test, expect, describe } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  ObscuraBrowseSessionClient,
  parseTabId,
  parseTabList,
  OBSCURA_SINGLE_TAB,
} from "../src/obscura/browse-session-client.js";
import { ObscuraHttpClient } from "../src/obscura/session-broker.js";
import type { BrowseSessionClient } from "../src/api/browse-session.js";

/** An ObscuraHttpClient whose transport is a canned tool->reply map. */
function fakeClient(replies: Record<string, string>, seen: string[] = []) {
  const fetchImpl = (async (_u: string, init: { body: string }) => {
    const req = JSON.parse(init.body);
    if (req.method !== "tools/call") return { text: async () => JSON.stringify({ result: {} }) };
    const name = req.params.name as string;
    seen.push(name);
    if (!(name in replies)) throw new Error(`tool ${name} unsupported`);
    return { text: async () => JSON.stringify({ result: { content: [{ type: "text", text: replies[name] }] } }) };
  }) as unknown as typeof fetch;
  return new ObscuraHttpClient(1234, fetchImpl);
}

describe("parseTabId", () => {
  test("JSON object / array / text forms", () => {
    expect(parseTabId('{"id":"tab-7"}')).toBe("tab-7");
    expect(parseTabId('[{"id":"tab-9"}]')).toBe("tab-9");
    expect(parseTabId("Created tab id: abc123")).toBe("abc123");
  });
  test("nothing usable => null", () => {
    expect(parseTabId("")).toBeNull();
    expect(parseTabId("ok")).toBeNull();
  });
});

describe("parseTabList", () => {
  test("JSON array", () => {
    const t = parseTabList('[{"id":"a","url":"https://x.test/"},{"id":"b"}]');
    expect(t.map((x) => x.id)).toEqual(["a", "b"]);
    expect(t[0].url).toBe("https://x.test/");
  });
  test("human line form", () => {
    const t = parseTabList("tab1  https://a.test/page\ntab2  https://b.test/");
    expect(t.map((x) => x.id)).toEqual(["tab1", "tab2"]);
  });
  test("empty => []", () => {
    expect(parseTabList("")).toEqual([]);
  });
});

describe("ObscuraBrowseSessionClient satisfies BrowseSessionClient", () => {
  test("it structurally IS the interface the server depends on", async () => {
    const c: BrowseSessionClient = new ObscuraBrowseSessionClient({ client: fakeClient({}), port: 5555 });
    expect(typeof c.start).toBe("function");
    expect(typeof c.newTab).toBe("function");
    expect(typeof c.harStart).toBe("function");
    expect(typeof c.closeTab).toBe("function");
    expect(typeof c.discoverTabs).toBe("function");
    expect(typeof c.getCurrentUrl).toBe("function");
    expect(c.getPort?.()).toBe(5555);
  });

  test("newTab uses obscura's tab id when the build has tabs", async () => {
    const c = new ObscuraBrowseSessionClient({ client: fakeClient({ browser_tab_new: '{"id":"tab-42"}' }) });
    expect(await c.newTab()).toBe("tab-42");
  });

  test("newTab falls back to the single-page sentinel when tabs are unsupported", async () => {
    const c = new ObscuraBrowseSessionClient({ client: fakeClient({}) });
    expect(await c.newTab()).toBe(OBSCURA_SINGLE_TAB);
  });

  test("harStart is a no-op that RESOLVES — the broker already records", async () => {
    const seen: string[] = [];
    const c = new ObscuraBrowseSessionClient({ client: fakeClient({}, seen) });
    await c.harStart("any");           // must not throw
    expect(seen).toEqual([]);          // and must not call a tool to do nothing
  });

  test("getCurrentUrl reads the live page; obscura-null becomes empty string", async () => {
    const ok = new ObscuraBrowseSessionClient({ client: fakeClient({ browser_evaluate: "https://x.test/p" }) });
    expect(await ok.getCurrentUrl("t")).toBe("https://x.test/p");
    const nul = new ObscuraBrowseSessionClient({ client: fakeClient({ browser_evaluate: "null" }) });
    expect(await nul.getCurrentUrl("t")).toBe("");
  });

  test("discoverTabs degrades to the single page rather than reporting none", async () => {
    const c = new ObscuraBrowseSessionClient({ client: fakeClient({ browser_evaluate: "https://x.test/" }) });
    const tabs = await c.discoverTabs();
    expect(tabs).toEqual([{ id: OBSCURA_SINGLE_TAB, url: "https://x.test/" }]);
  });

  test("start() is a no-op when a client was injected (no broker spawned)", async () => {
    const c = new ObscuraBrowseSessionClient({ client: fakeClient({}) });
    await c.start(); // must not attempt to spawn obscura
    expect(await c.newTab()).toBe(OBSCURA_SINGLE_TAB);
  });
});

/**
 * The registry needs six methods, but the /v1/browse/* handlers reach for ~14
 * more on the same object. Swapping in a client that lacks them would not fail
 * at the seam — it would crash on the first .click(). This pins the whole set
 * the handlers actually call.
 */
describe("covers the wider surface routes.ts calls on a session broker", () => {
  const METHODS = [
    "evaluate", "getPageHtml", "click", "fill", "select", "press",
    "keyboardType", "scroll", "goBack", "goForward", "getCookies",
    "harStop", "bestEffortRehydratePlugins", "screenshot",
  ] as const;

  test("every method the handlers call exists", () => {
    const c = new ObscuraBrowseSessionClient({ client: fakeClient({}) }) as unknown as Record<string, unknown>;
    for (const m of METHODS) expect(typeof c[m]).toBe("function");
  });

  test("the actuators map to the right obscura tools", async () => {
    const seen: string[] = [];
    const c = new ObscuraBrowseSessionClient({
      client: fakeClient({
        browser_click: "ok", browser_fill: "ok", browser_select_option: "ok",
        browser_press_key: "ok", browser_scroll: "ok", browser_back: "ok",
        browser_forward: "ok", browser_evaluate: "https://x.test/",
      }, seen),
    });
    await c.click("t", "#a");
    await c.fill("t", "#b", "v");
    await c.select("t", "#c", "US");
    await c.press("t", "Enter");
    await c.scroll("t", "down", 300);
    await c.goBack("t");
    await c.goForward("t");
    expect(seen).toEqual([
      "browser_click", "browser_fill", "browser_select_option",
      "browser_press_key", "browser_scroll", "browser_back", "browser_forward",
    ]);
  });

  test("scroll direction becomes a signed delta", async () => {
    const args: Array<Record<string, unknown>> = [];
    const fetchImpl = (async (_u: string, init: { body: string }) => {
      const req = JSON.parse(init.body);
      if (req.method === "tools/call") args.push(req.params.arguments);
      return { text: async () => JSON.stringify({ result: { content: [{ text: "ok" }] } }) };
    }) as unknown as typeof fetch;
    const c = new ObscuraBrowseSessionClient({ client: new ObscuraHttpClient(1, fetchImpl) });
    await c.scroll("t", "up", 200);
    expect(args.at(-1)).toEqual({ dx: 0, dy: -200 });
  });

  test("getCookies parses the jar; malformed => [] rather than a throw", async () => {
    const ok = new ObscuraBrowseSessionClient({ client: fakeClient({ browser_get_cookies: '[{"name":"s","value":"v"}]' }) });
    expect((await ok.getCookies("t"))[0].name).toBe("s");
    const bad = new ObscuraBrowseSessionClient({ client: fakeClient({ browser_get_cookies: "not json" }) });
    expect(await bad.getCookies("t")).toEqual([]);
  });

  test("harStop returns an empty HAR — the broker never produced one", async () => {
    const c = new ObscuraBrowseSessionClient({ client: fakeClient({}) });
    expect(await c.harStop("t")).toEqual({ entries: [], raw: null });
  });

  /**
   * The load-bearing one. routes.ts receives this object through a cast, so
   * TypeScript cannot see a missing method — a handler reaching for one would
   * crash at runtime, not at the seam. This re-derives the set from routes.ts
   * itself, so adding a new broker call there turns this red instead of
   * shipping a crash.
   */
  test("covers EVERY broker/client method routes.ts calls (derived, not hardcoded)", () => {
    const routes = readFileSync(join(import.meta.dirname, "..", "src", "api", "routes.ts"), "utf8");
    const called = new Set(
      [...routes.matchAll(/\b(?:broker|client)\.([a-zA-Z_]+)\(/g)].map((m) => m[1]),
    );
    const c = new ObscuraBrowseSessionClient({ client: fakeClient({}) }) as unknown as Record<string, unknown>;
    const missing = [...called].filter((m) => typeof c[m] !== "function").sort();
    expect(missing, `routes.ts calls these on a session broker but ObscuraBrowseSessionClient lacks them: ${missing.join(", ")}`).toEqual([]);
    expect(called.size).toBeGreaterThan(10); // the derivation actually found the calls
  });

  test("the two impossible ones REFUSE loudly instead of returning blanks", async () => {
    const c = new ObscuraBrowseSessionClient({ client: fakeClient({}) });
    await expect(c.screenshot("t")).rejects.toThrow(/unsupported_on_obscura:screenshot/);
    await expect(c.keyboardType("t", "hi")).rejects.toThrow(/unsupported_on_obscura:keyboardType/);
  });
});
