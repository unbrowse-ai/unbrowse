import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from "bun:test";
import * as kuri from "../src/kuri/client.js";

/**
 * Tests for the new Kuri action/keyboard/wait/session/DOM wrappers.
 *
 * These are unit tests that mock the underlying HTTP calls (kuriGet/kuriPost)
 * to verify the client wrappers build the correct request parameters.
 * Integration tests that require a running Kuri server are in kuri-integration.test.ts.
 */

let fetchCalls: Array<{ url: string; options?: RequestInit }> = [];
let fetchResponse: unknown = {};
let savedFetch: typeof globalThis.fetch | undefined;

beforeEach(() => {
  fetchCalls = [];
  fetchResponse = {};
  savedFetch = globalThis.fetch;

  // @ts-expect-error — replacing global fetch for testing
  globalThis.fetch = mock(async (url: string | URL | Request, options?: RequestInit) => {
    const urlStr = typeof url === "string" ? url : url instanceof URL ? url.toString() : url.url;
    fetchCalls.push({ url: urlStr, options });
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify(fetchResponse),
      json: async () => fetchResponse,
    };
  });
});

afterEach(async () => {
  if (savedFetch) globalThis.fetch = savedFetch;
  await kuri.stop();
});

// Helper: extract path + params from the captured fetch URL
function parseFetchUrl(idx = 0): { path: string; params: Record<string, string> } {
  const raw = fetchCalls[idx]?.url ?? "";
  const u = new URL(raw, "http://127.0.0.1:7700");
  const params: Record<string, string> = {};
  u.searchParams.forEach((v, k) => { params[k] = v; });
  return { path: u.pathname, params };
}

describe("kuri action wrappers", () => {
  it("click sends action=click with ref", async () => {
    await kuri.click("tab1", "e5");
    const { path, params } = parseFetchUrl();
    expect(path).toBe("/action");
    expect(params.tab_id).toBe("tab1");
    expect(params.action).toBe("click");
    expect(params.ref).toBe("e5");
  });

  it("fill sends action=fill with ref and value", async () => {
    await kuri.fill("tab1", "e3", "hello world");
    const { path, params } = parseFetchUrl();
    expect(path).toBe("/action");
    expect(params.action).toBe("fill");
    expect(params.ref).toBe("e3");
    expect(params.value).toBe("hello world");
  });

  it("select sends action=select with ref and value", async () => {
    await kuri.select("tab1", "e7", "option2");
    const { path, params } = parseFetchUrl();
    expect(path).toBe("/action");
    expect(params.action).toBe("select");
    expect(params.ref).toBe("e7");
    expect(params.value).toBe("option2");
  });

  it("scroll sends action=scroll with placeholder ref", async () => {
    await kuri.scroll("tab1");
    const { path, params } = parseFetchUrl();
    expect(path).toBe("/action");
    expect(params.action).toBe("scroll");
    expect(params.ref).toBe("_");
  });

  it("press sends action=press with key value", async () => {
    await kuri.press("tab1", "Enter");
    const { path, params } = parseFetchUrl();
    expect(path).toBe("/action");
    expect(params.action).toBe("press");
    expect(params.value).toBe("Enter");
  });

  it("generic action passes through all params", async () => {
    await kuri.action("tab1", "dblclick", "e9");
    const { path, params } = parseFetchUrl();
    expect(path).toBe("/action");
    expect(params.action).toBe("dblclick");
    expect(params.ref).toBe("e9");
    expect(params.value).toBeUndefined();
  });
});

describe("kuri wait wrappers", () => {
  it("waitForSelector sends selector and timeout", async () => {
    fetchResponse = { status: "found", selector: "#login", polls: 3 };
    const result = await kuri.waitForSelector("tab1", "#login", 10000);
    const { path, params } = parseFetchUrl();
    expect(path).toBe("/wait");
    expect(params.tab_id).toBe("tab1");
    expect(params.selector).toBe("#login");
    expect(params.timeout).toBe("10000");
    expect(result.status).toBe("found");
  });

  it("waitForLoad sends no selector", async () => {
    fetchResponse = { status: "ready", readyState: "complete", polls: 1 };
    const result = await kuri.waitForLoad("tab1");
    const { path, params } = parseFetchUrl();
    expect(path).toBe("/wait");
    expect(params.selector).toBeUndefined();
    expect(result.status).toBe("ready");
  });
});

describe("kuri keyboard wrappers", () => {
  it("keyboardType sends text parameter", async () => {
    await kuri.keyboardType("tab1", "hello");
    const { path, params } = parseFetchUrl();
    expect(path).toBe("/keyboard/type");
    expect(params.text).toBe("hello");
  });

  it("keyboardInsertText sends to inserttext endpoint", async () => {
    await kuri.keyboardInsertText("tab1", "fast text");
    const { path, params } = parseFetchUrl();
    expect(path).toBe("/keyboard/inserttext");
    expect(params.text).toBe("fast text");
  });

  it("keyDown sends key parameter", async () => {
    await kuri.keyDown("tab1", "Escape");
    const { path, params } = parseFetchUrl();
    expect(path).toBe("/keydown");
    expect(params.key).toBe("Escape");
  });

  it("keyUp sends key parameter", async () => {
    await kuri.keyUp("tab1", "Escape");
    const { path, params } = parseFetchUrl();
    expect(path).toBe("/keyup");
    expect(params.key).toBe("Escape");
  });
});

describe("kuri DOM wrappers", () => {
  it("domQuery sends selector", async () => {
    fetchResponse = { nodeId: 42 };
    const result = await kuri.domQuery("tab1", "input.search");
    const { path, params } = parseFetchUrl();
    expect(path).toBe("/dom/query");
    expect(params.selector).toBe("input.search");
    expect(params.all).toBeUndefined();
    expect(result.nodeId).toBe(42);
  });

  it("domQuery with all=true sends all param", async () => {
    fetchResponse = { nodeIds: [1, 2, 3] };
    const result = await kuri.domQuery("tab1", "li.item", true);
    const { path, params } = parseFetchUrl();
    expect(path).toBe("/dom/query");
    expect(params.all).toBe("true");
    expect(result.nodeIds).toEqual([1, 2, 3]);
  });

  it("domHtml sends node_id", async () => {
    await kuri.domHtml("tab1", 42);
    const { path, params } = parseFetchUrl();
    expect(path).toBe("/dom/html");
    expect(params.node_id).toBe("42");
  });

  it("domAttributes with ref", async () => {
    await kuri.domAttributes("tab1", { ref: "e5" });
    const { path, params } = parseFetchUrl();
    expect(path).toBe("/dom/attributes");
    expect(params.ref).toBe("e5");
  });

  it("domAttributes with selector", async () => {
    await kuri.domAttributes("tab1", { selector: "#main" });
    const { path, params } = parseFetchUrl();
    expect(path).toBe("/dom/attributes");
    expect(params.selector).toBe("#main");
  });
});

describe("kuri scroll/drag wrappers", () => {
  it("scrollIntoView sends ref", async () => {
    await kuri.scrollIntoView("tab1", "e12");
    const { path, params } = parseFetchUrl();
    expect(path).toBe("/scrollintoview");
    expect(params.ref).toBe("e12");
  });

  it("drag sends source and target", async () => {
    await kuri.drag("tab1", "e1", "e2");
    const { path, params } = parseFetchUrl();
    expect(path).toBe("/drag");
    expect(params.source).toBe("e1");
    expect(params.target).toBe("e2");
  });
});

describe("kuri auth/viewport wrappers", () => {
  it("setCredentials sends username and password", async () => {
    await kuri.setCredentials("tab1", "admin", "secret");
    const { path, params } = parseFetchUrl();
    expect(path).toBe("/set/credentials");
    expect(params.username).toBe("admin");
    expect(params.password).toBe("secret");
  });

  it("setViewport sends width and height", async () => {
    await kuri.setViewport("tab1", 1280, 720);
    const { path, params } = parseFetchUrl();
    expect(path).toBe("/set/viewport");
    expect(params.width).toBe("1280");
    expect(params.height).toBe("720");
  });

  it("setUserAgent sends ua string", async () => {
    await kuri.setUserAgent("tab1", "CustomBot/1.0");
    const { path, params } = parseFetchUrl();
    expect(path).toBe("/set/useragent");
    expect(params.ua).toBe("CustomBot/1.0");
  });
});

describe("kuri session wrappers", () => {
  it("sessionSave calls /session/save", async () => {
    fetchResponse = { tabs: 2, cookies: 5 };
    const result = await kuri.sessionSave();
    const { path } = parseFetchUrl();
    expect(path).toBe("/session/save");
    expect(result).toEqual({ tabs: 2, cookies: 5 });
  });

  it("sessionLoad posts state to /session/load", async () => {
    fetchResponse = { imported: 3 };
    const result = await kuri.sessionLoad({ tabs: ["t1", "t2"] });
    const { path } = parseFetchUrl();
    expect(path).toBe("/session/load");
    expect(result.imported).toBe(3);
    // Verify it was a POST with body
    const opts = fetchCalls[0]?.options;
    expect(opts?.method).toBe("POST");
  });

  it("sessionList calls /session/list", async () => {
    await kuri.sessionList();
    const { path } = parseFetchUrl();
    expect(path).toBe("/session/list");
  });
});

describe("kuri navigation wrappers", () => {
  it("goBack calls /back", async () => {
    await kuri.goBack("tab1");
    const { path, params } = parseFetchUrl();
    expect(path).toBe("/back");
    expect(params.tab_id).toBe("tab1");
  });

  it("goForward calls /forward", async () => {
    await kuri.goForward("tab1");
    const { path, params } = parseFetchUrl();
    expect(path).toBe("/forward");
    expect(params.tab_id).toBe("tab1");
  });

  it("reload calls /reload", async () => {
    await kuri.reload("tab1");
    const { path, params } = parseFetchUrl();
    expect(path).toBe("/reload");
    expect(params.tab_id).toBe("tab1");
  });
});

describe("kuri observability wrappers", () => {
  it("getNetworkEvents calls /network", async () => {
    await kuri.getNetworkEvents("tab1");
    const { path } = parseFetchUrl();
    expect(path).toBe("/network");
  });

  it("getPerfLcp calls /perf/lcp", async () => {
    await kuri.getPerfLcp("tab1");
    const { path } = parseFetchUrl();
    expect(path).toBe("/perf/lcp");
  });

  it("findText calls /find with query", async () => {
    await kuri.findText("tab1", "search term");
    const { path, params } = parseFetchUrl();
    expect(path).toBe("/find");
    expect(params.query).toBe("search term");
  });

  it("getLinks calls /links", async () => {
    await kuri.getLinks("tab1");
    const { path } = parseFetchUrl();
    expect(path).toBe("/links");
  });

  it("getConsole calls /console", async () => {
    await kuri.getConsole("tab1");
    const { path } = parseFetchUrl();
    expect(path).toBe("/console");
  });

  it("getErrors calls /errors", async () => {
    await kuri.getErrors("tab1");
    const { path } = parseFetchUrl();
    expect(path).toBe("/errors");
  });
});

describe("kuri script injection", () => {
  it("scriptInject posts source to /script/inject", async () => {
    await kuri.scriptInject("tab1", "console.log('injected')");
    const { path } = parseFetchUrl();
    expect(path).toBe("/script/inject");
    const opts = fetchCalls[0]?.options;
    expect(opts?.method).toBe("POST");
    const body = JSON.parse(opts?.body as string);
    expect(body.source).toBe("console.log('injected')");
  });
});
