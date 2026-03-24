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

export interface BundleMutationRoute {
  path: string;
  url: string;
  source_bundle: string;
  method: "POST" | "PUT" | "PATCH" | "DELETE";
  body_keys?: string[];
}

// String literals containing /api/ paths — primary signal, catches 90% of cases
// Group 1: path, Group 2: query string (without the leading ?)
const API_PATH_PATTERN = /["'`](\/api\/[a-zA-Z0-9/_-]{2,80})(?:\?([^"'`#]*))?["'`]/g;

// fetch/axios calls with URL strings
const FETCH_PATTERN = /(?:fetch|axios|\.get|\.post|\.put|\.patch|\.delete)\s*\(\s*["'`](\/[a-zA-Z0-9/_-]{3,80})(?:\?([^"'`#]*))?["'`]/g;

// Versioned API paths: /v1/..., /v2/...
const VERSIONED_API_PATTERN = /["'`](\/v[0-9]+\/[a-zA-Z0-9/_-]{2,80})(?:\?([^"'`#]*))?["'`]/g;
const MUTATION_CALL_PATTERN = /\.(post|put|patch|delete)\s*\(\s*["'`](\/[a-zA-Z0-9/_-]{2,120})(?:\?([^"'`#]*))?["'`]\s*,/gi;
const FETCH_CALL_PATTERN = /fetch\s*\(\s*["'`](\/[a-zA-Z0-9/_-]{2,120})(?:\?([^"'`#]*))?["'`]\s*,/gi;
const CONFIG_MUTATION_PATTERN = /(?:axios|fetcher|client|request|api)\s*\(\s*\{/gi;

// Framework internals — NOT API routes
const SKIP_BUNDLE_PATHS = /^\/((_next|__next|__webpack|__vite|static|assets|public|favicon|manifest|service-worker|sw|workbox|chunks?|node_modules|\.well-known)\b)/i;

// File extension paths — asset references, not APIs
const SKIP_EXTENSIONS = /\.(js|mjs|css|json|html|xml|svg|png|jpg|jpeg|gif|ico|woff2?|ttf|map|ts|tsx|jsx|vue|md|txt|webp|avif)$/i;

// Too-generic single-segment paths
const TOO_GENERIC = /^\/[a-z]{1,3}$/i;

// Public-site bundle scans often surface account/settings/bootstrap routes first.
// Skip obviously non-public app-management surfaces so root captures don't learn junk.
const SKIP_NON_PUBLIC_ROUTE_PATHS =
  /^(\/manage\/account\/|\/account\/webauthn|\/settings(?:\/|$)|\/org\/create(?:\/|$)|\/login(?:\/|$)|\/logout(?:\/|$)|\/signin(?:\/|$)|\/sign-in(?:\/|$)|\/signup(?:\/|$)|\/register(?:\/|$)|\/oauth(?:\/|$)|\/sso(?:\/|$)|\/session(?:\/|$)|\/admin(?:\/|$)|\/billing(?:\/|$))/i;

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

function readBalancedObjectLiteral(content: string, startIndex: number): string | null {
  if (content[startIndex] !== "{") return null;
  let depth = 0;
  let inString: '"' | "'" | "`" | null = null;
  let escaped = false;

  for (let i = startIndex; i < content.length; i++) {
    const char = content[i]!;
    if (inString) {
      if (escaped) {
        escaped = false;
        continue;
      }
      if (char === "\\") {
        escaped = true;
        continue;
      }
      if (char === inString) inString = null;
      continue;
    }

    if (char === '"' || char === "'" || char === "`") {
      inString = char;
      continue;
    }
    if (char === "{") depth += 1;
    else if (char === "}") {
      depth -= 1;
      if (depth === 0) return content.slice(startIndex, i + 1);
    }
  }

  return null;
}

function extractTopLevelObjectKeys(source: string): string[] {
  if (!source.startsWith("{") || !source.endsWith("}")) return [];
  const keys: string[] = [];
  let braceDepth = 0;
  let bracketDepth = 0;
  let parenDepth = 0;
  let inString: '"' | "'" | "`" | null = null;
  let escaped = false;
  let segmentStart = 1;

  const maybePushKey = (segment: string) => {
    const trimmed = segment.trim();
    if (!trimmed) return;
    const colonIndex = trimmed.indexOf(":");
    const rawKey = (colonIndex >= 0 ? trimmed.slice(0, colonIndex) : trimmed)
      .trim()
      .replace(/^["'`](.*)["'`]$/, "$1");
    if (!rawKey) return;
    if (!/^[a-zA-Z_$][a-zA-Z0-9_$-]*$/.test(rawKey)) return;
    keys.push(rawKey);
  };

  for (let i = 1; i < source.length - 1; i++) {
    const char = source[i]!;
    if (inString) {
      if (escaped) {
        escaped = false;
        continue;
      }
      if (char === "\\") {
        escaped = true;
        continue;
      }
      if (char === inString) inString = null;
      continue;
    }

    if (char === '"' || char === "'" || char === "`") {
      inString = char;
      continue;
    }
    if (char === "{") {
      braceDepth += 1;
      continue;
    }
    if (char === "}") {
      if (braceDepth > 0) braceDepth -= 1;
      continue;
    }
    if (char === "[") {
      bracketDepth += 1;
      continue;
    }
    if (char === "]") {
      if (bracketDepth > 0) bracketDepth -= 1;
      continue;
    }
    if (char === "(") {
      parenDepth += 1;
      continue;
    }
    if (char === ")") {
      if (parenDepth > 0) parenDepth -= 1;
      continue;
    }
    if (char === "," && braceDepth === 0 && bracketDepth === 0 && parenDepth === 0) {
      maybePushKey(source.slice(segmentStart, i));
      segmentStart = i + 1;
    }
  }

  maybePushKey(source.slice(segmentStart, source.length - 1));
  return [...new Set(keys)];
}

function extractBodyLiteralFromOptionsLiteral(source: string): string | null {
  const bodyMatch = source.match(/\bbody\s*:\s*JSON\.stringify\s*\(\s*(\{[\s\S]*?\})\s*\)/i);
  if (bodyMatch?.[1]) return bodyMatch[1];
  const directBodyMatch = source.match(/\bbody\s*:\s*(\{[\s\S]*?\})/i);
  if (directBodyMatch?.[1]) return directBodyMatch[1];
  const dataMatch = source.match(/\bdata\s*:\s*(\{[\s\S]*?\})/i);
  if (dataMatch?.[1]) return dataMatch[1];
  return null;
}

function extractMethodFromOptionsLiteral(source: string): BundleMutationRoute["method"] | null {
  const match = source.match(/\bmethod\s*:\s*["'`](POST|PUT|PATCH|DELETE)["'`]/i);
  return match?.[1] ? match[1].toUpperCase() as BundleMutationRoute["method"] : null;
}

function pushMutationRoute(
  routes: BundleMutationRoute[],
  seen: Set<string>,
  pageOrigin: string,
  bundleUrl: string,
  method: BundleMutationRoute["method"],
  path: string,
  body_keys?: string[],
): void {
  const normalizedPath = path.replace(/\/+$/, "");
  if (!normalizedPath || SKIP_BUNDLE_PATHS.test(normalizedPath) || SKIP_EXTENSIONS.test(normalizedPath) || TOO_GENERIC.test(normalizedPath)) return;
  const dedupeKey = `${method}:${normalizedPath}`;
  if (seen.has(dedupeKey)) return;
  seen.add(dedupeKey);
  routes.push({
    path: normalizedPath,
    url: `${pageOrigin}${normalizedPath}`,
    source_bundle: bundleUrl,
    method,
    ...(body_keys && body_keys.length > 0 ? { body_keys } : {}),
  });
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
      if (SKIP_NON_PUBLIC_ROUTE_PATHS.test(normalized)) continue;
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

export function scanBundlesForMutationRoutes(
  bundles: Map<string, string>,
  pageOrigin: string,
): BundleMutationRoute[] {
  const routes: BundleMutationRoute[] = [];
  const seen = new Set<string>();

  for (const [bundleUrl, content] of bundles) {
    MUTATION_CALL_PATTERN.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = MUTATION_CALL_PATTERN.exec(content)) !== null) {
      const method = (match[1] ?? "").toUpperCase() as BundleMutationRoute["method"];
      const path = (match[2] ?? "").replace(/\/+$/, "");

      let body_keys: string[] | undefined;
      const commaIndex = match.index + match[0].length - 1;
      const objectStart = content.indexOf("{", commaIndex);
      if (objectStart >= 0) {
        const literal = readBalancedObjectLiteral(content, objectStart);
        const keys = literal ? extractTopLevelObjectKeys(literal) : [];
        if (keys.length > 0) body_keys = keys;
      }

      pushMutationRoute(routes, seen, pageOrigin, bundleUrl, method, path, body_keys);
    }

    FETCH_CALL_PATTERN.lastIndex = 0;
    while ((match = FETCH_CALL_PATTERN.exec(content)) !== null) {
      const path = match[1] ?? "";
      const commaIndex = match.index + match[0].length - 1;
      const objectStart = content.indexOf("{", commaIndex);
      if (objectStart < 0) continue;
      const optionsLiteral = readBalancedObjectLiteral(content, objectStart);
      if (!optionsLiteral) continue;
      const method = extractMethodFromOptionsLiteral(optionsLiteral);
      if (!method) continue;
      const bodyLiteral = extractBodyLiteralFromOptionsLiteral(optionsLiteral);
      const body_keys = bodyLiteral ? extractTopLevelObjectKeys(bodyLiteral) : undefined;
      pushMutationRoute(routes, seen, pageOrigin, bundleUrl, method, path, body_keys);
    }

    CONFIG_MUTATION_PATTERN.lastIndex = 0;
    while ((match = CONFIG_MUTATION_PATTERN.exec(content)) !== null) {
      const objectStart = content.indexOf("{", match.index + match[0].length - 1);
      if (objectStart < 0) continue;
      const configLiteral = readBalancedObjectLiteral(content, objectStart);
      if (!configLiteral) continue;
      const method = extractMethodFromOptionsLiteral(configLiteral);
      if (!method) continue;
      const urlMatch = configLiteral.match(/\b(?:url|path)\s*:\s*["'`](\/[a-zA-Z0-9/_-]{2,120})(?:\?[^"'`#]*)?["'`]/i);
      const path = urlMatch?.[1];
      if (!path) continue;
      const bodyLiteral = extractBodyLiteralFromOptionsLiteral(configLiteral);
      const body_keys = bodyLiteral ? extractTopLevelObjectKeys(bodyLiteral) : undefined;
      pushMutationRoute(routes, seen, pageOrigin, bundleUrl, method, path, body_keys);
    }
  }

  log("bundle-scanner", `found ${routes.length} mutation routes in ${bundles.size} JS bundles`);
  return routes;
}
