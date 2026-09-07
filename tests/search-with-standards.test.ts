/**
 * search-with-standards.test — the witness for the unified find-anything surface: one
 * intent resolves BOTH the route graph and the agent-standard registries, merged,
 * cached, and failure-isolated. Hermetic: injected searchFn + stub standard adapters.
 */
import { describe, expect, it } from "bun:test";
import { searchWithStandards, type RouteHit } from "../src/values/search-with-standards.js";
import { buildAdapters, type RegistryEntry, type AgentStandard } from "../src/values/standards-registry.js";
import type { AsyncBlobStore } from "../src/values/async-resolution.js";

function memBlob(): AsyncBlobStore {
  const m = new Map<string, string>();
  return { get: async (h) => m.get(h), put: async (h, t) => void m.set(h, t) };
}
const e = (s: AgentStandard, id: string, ref: string): RegistryEntry => ({ standard: s, id, ref });
const route: RouteHit = { skill_id: "github", endpoint_id: "list_repos", url: "https://api.github.com", score: 0.9 };

describe("search-with-standards — one intent, route graph + standards merged", () => {
  it("merges route-graph hits AND standards-registry entries into one result", async () => {
    const r = await searchWithStandards("list a user's repos", {
      searchFn: async () => [route],
      standardsAdapters: buildAdapters({
        mcp: async (q) => [e("mcp", `mcp:${q}`, "stdio://github-mcp")],
        "skills.sh": async (q) => [e("skills.sh", `skill:${q}`, "https://skills.sh/gh")],
      }),
    });
    expect(r.routes).toEqual([route]);                       // the replayable route
    expect(r.standards.map((x) => x.standard).sort()).toEqual(["mcp", "skills.sh"]);
    expect(r.standardsResolved).toEqual(["mcp", "skills.sh"]);
  });

  it("a route-graph FAILURE never sinks the standards half", async () => {
    const r = await searchWithStandards("q", {
      searchFn: async () => { throw new Error("route graph down"); },
      standardsAdapters: buildAdapters({ a2a: async (q) => [e("a2a", q, "https://agent.card")] }),
    });
    expect(r.routes).toEqual([]);            // failed half → []
    expect(r.standards.length).toBe(1);      // other half still returned
  });

  it("a standards FAILURE never sinks the route half", async () => {
    const r = await searchWithStandards("q", {
      searchFn: async () => [route],
      standardsAdapters: buildAdapters({ mcp: async () => { throw new Error("registry down"); } }),
    });
    expect(r.routes).toEqual([route]);       // route half intact
    expect(r.standards).toEqual([]);         // failing registry isolated to []
  });

  it("the standards half is cached — a repeat intent does not re-hit the adapters", async () => {
    let hits = 0;
    const adapters = buildAdapters({ mcp: async (q) => { hits++; return [e("mcp", q, "stdio://s")]; } });
    const cache = { store: memBlob(), pointers: new Map<string, string>() };
    await searchWithStandards("same", { searchFn: async () => [route], standardsAdapters: adapters, cache });
    expect(hits).toBe(1);
    const warm = await searchWithStandards("same", { searchFn: async () => [route], standardsAdapters: adapters, cache });
    expect(hits).toBe(1);                    // standards served from the kv cache
    expect(warm.standards.length).toBe(1);
  });
});
