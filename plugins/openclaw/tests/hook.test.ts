import { describe, expect, test } from "bun:test";
import { blockReason, readConfig, register } from "../src/plugin.ts";
import { asWebUrl, isLocalUrl, webUrlsIn } from "../src/urls.ts";
import { fakeApi } from "./helpers.ts";

const on = readConfig({});
const browser = (params: Record<string, unknown>) => ({ toolName: "browser", params });

describe("url helpers", () => {
  test("asWebUrl: absolute, bare host, host:port; not globs, refs, other schemes", () => {
    expect(asWebUrl("https://example.com/a")?.hostname).toBe("example.com");
    expect(asWebUrl("example.com")?.hostname).toBe("example.com");
    expect(asWebUrl("news.ycombinator.com/item?id=1")?.hostname).toBe("news.ycombinator.com");
    expect(asWebUrl("localhost:3000/x")?.hostname).toBe("localhost");
    expect(asWebUrl("127.0.0.1:8080")?.hostname).toBe("127.0.0.1");
    expect(asWebUrl("**/dashboard")).toBeUndefined();
    expect(asWebUrl("@e12")).toBeUndefined();
    expect(asWebUrl("about:blank")).toBeUndefined();
    expect(asWebUrl("file:///tmp/a.html")).toBeUndefined();
    expect(asWebUrl("data:text/html,hi")).toBeUndefined();
    expect(asWebUrl("")).toBeUndefined();
  });

  test("isLocalUrl", () => {
    for (const u of ["http://localhost", "http://app.localhost:5173", "http://127.0.0.1:8080", "http://127.1.2.3", "http://0.0.0.0:3000", "http://[::1]:4000"]) expect(isLocalUrl(new URL(u))).toBe(true);
    for (const u of ["https://example.com", "http://10.0.0.5", "http://localhost.evil.com", "http://127.0.0.1.nip.io"]) expect(isLocalUrl(new URL(u))).toBe(false);
  });

  test("webUrlsIn: url-like keys at any depth only", () => {
    const found = webUrlsIn({ action: "act", request: { kind: "batch", actions: [{ url: "https://a.com" }, { targetUrl: "b.org" }] }, text: "https://ignored.com" });
    expect(found.map((u) => u.hostname)).toEqual(["a.com", "b.org"]);
  });
});

describe("before_tool_call: browser", () => {
  test("blocks open/navigate to a remote URL, naming the Unbrowse tools", () => {
    for (const params of [{ action: "open", targetUrl: "https://example.com" }, { action: "navigate", url: "example.com" }, { action: "act", request: { kind: "wait", url: "https://example.com/done" } }]) {
      const reason = blockReason(browser(params), on);
      expect(reason).toBeDefined();
      expect(reason).toContain("unbrowse_scrape");
      expect(reason).toContain("unbrowse_browse_open");
      expect(reason).toContain("replaceBrowser");
    }
  });

  test("allows local pages and URL-less actions", () => {
    for (const params of [
      { action: "open", targetUrl: "http://localhost:3000" },
      { action: "navigate", url: "127.0.0.1:8080/app" },
      { action: "open", targetUrl: "about:blank" },
      { action: "open", targetUrl: "file:///tmp/report.html" },
      { action: "snapshot" },
      { action: "status" },
      { action: "act", request: { kind: "click", ref: "e12" } },
      { action: "act", kind: "wait", url: "**/dashboard" },
    ]) expect(blockReason(browser(params), on)).toBeUndefined();
  });

  test("replaceBrowser:false turns it off", () => {
    expect(blockReason(browser({ action: "open", targetUrl: "https://example.com" }), readConfig({ replaceBrowser: false }))).toBeUndefined();
  });

  test("other tools are never touched", () => {
    expect(blockReason({ toolName: "exec", params: { url: "https://example.com" } }, on)).toBeUndefined();
    expect(blockReason({ toolName: "unbrowse_scrape", params: { url: "https://example.com" } }, on)).toBeUndefined();
  });
});

describe("before_tool_call: web_fetch", () => {
  const wf = (url: string) => ({ toolName: "web_fetch", params: { url } });
  test("allowed by default (the Unbrowse provider backs it)", () => {
    expect(blockReason(wf("https://example.com"), on)).toBeUndefined();
  });
  test("blockWebFetch:true blocks remote, allows local", () => {
    const cfg = readConfig({ blockWebFetch: true });
    const reason = blockReason(wf("https://example.com"), cfg);
    expect(reason).toContain('unbrowse_scrape {url: "https://example.com/"}');
    expect(reason).toContain("blockWebFetch");
    expect(blockReason(wf("http://localhost:8080"), cfg)).toBeUndefined();
  });
});

describe("registered hook", () => {
  test("returns {block, blockReason} or undefined, and reads live plugin config", async () => {
    const f = fakeApi({});
    register(f.api, { env: {} });
    const hook = f.hooks.before_tool_call![0];
    const blocked = await hook(browser({ action: "open", targetUrl: "https://example.com" }), {});
    expect(blocked?.block).toBe(true);
    expect(blocked?.blockReason).toContain("unbrowse_browse_open");
    expect(await hook(browser({ action: "open", targetUrl: "http://localhost:1" }), {})).toBeUndefined();
    f.api.pluginConfig = { replaceBrowser: false };
    expect(await hook(browser({ action: "open", targetUrl: "https://example.com" }), {})).toBeUndefined();
  });
});
