import { getRegistrableDomain } from "../domain.js";
import { log } from "../logger.js";

export interface BundleRoute {
  path: string;
  url: string;
  source_bundle: string;
  match_type: "string_literal" | "fetch_call" | "route_def";
  /** Query param names extracted from the JS source (e.g. "/api/search?q=" → ["q"]) */
  query_params?: string[];
}

// String literals containing /api/ paths — primary signal, catches 90% of cases
// Group 1: path, Group 2: query string (without the leading ?)
const API_PATH_PATTERN = /["'`](\/api\/[a-zA-Z0-9/_-]{2,80})(?:\?([^"'`#]*))?["'`]/g;

// fetch/axios calls with URL strings
const FETCH_PATTERN = /(?:fetch|axios|\.get|\.post|\.put|\.patch|\.delete)\s*\(\s*["'`](\/[a-zA-Z0-9/_-]{3,80})(?:\?([^"'`#]*))?["'`]/g;

// Versioned API paths: /v1/..., /v2/...
const VERSIONED_API_PATTERN = /["'`](\/v[0-9]+\/[a-zA-Z0-9/_-]{2,80})(?:\?([^"'`#]*))?["'`]/g;

// Framework internals — NOT API routes
const SKIP_BUNDLE_PATHS = /^\/((_next|__next|__webpack|__vite|static|assets|public|favicon|manifest|service-worker|sw|workbox|chunks?|node_modules|\.well-known)\b)/i;

// File extension paths — asset references, not APIs
const SKIP_EXTENSIONS = /\.(js|mjs|css|json|html|xml|svg|png|jpg|jpeg|gif|ico|woff2?|ttf|map|ts|tsx|jsx|vue|md|txt|webp|avif)$/i;

// Too-generic single-segment paths
const TOO_GENERIC = /^\/[a-z]{1,3}$/i;

// Sensitive query param names that should not be included
const SENSITIVE_PARAM = /^(api[_-]?key|apikey|access[_-]?token|auth[_-]?token|secret|password|key|token|session[_-]?id|client[_-]?secret|private[_-]?key|bearer)$/i;

/** Extract param names from a query string found in JS source.
 *  Handles: "q=", "q=value", "q=${var}", "q", "q=&page=1" */
function extractParamNames(queryString: string): string[] {
  if (!queryString) return [];
  const names: string[] = [];
  for (const part of queryString.split("&")) {
    const eqIdx = part.indexOf("=");
    const key = (eqIdx >= 0 ? part.slice(0, eqIdx) : part).trim();
    // Skip empty keys, template expressions like ${...}, and sensitive params
    if (!key || key.startsWith("$") || key.startsWith("{") || SENSITIVE_PARAM.test(key)) continue;
    // Skip framework-internal params
    if (/^(_rsc|_next|__next|_t|_hash|__cf_chl_tk|nxtP\[.*\])$/i.test(key)) continue;
    names.push(key);
  }
  return names;
}

function extractMatches(
  content: string,
  pattern: RegExp,
  matchType: BundleRoute["match_type"],
): Array<{ path: string; query_string?: string; match_type: BundleRoute["match_type"] }> {
  const results: Array<{ path: string; query_string?: string; match_type: BundleRoute["match_type"] }> = [];
  pattern.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(content)) !== null) {
    if (match[1]) results.push({ path: match[1], query_string: match[2] || undefined, match_type: matchType });
  }
  return results;
}

export function scanBundlesForRoutes(
  bundles: Map<string, string>,
  pageOrigin: string,
): BundleRoute[] {
  const routes: BundleRoute[] = [];
  const seen = new Set<string>();
  // Accumulate query params across multiple occurrences of the same path
  const queryParamsByPath = new Map<string, Set<string>>();

  for (const [bundleUrl, content] of bundles) {
    const matches = [
      ...extractMatches(content, API_PATH_PATTERN, "string_literal"),
      ...extractMatches(content, FETCH_PATTERN, "fetch_call"),
      ...extractMatches(content, VERSIONED_API_PATTERN, "string_literal"),
    ];

    for (const { path, query_string, match_type } of matches) {
      const normalized = path.replace(/\/+$/, "").replace(/\/\//g, "/");

      if (SKIP_BUNDLE_PATHS.test(normalized)) continue;
      if (SKIP_EXTENSIONS.test(normalized)) continue;
      if (TOO_GENERIC.test(normalized)) continue;
      if (normalized.length < 4) continue;

      // Collect query params from this occurrence
      if (query_string) {
        const params = extractParamNames(query_string);
        if (params.length > 0) {
          if (!queryParamsByPath.has(normalized)) queryParamsByPath.set(normalized, new Set());
          for (const p of params) queryParamsByPath.get(normalized)!.add(p);
        }
      }

      if (seen.has(normalized)) continue;
      seen.add(normalized);

      routes.push({
        path: normalized,
        url: `${pageOrigin}${normalized}`,
        source_bundle: bundleUrl,
        match_type,
      });
    }
  }

  // Attach accumulated query params to routes
  for (const route of routes) {
    const params = queryParamsByPath.get(route.path);
    if (params && params.size > 0) {
      route.query_params = [...params];
    }
  }

  log("bundle-scanner", `found ${routes.length} API routes in ${bundles.size} JS bundles`);
  return routes;
}
