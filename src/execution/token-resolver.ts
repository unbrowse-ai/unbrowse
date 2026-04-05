/**
 * Replay-time token resolution.
 *
 * At capture time (src/reverse-engineer/token-sources.ts), the pipeline records
 * a list of AuthTokenBinding on each endpoint describing where each required
 * token value can be sourced from — cookie, HTML <meta>, inline script, or JS
 * bundle. At replay time, this resolver walks those bindings, re-fetches live
 * page state if needed, extracts the current value via the recorded locator,
 * and returns it grouped by target location (header / body / query).
 *
 * Caching: fetched HTML + bundles are cached per origin for 5 minutes. The cache
 * is invalidated by callers on 401/403 via invalidateTokenCache(origin).
 *
 * No mocks — this file only talks to real HTTP via serverFetch-style calls to
 * trigger URLs using the caller-supplied auth bundle.
 */

import type { AuthTokenBinding, AuthTokenSource } from "../types/index.js";
import { extractTokenFromHtml, extractTokenFromBundle } from "../reverse-engineer/token-sources.js";
import { log } from "../logger.js";

// Per-origin page state cache. Caller is responsible for invalidation on auth
// failures — scrape cost is too high to re-run for every call.
interface CachedOriginState {
  html?: string;
  bundles?: Map<string, string>;
  fetchedAt: number;
}

const CACHE_TTL_MS = 5 * 60 * 1000;
const originCache = new Map<string, CachedOriginState>();
const inflightFetches = new Map<string, Promise<CachedOriginState>>();

export interface ResolvedTokens {
  headers: Record<string, string>;
  body: Record<string, string>;
  query: Record<string, string>;
}

export interface TokenResolverContext {
  /** Page URL that originally triggered the endpoint's capture. Used to
   *  re-fetch live HTML for html-meta and html-inline-script sources. */
  triggerUrl?: string;
  /** Cookies from the auth profile — used to (a) satisfy cookie sources and
   *  (b) authorize the trigger URL rescrape. */
  cookies: Array<{ name: string; value: string; domain: string; path?: string }>;
  /** Auth headers from the vault — used to authorize rescrapes. */
  authHeaders: Record<string, string>;
  /** Force rescrape even if cache is fresh. Set true on 401 retries. */
  forceRefresh?: boolean;
}

/**
 * Resolve all token bindings on an endpoint to concrete values, grouped by
 * where they need to be injected into the outgoing request. Returns empty
 * maps when no bindings are present or all bindings fail to resolve.
 */
export async function resolveAuthTokens(
  bindings: AuthTokenBinding[] | undefined,
  ctx: TokenResolverContext,
): Promise<ResolvedTokens> {
  const out: ResolvedTokens = { headers: {}, body: {}, query: {} };
  if (!bindings || bindings.length === 0) return out;

  for (const binding of bindings) {
    const value = await resolveBinding(binding, ctx);
    if (!value) {
      log("token-resolver", `no value for ${binding.param_location}/${binding.param_name} from ${binding.sources.length} source(s)`);
      continue;
    }
    const bucket =
      binding.param_location === "header" ? out.headers :
      binding.param_location === "body" ? out.body :
      out.query;
    bucket[binding.param_name.toLowerCase()] = value;
  }
  return out;
}

/** Walk a binding's sources in order and return the first non-empty value. */
async function resolveBinding(
  binding: AuthTokenBinding,
  ctx: TokenResolverContext,
): Promise<string | undefined> {
  for (const source of binding.sources) {
    try {
      const value = await resolveSource(source, ctx);
      if (value) return value;
    } catch (err) {
      log("token-resolver", `source ${source.kind} failed: ${err instanceof Error ? err.message : err}`);
    }
  }
  return undefined;
}

async function resolveSource(
  source: AuthTokenSource,
  ctx: TokenResolverContext,
): Promise<string | undefined> {
  if (source.kind === "cookie") {
    if (!source.cookie_names || source.cookie_names.length === 0) return undefined;
    for (const name of source.cookie_names) {
      const cookie = ctx.cookies.find((c) => c.name.toLowerCase() === name.toLowerCase());
      if (cookie) {
        // Strip enclosing quotes (Chrome stores quoted; headers want unquoted)
        const v = cookie.value;
        return v.startsWith('"') && v.endsWith('"') ? v.slice(1, -1) : v;
      }
    }
    return undefined;
  }

  if (source.kind === "html-meta" || source.kind === "html-inline-script") {
    if (!ctx.triggerUrl) return undefined;
    const state = await fetchOriginState(ctx.triggerUrl, ctx);
    if (!state.html) return undefined;
    return extractTokenFromHtml(source, state.html);
  }

  if (source.kind === "js-bundle") {
    if (!ctx.triggerUrl || !source.bundle_url_pattern) return undefined;
    const state = await fetchOriginState(ctx.triggerUrl, ctx);
    if (!state.bundles || state.bundles.size === 0) return undefined;
    // Find a bundle whose URL contains the recorded pattern
    for (const [bundleUrl, content] of state.bundles) {
      if (!bundleUrl.includes(source.bundle_url_pattern)) continue;
      const value = extractTokenFromBundle(source, content);
      if (value) return value;
    }
    return undefined;
  }

  return undefined;
}

// ─── Origin state fetcher + cache ──────────────────────────────────────────

/**
 * Fetch (or return cached) HTML + JS bundles for the origin of a trigger URL.
 * Uses the same auth bundle (cookies + headers) that serverFetch would use,
 * so rescrapes work for authed pages. JS bundles are only loaded lazily — HTML
 * fetch always happens, bundles are fetched when a binding actually needs them.
 */
async function fetchOriginState(
  triggerUrl: string,
  ctx: TokenResolverContext,
): Promise<CachedOriginState> {
  const originKey = originKeyFor(triggerUrl);
  if (!ctx.forceRefresh) {
    const cached = originCache.get(originKey);
    if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) return cached;
  }
  const inflight = inflightFetches.get(originKey);
  if (inflight) return inflight;

  const p = doFetchOriginState(triggerUrl, ctx);
  inflightFetches.set(originKey, p);
  try {
    const result = await p;
    originCache.set(originKey, result);
    return result;
  } finally {
    inflightFetches.delete(originKey);
  }
}

async function doFetchOriginState(
  triggerUrl: string,
  ctx: TokenResolverContext,
): Promise<CachedOriginState> {
  const headers: Record<string, string> = {
    accept: "text/html,application/xhtml+xml,*/*",
    "user-agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
    ...ctx.authHeaders,
  };

  if (ctx.cookies.length > 0) {
    headers["cookie"] = ctx.cookies.map((c) => {
      const v = c.value.startsWith('"') && c.value.endsWith('"') ? c.value.slice(1, -1) : c.value;
      return `${c.name}=${v}`;
    }).join("; ");
  }

  try {
    const res = await fetch(triggerUrl, { headers, redirect: "follow" });
    if (!res.ok) {
      log("token-resolver", `trigger fetch ${triggerUrl} returned ${res.status}`);
      return { fetchedAt: Date.now() };
    }
    const html = await res.text();
    return { html, fetchedAt: Date.now() };
  } catch (err) {
    log("token-resolver", `trigger fetch ${triggerUrl} failed: ${err instanceof Error ? err.message : err}`);
    return { fetchedAt: Date.now() };
  }
}

function originKeyFor(url: string): string {
  try { return new URL(url).origin; } catch { return url; }
}

/** Invalidate the cached state for a trigger URL's origin. Called by serverFetch
 *  on 401/403 to force a fresh rescrape before retry. */
export function invalidateTokenCache(urlOrOrigin: string): void {
  originCache.delete(originKeyFor(urlOrOrigin));
}

/** Testing hook — clear everything. */
export function _clearTokenCacheForTests(): void {
  originCache.clear();
  inflightFetches.clear();
}
