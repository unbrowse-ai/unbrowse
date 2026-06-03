/**
 * standards-registry.test — the witness that unbrowse is the KV-cache layer in front of
 * every agent standard. Proves: the supported-standards list includes the real set
 * (MCP, MCP-registry, ACP, A2A, OpenAI/Anthropic tools, skills.sh); a query resolves
 * ACROSS standards into one normalized result; the merged result is content-addressed
 * and a warm call replays it without re-hitting any adapter; a failing standard never
 * breaks the others; and standards are pluggable (add one adapter → it contributes).
 */
import { describe, expect, it } from "bun:test";
import {
  AGENT_STANDARDS, resolveStandards, buildAdapters, type RegistryEntry, type AgentStandard,
} from "../src/values/standards-registry.js";
import type { AsyncBlobStore } from "../src/values/async-resolution.js";

function memBlob(): AsyncBlobStore {
  const m = new Map<string, string>();
  return { get: async (h) => m.get(h), put: async (h, t) => void m.set(h, t) };
}
const entry = (standard: AgentStandard, id: string, ref: string): RegistryEntry => ({ standard, id, ref });

describe("standards-registry — unbrowse fronts every agent standard", () => {
  it("supports the real agent-standard set, including ACP and MCP registries", () => {
    for (const s of ["mcp", "mcp-registry", "acp", "a2a", "openai-tools", "anthropic-tools", "skills.sh"]) {
      expect(AGENT_STANDARDS).toContain(s as AgentStandard);
    }
  });

  it("resolves a query ACROSS standards into one normalized result", async () => {
    const adapters = buildAdapters({
      mcp: async (q) => [entry("mcp", `mcp:${q}`, "stdio://server")],
      acp: async (q) => [entry("acp", `acp:${q}`, "jsonrpc://agent")],
      "skills.sh": async (q) => [entry("skills.sh", `skill:${q}`, "https://skills.sh/x")],
    });
    const r = await resolveStandards("read calendar", adapters);
    expect(r.standards).toEqual(["mcp", "acp", "skills.sh"]);
    expect(r.entries.map((e) => e.standard).sort()).toEqual(["acp", "mcp", "skills.sh"]);
    expect(r.entries.every((e) => e.id && e.ref)).toBe(true); // normalized shape
  });

  it("caches the merged result under one pointer; a warm call replays it (no re-hit)", async () => {
    let hits = 0;
    const adapters = buildAdapters({
      mcp: async (q) => { hits++; return [entry("mcp", q, "stdio://s")]; },
      acp: async (q) => { hits++; return [entry("acp", q, "jsonrpc://a")]; },
    });
    const cache = { store: memBlob(), pointers: new Map<string, string>() };
    const cold = await resolveStandards("buy milk", adapters, cache);
    expect(cold.cached).toBe(false);
    expect(hits).toBe(2); // both adapters hit once

    const warm = await resolveStandards("buy milk", adapters, cache);
    expect(warm.cached).toBe(true);
    expect(hits).toBe(2); // NO adapter re-hit — unbrowse served from its kv cache
    expect(warm.entries).toEqual(cold.entries);
  });

  it("a failing standard never breaks the others", async () => {
    const adapters = buildAdapters({
      mcp: async () => { throw new Error("registry down"); },
      acp: async (q) => [entry("acp", q, "jsonrpc://a")],
    });
    const r = await resolveStandards("q", adapters);
    expect(r.entries.map((e) => e.standard)).toEqual(["acp"]); // acp still resolved
  });

  it("standards are pluggable — adding an adapter contributes its entries; unknown ignored", async () => {
    const adapters = buildAdapters({
      a2a: async (q) => [entry("a2a", q, "https://agent.card/.well-known/agent.json")],
      "openai-tools": async (q) => [entry("openai-tools", q, "tool:search")],
      // @ts-expect-error — an unknown standard is filtered out, not registered
      "not-a-standard": async () => [entry("mcp", "x", "y")],
    });
    expect(adapters.map((a) => a.standard).sort()).toEqual(["a2a", "openai-tools"]);
    const r = await resolveStandards("q", adapters);
    expect(r.entries.length).toBe(2);
  });
});
