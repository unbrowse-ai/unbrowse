/**
 * live-registry-adapters.test — the witness that the standards layers are wired to the
 * REAL registry endpoints (discovered), with the fetch injected so the mapping is proven
 * without network. Proves: the MCP registry endpoint is the official one; the adapter
 * maps a real-shaped registry payload to normalized RegistryEntry[]; a standard with no
 * list API resolves to [] (honest, not faked); the live resolvers plug into the
 * standards-registry and cache.
 */
import { describe, expect, it } from "bun:test";
import { liveAdapter, liveResolvers, REGISTRY_ENDPOINTS, type FetchJson } from "../src/values/live-registry-adapters.js";
import { buildAdapters, resolveStandards } from "../src/values/standards-registry.js";
import type { AsyncBlobStore } from "../src/values/async-resolution.js";

function memBlob(): AsyncBlobStore {
  const m = new Map<string, string>();
  return { get: async (h) => m.get(h), put: async (h, t) => void m.set(h, t) };
}

describe("live-registry-adapters — wired to the real endpoints", () => {
  it("the MCP registry endpoint is the official registry.modelcontextprotocol.io list API", () => {
    const url = REGISTRY_ENDPOINTS.mcp!.list!("filesystem");
    expect(url).toContain("https://registry.modelcontextprotocol.io/v0/servers");
    expect(url).toContain("search=filesystem");
  });

  it("the MCP adapter maps the REAL nested {servers:[{server:{…}}]} payload to entries", async () => {
    let calledUrl = "";
    // This is the registry's actual shape (verified live): each item wraps `.server`,
    // and `repository` is a {url, source} object — not a flat string.
    const fetchJson: FetchJson = async (url) => {
      calledUrl = url;
      return { servers: [
        { server: { name: "com.pulsemcp/remote-filesystem", description: "FS server",
                    repository: { url: "https://github.com/pulsemcp/mcp-servers", source: "github" } } },
        { server: { name: "io.github.acme/sqlite", url: "stdio://sqlite" } },
      ] };
    };
    const entries = await liveAdapter("mcp", fetchJson).resolve("filesystem");
    expect(calledUrl).toContain("registry.modelcontextprotocol.io/v0/servers");
    expect(entries.length).toBe(2);
    expect(entries[0].standard).toBe("mcp");
    expect(entries[0].id).toBe("com.pulsemcp/remote-filesystem"); // unwrapped from .server
    expect(entries[0].ref).toBe("https://github.com/pulsemcp/mcp-servers"); // repository.url
    expect(entries[1].ref).toBe("stdio://sqlite");
  });

  it("standards with no VERIFIED list endpoint resolve to [] (honest, not fabricated)", async () => {
    // pay.sh is a rail; agentskills.dev was unreachable at probe; x402-bazaar has no
    // confirmed JSON list. None has a `list`, so all resolve [] rather than guess a URL.
    for (const s of ["pay.sh", "agentskills.dev", "x402-bazaar"] as const) {
      expect(await liveAdapter(s, async () => ({ anything: 1 })).resolve("q")).toEqual([]);
    }
  });

  it("the VERIFIED endpoints carry their real URLs (a2aregistry, skills.sh)", () => {
    expect(REGISTRY_ENDPOINTS.a2a!.list!("x")).toContain("a2aregistry.org/api/agents");
    expect(REGISTRY_ENDPOINTS["skills.sh"]!.list!("x")).toContain("skills.sh/api/search");
  });

  it("live resolvers plug into the standards-registry and cache the merged result", async () => {
    let calls = 0;
    const fetchJson: FetchJson = async () => { calls++; return { results: [{ name: "x", url: "https://x" }] }; };
    const adapters = buildAdapters(liveResolvers(fetchJson));
    // only the VERIFIED-live endpoints become live adapters (mcp + a2a + skills.sh);
    // unverified ones (agentskills.dev, x402-bazaar) have no list endpoint by design
    expect(adapters.map((a) => a.standard).sort()).toEqual(
      ["a2a", "mcp", "mcp-registry", "skills.sh"],
    );
    const cache = { store: memBlob(), pointers: new Map<string, string>() };
    const cold = await resolveStandards("read calendar", adapters, cache);
    expect(cold.entries.length).toBe(adapters.length); // one entry per live standard
    const callsAfterCold = calls;
    const warm = await resolveStandards("read calendar", adapters, cache);
    expect(warm.cached).toBe(true);
    expect(calls).toBe(callsAfterCold); // warm replay — no registry re-fetch
  });

  it("a failing live registry never breaks the others (failure isolation holds)", async () => {
    const fetchJson: FetchJson = async (url) => {
      if (url.includes("modelcontextprotocol")) throw new Error("registry down");
      return { results: [{ name: "ok", url: "https://ok" }] };
    };
    const adapters = buildAdapters(liveResolvers(fetchJson));
    const r = await resolveStandards("q", adapters);
    expect(r.entries.length).toBeGreaterThan(0); // the others still resolved
    expect(r.entries.some((e) => e.standard === "mcp")).toBe(false); // mcp errored out
  });
});
