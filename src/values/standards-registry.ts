/**
 * standards-registry — unbrowse as the KV-cache layer in front of every agent standard.
 *
 * The thesis: every agent ecosystem ships its own discovery standard — MCP servers and
 * MCP registries, the Agent Client Protocol (ACP), Google's Agent2Agent (A2A), OpenAI /
 * Anthropic tool-use schemas, and skill registries like skills.sh. Rather than re-derive
 * each one per agent, unbrowse servers resolve and CACHE every standard's entries through
 * one content-addressed resolution layer. Each standard is a pluggable adapter; the cache
 * (resolution-ledger / R2 / IQ on-chain) is the shared layer beneath them all.
 *
 *   query ──▶ [ MCP | ACP | A2A | openai-tools | anthropic-tools | skills.sh | … ]
 *                         every adapter's result cached by content under one pointer
 *
 * Pure over injected adapters + an AsyncBlobStore, so the layer is testable without any
 * live registry. Adding a new standard = registering one more adapter.
 */
import type { AsyncBlobStore } from "./async-resolution.js";
import { putBlobAsync, resolvePointerAsync, contentPointer } from "./async-resolution.js";

/** The agent standards unbrowse fronts as cache layers. This list IS the answer to
 *  "what other agent standards must we support" — extend it to add a standard. */
export const AGENT_STANDARDS = [
  "mcp",              // Model Context Protocol — servers + registries
  "mcp-registry",     // the MCP server registry (discovery of MCP servers)
  "acp",              // Agent Client Protocol — editor↔agent, JSON-RPC over stdio/HTTP-WS
  "a2a",              // Agent2Agent — cross-agent interop
  "openai-tools",     // OpenAI function/tool-calling schemas
  "anthropic-tools",  // Anthropic tool-use schemas
  "skills.sh",        // skill registry
  "agentskills.dev",  // skill registry (agent skills)
  "pay.sh",           // agent payment rail
  "x402-bazaar",      // x402 marketplace of paid endpoints
] as const;
export type AgentStandard = (typeof AGENT_STANDARDS)[number];

/** One discovered entry from a standard's registry — normalized so an agent can use
 *  any standard through the same shape. */
export interface RegistryEntry {
  standard: AgentStandard;
  id: string;          // the standard-native id (server name, skill id, agent card url, tool name)
  title?: string;
  /** how to reach it (endpoint / command / url) — standard-specific, opaque to the cache. */
  ref: string;
  meta?: Record<string, unknown>;
}

/** A pluggable adapter for one standard: resolve a query to its registry entries. */
export interface StandardAdapter {
  standard: AgentStandard;
  resolve(query: string): Promise<RegistryEntry[]>;
}

export interface StandardsResolution {
  entries: RegistryEntry[];
  /** standards that contributed entries, in order walked. */
  standards: AgentStandard[];
  cached: boolean;
}

const KEY = (q: string, standards: AgentStandard[]) =>
  contentPointer(`standards ${[...standards].sort().join(",")} :: ${q}`);

/**
 * Resolve a query across every registered standard and CACHE the merged result under one
 * content-addressed pointer. A warm call replays the pointer (no adapter re-hit) — the
 * "all other standards are a layer of the kv cache handled by unbrowse" property.
 * `store`/`ledger` optional: without them it always resolves live (no cache tier).
 */
export async function resolveStandards(
  query: string,
  adapters: readonly StandardAdapter[],
  cache?: { store: AsyncBlobStore; pointers: Map<string, string> },
): Promise<StandardsResolution> {
  const standards = adapters.map((a) => a.standard);
  const key = KEY(query, standards);

  if (cache) {
    const ptr = cache.pointers.get(key);
    if (ptr) {
      const blob = await resolvePointerAsync(ptr, cache.store);
      if (blob !== null) return { entries: JSON.parse(blob) as RegistryEntry[], standards, cached: true };
    }
  }

  const entries: RegistryEntry[] = [];
  for (const a of adapters) {
    try {
      for (const e of await a.resolve(query)) entries.push({ ...e, standard: a.standard });
    } catch {
      /* a failing standard never breaks the others — skip it */
    }
  }

  if (cache) {
    const ptr = await putBlobAsync(JSON.stringify(entries), cache.store);
    cache.pointers.set(key, ptr);
  }
  return { entries, standards, cached: false };
}

/** Build the canonical adapter set from per-standard resolver functions, skipping any
 *  the deployment hasn't wired. Lets unbrowse front whichever standards are configured. */
export function buildAdapters(
  resolvers: Partial<Record<AgentStandard, (q: string) => Promise<RegistryEntry[]>>>,
): StandardAdapter[] {
  return (Object.keys(resolvers) as AgentStandard[])
    .filter((s) => AGENT_STANDARDS.includes(s) && typeof resolvers[s] === "function")
    .map((standard) => ({ standard, resolve: resolvers[standard]! }));
}
