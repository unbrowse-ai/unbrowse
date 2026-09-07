/**
 * Which answer wins: a learned internal API, or a cached scrape of the page?
 *
 * Background discovery necessarily runs AFTER a call has already settled from
 * HTML — the whole point is that the caller gets the document immediately and
 * the site's real XHR routes are indexed behind it. That ordering means the
 * cached document is always the OLDER answer once a skill exists for the host.
 *
 * Without this rule the CLI's resolution-cache fast path replayed that document
 * forever and the freshly-indexed route was never reached. Witnessed on
 * defillama.com: a skill was written into domain-skill-cache.json and the warm
 * call still returned `source: direct-document, mode: resolution_cache`.
 *
 * Deliberately narrow, because this INVALIDATES a cache hit:
 *   - only a DOCUMENT-shaped cached result is ever outranked; a cached
 *     internal-API result is left alone (that is the hit the fast path exists
 *     for, and re-executing it would be a pure regression);
 *   - only when a skill actually exists for that host AND covers a real
 *     internal API (not bare page_fetch / direct-document);
 *   - anything unreadable means "no skill" — fail open to the existing replay.
 *
 * Pure: the caller owns the disk read, so this is exhaustively testable.
 * Lifecycle consulting: src/orchestrator/DESIGN_NOTES.md — always consult
 * lifecycle/skill state before browsing; the cache fast-path mirrors the
 * orchestrator's indexedInternalApiOutranksDocument guard (skillCoversRealApi)
 * so marketplace and local skills with a real API both outrank the scrape,
 * while a bare page_fetch skill leaves direct-document as the honest cold-start.
 */

/** Sources that mean "we parsed the page", as opposed to calling the site's API. */
const DOCUMENT_SOURCES = new Set(["direct-document", "dom-fallback"]);

/** Was this cached resolution produced by scraping a document? */
export function cachedResultIsDocument(hit: unknown): boolean {
  if (!hit || typeof hit !== "object") return false;
  const h = hit as Record<string, unknown>;
  const nested = h.result && typeof h.result === "object"
    ? (h.result as Record<string, unknown>).source
    : undefined;
  const src = h.source ?? nested;
  return typeof src === "string" && DOCUMENT_SOURCES.has(src);
}

/** Lightweight page_fetch check — mirrors execution/isPageFetchEndpoint without importing it. */
function isPageFetchEndpoint(ep: unknown): boolean {
  if (!ep || typeof ep !== "object") return false;
  const e = ep as Record<string, unknown>;
  const dom = e.dom_extraction as Record<string, unknown> | undefined;
  if (dom?.extraction_method === "page_fetch") return true;
  const schema = e.response_schema as Record<string, unknown> | undefined;
  const description = typeof e.description === "string" ? e.description : "";
  if (dom && /rendered (?:html|page)|fetches the rendered page|returns the rendered html/i.test(description)) return true;
  return !!dom
    && schema?.type === "string"
    && schema?.format === "html"
    && /rendered (?:html|page)|fetches the rendered page|returns the rendered html/i.test(description);
}

/**
 * True when this cache entry covers at least one real internal-API endpoint
 * (not bare page_fetch / direct-document). Accepts the shapes callers
 * actually pass:
 *  - { endpoints: EndpointDescriptor[] }
 *  - { skill: { endpoints: [...] } }
 *  - { hasRealApi: boolean } explicit signal
 *  - bare { skillId, ts, localSkillPath } with no endpoint info → treat as
 *    real-API-bearing for backward compat (old caches predate endpoint
 *    inspection); a doc-only skill must be represented with explicit endpoints
 *    so the guard can see it is bare page_fetch and stay honest.
 */
export function skillEntryCoversRealApi(entry: unknown): boolean {
  if (!entry || typeof entry !== "object") return false;
  const e = entry as Record<string, unknown>;
  if (typeof e.hasRealApi === "boolean") return e.hasRealApi;
  if (typeof e.coversRealApi === "boolean") return e.coversRealApi;
  // Direct endpoints array
  const direct = e.endpoints;
  if (Array.isArray(direct)) {
    if (direct.length === 0) return false;
    return direct.some((ep) => !isPageFetchEndpoint(ep));
  }
  // Nested skill object
  const nested = e.skill as Record<string, unknown> | undefined;
  if (nested && Array.isArray(nested.endpoints)) {
    const eps = nested.endpoints as unknown[];
    if (eps.length === 0) return false;
    return eps.some((ep) => !isPageFetchEndpoint(ep));
  }
  // No endpoint info — backward compat: an indexed skill entry without
  // explicit endpoints is assumed to cover a real API (the historical
  // behaviour that the defillama witness relies on). Callers that need
  // the doc-only cold-start path must supply endpoints so the guard can
  // distinguish.
  // Distinguish a bare empty object from a real entry: require at least
  // skillId/localSkillPath/ts marker.
  if (e.skillId !== undefined || e.localSkillPath !== undefined || e.ts !== undefined) return true;
  return false;
}

/**
 * True when a learned internal-API skill should beat this cached document.
 *
 * `domainSkillCache` is the parsed domain-skill-cache.json (or null when it is
 * missing/unreadable). Host is matched with and without a leading `www.`, since
 * the cache is keyed by whichever form the capture saw. The matched entry must
 * additionally cover a real API (not bare page_fetch) — otherwise
 * direct-document remains the honest cold-start and background discovery is
 * queued for the next call.
 */
export function learnedSkillOutranksCachedDocument(
  url: string,
  hit: unknown,
  domainSkillCache: Record<string, unknown> | null | undefined,
): boolean {
  if (!domainSkillCache) return false;
  if (!cachedResultIsDocument(hit)) return false;
  let host: string;
  try { host = new URL(url).hostname; } catch { return false; }
  // Normalise BOTH sides. The cache is keyed by whatever hostname the capture
  // happened to see, so stripping www. only from the request host still missed
  // a skill indexed under `www.example.com` when the caller asked for
  // `example.com` — the same route, recorded under the other spelling.
  const bare = (h: string) => h.replace(/^www\./, "");
  const want = bare(host);
  // Collect matching entries (exact host, bare host, and any bare-equal key)
  const keys = Object.keys(domainSkillCache);
  const matchingEntries: unknown[] = [];
  if (domainSkillCache[host] !== undefined) matchingEntries.push(domainSkillCache[host]);
  if (host !== want && domainSkillCache[want] !== undefined) matchingEntries.push(domainSkillCache[want]);
  for (const k of keys) {
    if (k === host || k === want) continue;
    if (bare(k) === want) matchingEntries.push(domainSkillCache[k]);
  }
  if (matchingEntries.length === 0) return false;
  // At least one matching skill must cover a real API — generalises the old
  // local-skill-only guard to any marketplace or local skill with usable
  // endpoints (not bare page_fetch / direct-document). When no real API
  // exists, direct-document stays honest cold-start (and queues background
  // discovery so the next call wins as API). Preserves the concrete-resource
  // guard's ordering: that guard runs before this in the orchestrator.
  return matchingEntries.some((entry) => skillEntryCoversRealApi(entry));
}
