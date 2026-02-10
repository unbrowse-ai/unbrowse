/**
 * Site Crawler — Browse a site like a real user to discover more API endpoints.
 *
 * After loading the seed URL, extracts same-domain links and visits them
 * to trigger additional API calls. Also opportunistically checks for
 * OpenAPI/Swagger specs.
 */

// ── Types ────────────────────────────────────────────────────────────────────

export interface CrawlOptions {
  /** Max pages to visit beyond seed (default: 15) */
  maxPages?: number;
  /** Max crawl time in ms (default: 60000) */
  maxTimeMs?: number;
  /** Max link depth from seed URL (default: 2) */
  maxDepth?: number;
  /** Whether to look for OpenAPI specs (default: true) */
  discoverOpenApi?: boolean;
}

export interface CrawlResult {
  visitedUrls: string[];
  pagesCrawled: number;
  crawlTimeMs: number;
  openApiSpec: OpenApiSpec | null;
  openApiSource: string | null;
}

export interface OpenApiSpec {
  raw: any;
  endpoints: OpenApiEndpoint[];
  version: string;
  baseUrl?: string;
}

export interface OpenApiEndpoint {
  method: string;
  path: string;
  summary?: string;
  operationId?: string;
}

// ── Link scoring ─────────────────────────────────────────────────────────────

const SKIP_PATTERNS = [
  /\/(login|signin|signup|register|logout|signout)\b/i,
  /\/(terms|privacy|tos|legal|cookie-policy)\b/i,
  /\/(about|contact|blog|press|careers|help|support|faq)\b/i,
  /\.(pdf|zip|tar|gz|exe|dmg|mp4|mp3|svg|png|jpg|jpeg|gif|webp|css|js)$/i,
  /^\/?(#|mailto:|tel:|javascript:)/i,
];

const INTERESTING_PATTERNS: { pattern: RegExp; score: number }[] = [
  { pattern: /\/(dashboard|admin|console|portal)\b/i, score: 10 },
  { pattern: /\/(api|developer|integrations|docs)\b/i, score: 9 },
  { pattern: /\/(settings|preferences|config|account)\b/i, score: 8 },
  { pattern: /\/(analytics|reports|metrics|stats)\b/i, score: 7 },
  { pattern: /\/(projects?|workspace|team|org)\b/i, score: 6 },
  { pattern: /\/(inventory|orders?|products?|catalog)\b/i, score: 6 },
  { pattern: /\/(modules?|courses?|timetable|schedule|planner)\b/i, score: 6 },
  { pattern: /\/(billing|subscription|plan)\b/i, score: 5 },
  { pattern: /\/(users?|members?|profiles?)\b/i, score: 5 },
  { pattern: /\/(notifications?|activity|feed)\b/i, score: 4 },
  { pattern: /\/(search|explore|discover|browse|venues?|facilities)\b/i, score: 4 },
];

function scoreLink(url: string, path: string): number {
  for (const pattern of SKIP_PATTERNS) {
    if (pattern.test(path) || pattern.test(url)) return -1;
  }

  let score = 1;
  for (const { pattern, score: s } of INTERESTING_PATTERNS) {
    if (pattern.test(path)) {
      score = Math.max(score, s);
    }
  }

  // Penalize very deep paths
  const segments = path.split("/").filter(Boolean);
  if (segments.length > 4) score -= 2;

  return score;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function normalizeUrl(url: string): string {
  try {
    const u = new URL(url);
    u.hash = "";
    if (u.pathname.endsWith("/") && u.pathname !== "/") {
      u.pathname = u.pathname.slice(0, -1);
    }
    u.searchParams.sort();
    return u.toString();
  } catch {
    return url;
  }
}

async function extractLinks(page: any, seedOrigin: string): Promise<string[]> {
  const links: string[] = await page.evaluate((origin: string) => {
    const anchors = Array.from(document.querySelectorAll("a[href]"));
    const hrefs: string[] = [];
    for (const a of anchors) {
      const href = (a as HTMLAnchorElement).href;
      try {
        const url = new URL(href);
        if (url.origin === origin && url.pathname !== "/") {
          hrefs.push(url.origin + url.pathname + url.search);
        }
      } catch { /* skip invalid */ }
    }
    return [...new Set(hrefs)];
  }, seedOrigin);

  return links
    .filter((url) => {
      try { return scoreLink(url, new URL(url).pathname) >= 0; }
      catch { return false; }
    })
    .sort((a, b) => {
      try {
        return scoreLink(b, new URL(b).pathname) - scoreLink(a, new URL(a).pathname);
      } catch { return 0; }
    });
}

// ── Crawl ────────────────────────────────────────────────────────────────────

/**
 * Crawl a site starting from the current page.
 * The page should already be loaded with the seed URL and network listeners
 * should already be attached (they capture traffic from all navigations).
 */
export async function crawlSite(
  page: any,
  context: any,
  seedUrl: string,
  opts: CrawlOptions = {},
): Promise<CrawlResult> {
  const maxPages = opts.maxPages ?? 15;
  const maxTimeMs = opts.maxTimeMs ?? 60_000;
  const maxDepth = opts.maxDepth ?? 2;
  const startTime = Date.now();

  const seedOrigin = new URL(seedUrl).origin;
  const visited = new Set<string>([normalizeUrl(seedUrl)]);
  // BFS queue: [url, depth]
  const queue: Array<[string, number]> = [];

  // Extract links from the seed page (already loaded)
  const seedLinks = await extractLinks(page, seedOrigin);
  for (const link of seedLinks) {
    if (!visited.has(normalizeUrl(link))) {
      queue.push([link, 1]);
    }
  }

  let pagesCrawled = 0;

  while (queue.length > 0 && pagesCrawled < maxPages) {
    if (Date.now() - startTime > maxTimeMs) break;

    const [url, depth] = queue.shift()!;
    const normalized = normalizeUrl(url);
    if (visited.has(normalized)) continue;
    visited.add(normalized);

    try {
      await page.goto(url, { waitUntil: "networkidle", timeout: 15_000 });
    } catch {
      // Page might not load fully — still captured whatever API calls were made
      try { await page.waitForTimeout(2_000); } catch { /* page gone */ }
    }
    pagesCrawled++;

    // Wait for lazy-loaded API calls
    try { await page.waitForTimeout(1_500); } catch { /* page gone */ }

    // Extract more links if we haven't hit depth limit
    if (depth < maxDepth) {
      try {
        const newLinks = await extractLinks(page, seedOrigin);
        for (const link of newLinks) {
          if (!visited.has(normalizeUrl(link))) {
            queue.push([link, depth + 1]);
          }
        }
        // Re-sort by score (priority queue behavior)
        queue.sort((a, b) => {
          try {
            return scoreLink(b[0], new URL(b[0]).pathname) - scoreLink(a[0], new URL(a[0]).pathname);
          } catch { return 0; }
        });
      } catch { /* page context might be gone */ }
    }
  }

  // OpenAPI discovery
  let openApiSpec: OpenApiSpec | null = null;
  let openApiSource: string | null = null;

  if (opts.discoverOpenApi !== false) {
    const cookies = await extractCookiesFromContext(context);
    const capturedUrls = [...visited];
    const result = await discoverOpenApiSpec(seedOrigin, cookies, {}, capturedUrls);
    if (result) {
      openApiSpec = result.spec;
      openApiSource = result.source;
    }
  }

  return {
    visitedUrls: [...visited],
    pagesCrawled,
    crawlTimeMs: Date.now() - startTime,
    openApiSpec,
    openApiSource,
  };
}

// ── OpenAPI Discovery ────────────────────────────────────────────────────────

const OPENAPI_PROBE_PATHS = [
  "/swagger.json",
  "/openapi.json",
  "/api-docs",
  "/api/swagger",
  "/api/swagger.json",
  "/api/openapi.json",
  "/v1/api-docs",
  "/v2/api-docs",
  "/v3/api-docs",
  "/swagger/v1/swagger.json",
  "/api/v1/swagger.json",
  "/docs/openapi.json",
  "/.well-known/openapi.json",
];

async function fetchWithAuth(
  url: string,
  cookies: Record<string, string>,
  authHeaders: Record<string, string>,
): Promise<any | null> {
  const headers: Record<string, string> = {
    Accept: "application/json",
    ...authHeaders,
  };
  if (Object.keys(cookies).length > 0) {
    headers["Cookie"] = Object.entries(cookies).map(([k, v]) => `${k}=${v}`).join("; ");
  }

  const resp = await fetch(url, {
    headers,
    signal: AbortSignal.timeout(5_000),
  });

  if (!resp.ok) return null;

  const ct = resp.headers.get("content-type") ?? "";
  if (!ct.includes("json") && !ct.includes("yaml")) return null;

  return resp.json();
}

function parseOpenApiSpec(raw: any): OpenApiSpec | null {
  if (!raw || typeof raw !== "object") return null;

  const isSwagger2 = typeof raw.swagger === "string" && raw.swagger.startsWith("2.");
  const isOpenApi3 = typeof raw.openapi === "string" && raw.openapi.startsWith("3.");
  if (!isSwagger2 && !isOpenApi3) return null;

  const version = isSwagger2 ? raw.swagger : raw.openapi;
  const endpoints: OpenApiEndpoint[] = [];

  let baseUrl: string | undefined;
  if (isSwagger2 && raw.host) {
    const scheme = raw.schemes?.[0] ?? "https";
    const basePath = raw.basePath ?? "";
    baseUrl = `${scheme}://${raw.host}${basePath}`;
  } else if (isOpenApi3 && raw.servers?.[0]?.url) {
    baseUrl = raw.servers[0].url;
  }

  const paths = raw.paths ?? {};
  const validMethods = new Set(["get", "post", "put", "delete", "patch", "head", "options"]);

  for (const [path, methods] of Object.entries(paths)) {
    if (typeof methods !== "object" || methods === null) continue;
    for (const [method, operation] of Object.entries(methods as Record<string, any>)) {
      if (!validMethods.has(method)) continue;
      endpoints.push({
        method: method.toUpperCase(),
        path,
        summary: operation?.summary,
        operationId: operation?.operationId,
      });
    }
  }

  if (endpoints.length === 0) return null;

  return { raw, endpoints, version, baseUrl };
}

export async function discoverOpenApiSpec(
  baseUrl: string,
  cookies: Record<string, string>,
  authHeaders: Record<string, string>,
  capturedUrls?: string[],
): Promise<{ spec: OpenApiSpec; source: string } | null> {
  // 1. Check captured URLs for OpenAPI patterns (free — already fetched)
  if (capturedUrls) {
    for (const url of capturedUrls) {
      if (/swagger|openapi|api-docs/i.test(url)) {
        try {
          const data = await fetchWithAuth(url, cookies, authHeaders);
          if (data) {
            const spec = parseOpenApiSpec(data);
            if (spec) return { spec, source: `captured: ${url}` };
          }
        } catch { /* continue */ }
      }
    }
  }

  // 2. Probe common spec paths
  for (const path of OPENAPI_PROBE_PATHS) {
    const url = `${baseUrl}${path}`;
    try {
      const data = await fetchWithAuth(url, cookies, authHeaders);
      if (data) {
        const spec = parseOpenApiSpec(data);
        if (spec) return { spec, source: `probed: ${path}` };
      }
    } catch { /* continue */ }
  }

  return null;
}

async function extractCookiesFromContext(context: any): Promise<Record<string, string>> {
  try {
    const browserCookies = await context.cookies();
    const cookies: Record<string, string> = {};
    for (const c of browserCookies) cookies[c.name] = c.value;
    return cookies;
  } catch {
    return {};
  }
}
