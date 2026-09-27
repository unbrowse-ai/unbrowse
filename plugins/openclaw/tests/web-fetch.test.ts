import { describe, expect, test } from "bun:test";
import type { HostConfig } from "../src/host-types.ts";
import { createWebFetchProvider, readConfig, toWebFetchPayload } from "../src/plugin.ts";
import { fakeMcp, rpcResult } from "./helpers.ts";

const KEY = "ub_live_test_key";
const scrape = { url: "https://example.com", finalUrl: "https://example.com/", via: "rendered", metadata: { title: "Example Domain", sourceURL: "https://example.com/", statusCode: 200 }, markdown: "# Example Domain\n\nbody", text: "Example Domain body" };

describe("toWebFetchPayload", () => {
  test("markdown mode from structuredContent", () => {
    const p = toWebFetchPayload("https://example.com", "markdown", { content: [], structuredContent: scrape });
    expect(p).toEqual({ url: "https://example.com", finalUrl: "https://example.com/", text: scrape.markdown, title: "Example Domain", status: 200, contentType: "text/markdown", extractor: "unbrowse (rendered)", rawLength: scrape.markdown.length });
  });

  test("text mode prefers text; JSON text content when no structuredContent", () => {
    const p = toWebFetchPayload("https://example.com", "text", { content: [{ type: "text", text: JSON.stringify(scrape) }] });
    expect(p.text).toBe("Example Domain body");
    expect(p.contentType).toBe("text/plain");
    expect(p.title).toBe("Example Domain");
  });

  test("plain-text content becomes the body; missing metadata falls back to the requested URL", () => {
    const p = toWebFetchPayload("https://x.test/a", "markdown", { content: [{ type: "text", text: "just text" }] });
    expect(p).toEqual({ url: "https://x.test/a", finalUrl: "https://x.test/a", text: "just text", contentType: "text/markdown", extractor: "unbrowse", rawLength: 9 });
  });

  test("never emits reserved outcome keys other than web_fetch's own status", () => {
    const p = toWebFetchPayload("https://example.com", "markdown", { content: [], structuredContent: scrape });
    for (const k of ["ok", "success", "error", "timedOut", "exitCode"]) expect(p).not.toHaveProperty(k);
  });
});

describe("web fetch provider", () => {
  const cfgWith = (config: Record<string, unknown>): HostConfig => ({ plugins: { entries: { unbrowse: { enabled: true, config } } } });

  test("createTool().execute calls unbrowse.scrape with the requested format", async () => {
    const mcp = fakeMcp(() => rpcResult({ content: [{ type: "text", text: "{}" }], structuredContent: scrape }));
    const provider = createWebFetchProvider(() => readConfig({ apiKey: KEY }), { fetch: mcp.fetch, env: {} });
    const t = provider.createTool({})!;
    expect(t.parameters.required).toEqual(["url"]);
    const out = await t.execute({ url: "https://example.com", extractMode: "text", maxChars: 500 });
    expect(mcp.calls[0].body.params).toEqual({ name: "unbrowse.scrape", arguments: { url: "https://example.com", formats: ["text"] } });
    expect(out.text).toBe(scrape.text);
    await t.execute({ url: "https://example.com" });
    expect(mcp.calls[1].body.params?.arguments).toEqual({ url: "https://example.com", formats: ["markdown"] });
  });

  test("reads the key from the host config passed to createTool when api.pluginConfig has none", async () => {
    const mcp = fakeMcp(() => rpcResult({ content: [], structuredContent: scrape }));
    const provider = createWebFetchProvider(() => readConfig(undefined), { fetch: mcp.fetch, env: {} });
    await provider.createTool({ config: cfgWith({ apiKey: "ub_from_cfg", mcpUrl: "https://cfg.test/mcp" }) })!.execute({ url: "https://example.com" });
    expect(mcp.calls[0].headers.authorization).toBe("Bearer ub_from_cfg");
    expect(mcp.calls[0].url).toBe("https://cfg.test/mcp");
  });

  test("passes the abort signal through", async () => {
    const mcp = fakeMcp(() => rpcResult({ content: [], structuredContent: scrape }));
    const provider = createWebFetchProvider(() => readConfig({ apiKey: KEY }), { fetch: mcp.fetch, env: {} });
    const ac = new AbortController();
    await provider.createTool({})!.execute({ url: "https://example.com" }, { signal: ac.signal });
    expect(mcp.calls[0].signal).toBe(ac.signal);
  });

  test("errors propagate as thrown errors (web_fetch reports them)", async () => {
    const mcp = fakeMcp(() => new Response(JSON.stringify({ error: "invalid_token" }), { status: 401 }));
    const provider = createWebFetchProvider(() => readConfig({ apiKey: "bad" }), { fetch: mcp.fetch, env: {} });
    await expect(provider.createTool({})!.execute({ url: "https://example.com" })).rejects.toThrow(/^Unbrowse invalid_token/);
  });

  test("credential plumbing and metadata", () => {
    const p = createWebFetchProvider(() => readConfig({}));
    expect(p.id).toBe("unbrowse");
    expect(p.envVars).toEqual(["UNBROWSE_API_KEY"]);
    expect(p.credentialPath).toBe("plugins.entries.unbrowse.config.apiKey");
    const target: Record<string, unknown> = {};
    p.setCredentialValue(target, "k1");
    expect(p.getCredentialValue(target)).toBe("k1");
    expect(p.getCredentialValue(undefined)).toBeUndefined();
    const cfg: HostConfig = {};
    p.setConfiguredCredentialValue!(cfg, "k2");
    expect(p.getConfiguredCredentialValue!(cfg)).toBe("k2");
    expect(cfg.plugins?.entries?.unbrowse?.config).toEqual({ apiKey: "k2" });
  });

  test("applySelectionConfig enables the plugin, honours allow/deny/disabled", () => {
    const p = createWebFetchProvider(() => readConfig({}));
    expect(p.applySelectionConfig!({}).plugins?.entries?.unbrowse?.enabled).toBe(true);
    expect(p.applySelectionConfig!({ plugins: { allow: ["x"] } }).plugins?.allow).toEqual(["x", "unbrowse"]);
    const denied: HostConfig = { plugins: { deny: ["unbrowse"] } };
    expect(p.applySelectionConfig!(denied)).toBe(denied);
    const off: HostConfig = { plugins: { enabled: false } };
    expect(p.applySelectionConfig!(off)).toBe(off);
    const kept = p.applySelectionConfig!(cfgWith({ apiKey: "k" }));
    expect(kept.plugins?.entries?.unbrowse).toEqual({ enabled: true, config: { apiKey: "k" } });
  });
});
