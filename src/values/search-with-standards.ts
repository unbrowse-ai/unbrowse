/**
 * search-with-standards — the unified "find anything for an agent" surface.
 *
 * unbrowse search already finds the reusable route/skill for an intent (the route
 * graph + web). This composes that with the standards-registry (standards-registry.ts +
 * live-registry-adapters.ts): the same intent also resolves real MCP servers, A2A
 * agents, and skills from their registries — every result cached through the resolution
 * layer. One call, one merged answer: "here is the route to replay, AND the standard
 * servers/agents/skills that can do this", so the agent picks the cheapest path.
 *
 * Both halves are injected (the route searchFn, the standards adapters), so the merge,
 * caching, and failure-isolation are provable without network. Either half failing never
 * sinks the other — a down registry or a route-graph miss still returns what it can.
 */
import type { StandardAdapter, RegistryEntry } from "./standards-registry.js";
import { resolveStandards } from "./standards-registry.js";
import type { AsyncBlobStore } from "./async-resolution.js";

/** A route-graph / web search hit (whatever the existing search returns, normalized to
 *  the minimum the merge needs). */
export interface RouteHit {
  skill_id?: string;
  endpoint_id?: string;
  url?: string;
  score?: number;
  [k: string]: unknown;
}

export interface UnifiedResult {
  intent: string;
  /** reusable routes from the route graph + web search (the cheap, replayable path). */
  routes: RouteHit[];
  /** real entries from the agent-standard registries (MCP servers, A2A agents, skills). */
  standards: RegistryEntry[];
  /** which standards contributed. */
  standardsResolved: string[];
}

/**
 * Resolve an intent across BOTH the route graph and the standards registries, in
 * parallel, and merge. A failing half never sinks the other. The standards half is
 * cached by the resolution layer (warm replay, no re-fetch).
 */
export async function searchWithStandards(
  intent: string,
  opts: {
    searchFn: (intent: string) => Promise<RouteHit[]>;
    standardsAdapters: readonly StandardAdapter[];
    cache?: { store: AsyncBlobStore; pointers: Map<string, string> };
  },
): Promise<UnifiedResult> {
  const [routes, standards] = await Promise.all([
    opts.searchFn(intent).catch(() => [] as RouteHit[]),               // route-graph miss/err → []
    resolveStandards(intent, opts.standardsAdapters, opts.cache).catch( // a registry down → empty
      () => ({ entries: [] as RegistryEntry[], standards: [] as string[], cached: false }),
    ),
  ]);
  return {
    intent,
    routes,
    standards: standards.entries,
    standardsResolved: standards.standards,
  };
}
