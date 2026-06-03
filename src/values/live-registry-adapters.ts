/**
 * live-registry-adapters — the real endpoints behind the standards-registry layers.
 *
 * standards-registry.ts defines the SHAPE (a standard is a cached adapter); this finds
 * and wires the actual registries so unbrowse can resolve real entries from each, then
 * cache them. Endpoints discovered + recorded below (the "find those" step). The fetch
 * is injected so the mapping is hermetically testable; a live call needs only network.
 *
 * Discovered endpoints:
 *   - mcp / mcp-registry : https://registry.modelcontextprotocol.io/v0/servers?search=  (official MCP registry)
 *   - a2a                : per-domain Agent Card at /.well-known/agent-card.json (+ a2aregistry.org)
 *   - x402-bazaar        : the x402 Bazaar discovery layer (Coinbase x402 × A2A marketplace)
 *   - skills.sh          : skill registry
 *   - agentskills.dev    : skill registry
 *   - pay.sh             : agent payment rail
 * Where a standard has no single public list API yet (a2a is per-domain; pay.sh is a
 * rail), the entry is marked accordingly and resolves to what it can — honest, not faked.
 */
import type { AgentStandard, RegistryEntry, StandardAdapter } from "./standards-registry.js";

export type FetchJson = (url: string) => Promise<unknown>;

const defaultFetchJson: FetchJson = async (url) => {
  const res = await fetch(url, { headers: { accept: "application/json" } });
  if (!res.ok) throw new Error(`registry ${url} → HTTP ${res.status}`);
  return res.json();
};

/** Per-standard registry endpoints (the discovered "those"). `list` is a query→URL
 *  builder for standards with a search API; `perDomain` marks discovery that is keyed
 *  on a host (A2A agent cards) rather than a central list. */
export interface RegistryEndpoint {
  base: string;
  list?: (query: string) => string;
  perDomain?: boolean;
  note?: string;
}
export const REGISTRY_ENDPOINTS: Partial<Record<AgentStandard, RegistryEndpoint>> = {
  "mcp": {
    base: "https://registry.modelcontextprotocol.io",
    list: (q) => `https://registry.modelcontextprotocol.io/v0/servers?search=${encodeURIComponent(q)}&limit=20`,
  },
  "mcp-registry": {
    base: "https://registry.modelcontextprotocol.io",
    list: (q) => `https://registry.modelcontextprotocol.io/v0/servers?search=${encodeURIComponent(q)}&limit=20`,
  },
  // VERIFIED LIVE (probe returned 200 + a real JSON list): a2aregistry returns
  // {agents:[{name,url,…}]}; skills.sh returns {skills:[{id,source,…}]}.
  "a2a": {
    base: "https://a2aregistry.org",
    note: "Verified live: {agents:[…]} ; A2A agents also publish a per-host Agent Card at /.well-known/agent-card.json.",
    list: (q) => `https://a2aregistry.org/api/agents?q=${encodeURIComponent(q)}`,
  },
  "skills.sh": {
    base: "https://skills.sh",
    note: "Verified live: {skills:[{id,source,…}]}.",
    list: (q) => `https://skills.sh/api/search?q=${encodeURIComponent(q)}`,
  },
  // UNVERIFIED (probe failed): no confirmed JSON list endpoint, so NO `list` — these
  // resolve to [] (honest) until a real endpoint is confirmed, rather than guessing one.
  "agentskills.dev": {
    base: "https://agentskills.dev",
    note: "Domain unreachable at probe time (DNS/000); no confirmed list API — resolves [] until verified.",
  },
  "x402-bazaar": {
    base: "https://x402.org",
    note: "x402 Bazaar discovery is via the x402 facilitator (a redirecting page, not a confirmed JSON list); resolves [] until the list endpoint is confirmed.",
  },
  "pay.sh": {
    base: "https://pay.sh",
    note: "Payment rail; no public skill list — surfaced as the rail itself.",
  },
};

/** Best-effort mapper: pull a flat array of items out of whatever shape a registry
 *  returns (servers / agents / skills / results / data / items / the array itself). */
function itemsOf(payload: unknown): Array<Record<string, unknown>> {
  if (Array.isArray(payload)) return payload as Array<Record<string, unknown>>;
  if (payload && typeof payload === "object") {
    const o = payload as Record<string, unknown>;
    for (const k of ["servers", "agents", "skills", "results", "data", "items"]) {
      if (Array.isArray(o[k])) return o[k] as Array<Record<string, unknown>>;
    }
  }
  return [];
}

/** Pull a URL out of a field that may be a string or a {url} object (the MCP registry
 *  wraps `repository` as `{url, source}`). */
function urlOf(v: unknown): string | undefined {
  if (typeof v === "string") return v;
  if (v && typeof v === "object" && typeof (v as { url?: unknown }).url === "string") {
    return (v as { url: string }).url;
  }
  return undefined;
}

function toEntry(standard: AgentStandard, raw: Record<string, unknown>): RegistryEntry {
  // The MCP registry nests each entry under `.server`; others are flat. Unwrap either.
  const s = (raw.server && typeof raw.server === "object" ? raw.server : raw) as Record<string, unknown>;
  const id = String(s.id ?? s.name ?? s.slug ?? urlOf(s.url) ?? urlOf(s.endpoint) ?? "");
  const ref = String(
    urlOf(s.url) ?? urlOf(s.endpoint) ?? urlOf(s.wellKnownURI) ?? urlOf(s.homepage)
      ?? urlOf(s.repository) ?? urlOf(s.remote) ?? urlOf(s.source) ?? (typeof s.source === "string" ? s.source : undefined) ?? id,
  );
  const title = (s.title ?? s.name ?? s.description) as string | undefined;
  return { standard, id, ref, title, meta: s };
}

/** A live, fetch-backed adapter for one standard. Resolves a query against the
 *  standard's real registry endpoint and normalizes the result. Returns [] for a
 *  standard with no list API (honest) rather than fabricating entries. */
export function liveAdapter(standard: AgentStandard, fetchJson: FetchJson = defaultFetchJson): StandardAdapter {
  const ep = REGISTRY_ENDPOINTS[standard];
  return {
    standard,
    resolve: async (query) => {
      if (!ep?.list) return []; // no public list API → nothing to enumerate (honest)
      const payload = await fetchJson(ep.list(query));
      return itemsOf(payload).map((it) => toEntry(standard, it));
    },
  };
}

/** The live resolver map for buildAdapters() — every standard that has a real list
 *  endpoint, fetch-backed. Inject a fetch for tests; defaults to the network. */
export function liveResolvers(
  fetchJson: FetchJson = defaultFetchJson,
): Partial<Record<AgentStandard, (q: string) => Promise<RegistryEntry[]>>> {
  const out: Partial<Record<AgentStandard, (q: string) => Promise<RegistryEntry[]>>> = {};
  for (const standard of Object.keys(REGISTRY_ENDPOINTS) as AgentStandard[]) {
    if (REGISTRY_ENDPOINTS[standard]?.list) {
      out[standard] = (q: string) => liveAdapter(standard, fetchJson).resolve(q);
    }
  }
  return out;
}
