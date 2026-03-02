import { getRegistrableDomain } from "../domain.js";
import { log } from "../logger.js";

export interface BundleRoute {
  path: string;
  url: string;
  source_bundle: string;
  match_type: "string_literal" | "fetch_call" | "route_def";
}

// String literals containing /api/ paths — primary signal, catches 90% of cases
// The (?:[?#]...)? allows optional query strings after the path (e.g., "/api/search?q=")
const API_PATH_PATTERN = /["'`](\/api\/[a-zA-Z0-9/_-]{2,80})(?:[?#][^"'`]*)?["'`]/g;

// fetch/axios calls with URL strings
const FETCH_PATTERN = /(?:fetch|axios|\.get|\.post|\.put|\.patch|\.delete)\s*\(\s*["'`](\/[a-zA-Z0-9/_-]{3,80})(?:[?#][^"'`]*)?["'`]/g;

// Versioned API paths: /v1/..., /v2/...
const VERSIONED_API_PATTERN = /["'`](\/v[0-9]+\/[a-zA-Z0-9/_-]{2,80})(?:[?#][^"'`]*)?["'`]/g;

// Framework internals — NOT API routes
const SKIP_BUNDLE_PATHS = /^\/((_next|__next|__webpack|__vite|static|assets|public|favicon|manifest|service-worker|sw|workbox|chunks?|node_modules|\.well-known)\b)/i;

// File extension paths — asset references, not APIs
const SKIP_EXTENSIONS = /\.(js|mjs|css|json|html|xml|svg|png|jpg|jpeg|gif|ico|woff2?|ttf|map|ts|tsx|jsx|vue|md|txt|webp|avif)$/i;

// Too-generic single-segment paths
const TOO_GENERIC = /^\/[a-z]{1,3}$/i;

function extractMatches(
  content: string,
  pattern: RegExp,
  matchType: BundleRoute["match_type"],
): Array<{ path: string; match_type: BundleRoute["match_type"] }> {
  const results: Array<{ path: string; match_type: BundleRoute["match_type"] }> = [];
  pattern.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(content)) !== null) {
    if (match[1]) results.push({ path: match[1], match_type: matchType });
  }
  return results;
}

export function scanBundlesForRoutes(
  bundles: Map<string, string>,
  pageOrigin: string,
): BundleRoute[] {
  const routes: BundleRoute[] = [];
  const seen = new Set<string>();

  for (const [bundleUrl, content] of bundles) {
    const matches = [
      ...extractMatches(content, API_PATH_PATTERN, "string_literal"),
      ...extractMatches(content, FETCH_PATTERN, "fetch_call"),
      ...extractMatches(content, VERSIONED_API_PATTERN, "string_literal"),
    ];

    for (const { path, match_type } of matches) {
      const normalized = path.replace(/\/+$/, "").replace(/\/\//g, "/");

      if (seen.has(normalized)) continue;
      if (SKIP_BUNDLE_PATHS.test(normalized)) continue;
      if (SKIP_EXTENSIONS.test(normalized)) continue;
      if (TOO_GENERIC.test(normalized)) continue;
      if (normalized.length < 4) continue;

      seen.add(normalized);
      routes.push({
        path: normalized,
        url: `${pageOrigin}${normalized}`,
        source_bundle: bundleUrl,
        match_type,
      });
    }
  }

  log("bundle-scanner", `found ${routes.length} API routes in ${bundles.size} JS bundles`);
  return routes;
}
