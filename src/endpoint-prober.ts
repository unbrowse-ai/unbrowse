/**
 * Endpoint Prober — Smart endpoint discovery engine.
 *
 * Given known endpoints and captured auth, generates intelligent probes
 * to discover undocumented endpoints, validates them, and returns newly
 * discovered ones with response schemas.
 */

import type { EndpointGroup } from "./types.js";
import { safeParseJson, inferSchema, getTopLevelSchema } from "./schema-inferrer.js";

// ── Types ────────────────────────────────────────────────────────────────

export interface ProbeResult {
  method: string;
  path: string;
  url: string;
  status: number;
  ok: boolean;
  /** Whether this looks like a real endpoint with meaningful data */
  discovered: boolean;
  /** Response shape summary */
  responseSummary: string;
  /** Response body schema */
  responseSchema: Record<string, string> | null;
  /** Why we probed this */
  reason: string;
  /** How long the request took */
  latencyMs: number;
}

export interface ProbeConfig {
  /** Base URL of the API */
  baseUrl: string;
  /** Auth headers to include */
  authHeaders: Record<string, string>;
  /** Cookies to include */
  cookies: Record<string, string>;
  /** Maximum number of probes to run */
  maxProbes?: number;
  /** Request timeout in ms */
  timeoutMs?: number;
  /** Concurrency */
  concurrency?: number;
  /** Also probe for OpenAPI/Swagger docs */
  probeForDocs?: boolean;
  /** Aggressive mode: try more speculative paths */
  aggressive?: boolean;
}

interface RawProbe {
  method: string;
  path: string;
  reason: string;
}

// ── Constants ────────────────────────────────────────────────────────────

const DEFAULT_MAX_PROBES = 50;
const DEFAULT_TIMEOUT_MS = 5000;
const DEFAULT_CONCURRENCY = 3;

const ALL_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE"] as const;

const SUB_RESOURCES = [
  "comments", "likes", "tags", "attachments", "history",
  "activity", "settings", "permissions", "members", "stats",
  "status", "metadata",
];

const COLLECTION_OPERATIONS = [
  { suffix: "search", methods: ["GET", "POST"] },
  { suffix: "count", methods: ["GET"] },
  { suffix: "export", methods: ["GET"] },
  { suffix: "bulk", methods: ["POST"] },
  { suffix: "batch", methods: ["POST"] },
];

const USER_ACCOUNT_PATHS = [
  "/me", "/user/me", "/api/me", "/profile", "/account",
  "/user/profile", "/api/user", "/users/current", "/auth/me", "/whoami",
];

const DOC_PATHS = [
  "/openapi.json", "/openapi.yaml",
  "/swagger.json", "/swagger.yaml",
  "/api-docs", "/api-docs.json",
  "/api/docs", "/docs/api",
  "/.well-known/openapi",
];

const UTILITY_PATHS = [
  "/health", "/healthz", "/health-check", "/status", "/ping",
  "/version", "/info", "/config",
  "/.well-known/security.txt", "/robots.txt", "/sitemap.xml",
];

const GRAPHQL_INTROSPECTION_QUERY = JSON.stringify({
  query: `{ __schema { types { name } } }`,
});

// ── Helpers ──────────────────────────────────────────────────────────────

/** Strip trailing slash from a URL. */
function stripTrailingSlash(url: string): string {
  return url.endsWith("/") ? url.slice(0, -1) : url;
}

/** Extract the base resource path from a normalized path (e.g., /api/v1/users/{userId} → /api/v1/users). */
function getResourceBase(normalizedPath: string): string {
  const segments = normalizedPath.split("/");
  // Walk backwards, drop trailing params
  while (segments.length > 1 && segments[segments.length - 1].startsWith("{")) {
    segments.pop();
  }
  return segments.join("/") || "/";
}

/** Get the last resource name from a normalized path (e.g., /api/v1/users/{userId} → "users"). */
function getResourceName(normalizedPath: string): string | null {
  const segments = normalizedPath.split("/").filter(Boolean);
  for (let i = segments.length - 1; i >= 0; i--) {
    if (!segments[i].startsWith("{") && !/^(api|v\d+)$/i.test(segments[i])) {
      return segments[i];
    }
  }
  return null;
}

/** Check if the normalized path ends with a parameter (i.e., targets a single resource). */
function endsWithParam(normalizedPath: string): boolean {
  const segments = normalizedPath.split("/").filter(Boolean);
  return segments.length > 0 && segments[segments.length - 1].startsWith("{");
}

/** Extract the API prefix (e.g., /api/v1) from a normalized path. */
function getApiPrefix(normalizedPath: string): string {
  const segments = normalizedPath.split("/").filter(Boolean);
  const prefixParts: string[] = [];
  for (const seg of segments) {
    if (/^(api|v\d+)$/i.test(seg)) {
      prefixParts.push(seg);
    } else {
      break;
    }
  }
  return prefixParts.length > 0 ? "/" + prefixParts.join("/") : "";
}

/** Find an example value for a path parameter from known endpoint groups. */
function findExampleId(groups: EndpointGroup[]): string | null {
  for (const g of groups) {
    for (const pp of g.pathParams) {
      if (pp.example) return pp.example;
    }
  }
  return null;
}

/** Replace {param} placeholders with an example ID. */
function fillParams(path: string, exampleId: string): string {
  return path.replace(/\{[^}]+\}/g, exampleId);
}

/** Build a set of known endpoint keys for dedup: "METHOD /normalized/path" */
function buildKnownSet(groups: EndpointGroup[]): Set<string> {
  const known = new Set<string>();
  for (const g of groups) {
    known.add(`${g.method.toUpperCase()} ${g.normalizedPath}`);
  }
  return known;
}

// ── Probe generation strategies ──────────────────────────────────────────

function generateCrudProbes(groups: EndpointGroup[], known: Set<string>): RawProbe[] {
  const probes: RawProbe[] = [];
  const seenResources = new Map<string, Set<string>>(); // resourceBase → set of methods

  for (const g of groups) {
    const base = getResourceBase(g.normalizedPath);
    const methods = seenResources.get(base) || new Set<string>();
    methods.add(g.method.toUpperCase());
    seenResources.set(base, methods);
  }

  for (const [base, methods] of seenResources) {
    const resource = getResourceName(base) || "resource";
    const withId = base.endsWith("/") ? base + `{${resource}Id}` : base + `/{${resource}Id}`;

    for (const m of ALL_METHODS) {
      // Collection endpoints (no ID)
      if (!methods.has(m) && !known.has(`${m} ${base}`)) {
        if (m === "GET" || m === "POST") {
          probes.push({ method: m, path: base, reason: `CRUD completion: ${m} ${base} (${resource})` });
        }
      }
      // Single-resource endpoints (with ID)
      if (!methods.has(m) && !known.has(`${m} ${withId}`)) {
        if (m === "GET" || m === "PUT" || m === "PATCH" || m === "DELETE") {
          probes.push({ method: m, path: withId, reason: `CRUD completion: ${m} ${withId} (${resource})` });
        }
      }
    }
  }

  return probes;
}

function generateSubResourceProbes(groups: EndpointGroup[], known: Set<string>): RawProbe[] {
  const probes: RawProbe[] = [];

  // Find endpoints with {id} params — these are candidates for sub-resources
  const parentPaths = new Set<string>();
  for (const g of groups) {
    if (endsWithParam(g.normalizedPath)) {
      parentPaths.add(g.normalizedPath);
    }
  }

  // Check if any sub-resource endpoints already exist under each parent
  for (const parentPath of parentPaths) {
    const hasSubResources = groups.some(
      (g) => g.normalizedPath.startsWith(parentPath + "/") && g.normalizedPath !== parentPath,
    );
    if (hasSubResources) continue;

    for (const sub of SUB_RESOURCES) {
      const subPath = `${parentPath}/${sub}`;
      if (!known.has(`GET ${subPath}`)) {
        probes.push({ method: "GET", path: subPath, reason: `Sub-resource probe: ${sub}` });
      }
    }
  }

  return probes;
}

function generateCollectionProbes(groups: EndpointGroup[], known: Set<string>): RawProbe[] {
  const probes: RawProbe[] = [];

  for (const g of groups) {
    if (g.method.toUpperCase() !== "GET") continue;
    if (endsWithParam(g.normalizedPath)) continue;

    const base = g.normalizedPath;
    for (const op of COLLECTION_OPERATIONS) {
      for (const m of op.methods) {
        const opPath = `${base}/${op.suffix}`;
        if (!known.has(`${m} ${opPath}`)) {
          probes.push({ method: m, path: opPath, reason: `Collection operation: ${op.suffix}` });
        }
      }
    }
  }

  return probes;
}

function generateUserAccountProbes(
  _groups: EndpointGroup[],
  known: Set<string>,
  prefix: string,
): RawProbe[] {
  const probes: RawProbe[] = [];

  for (const p of USER_ACCOUNT_PATHS) {
    const path = prefix + p;
    if (!known.has(`GET ${path}`)) {
      probes.push({ method: "GET", path, reason: "User/account discovery" });
    }
  }

  return probes;
}

function generateDocProbes(known: Set<string>, prefix: string): RawProbe[] {
  const probes: RawProbe[] = [];

  for (const p of DOC_PATHS) {
    const path = prefix ? prefix + p : p;
    if (!known.has(`GET ${path}`)) {
      probes.push({ method: "GET", path, reason: "API documentation discovery" });
    }
    // Also try without prefix
    if (prefix && !known.has(`GET ${p}`)) {
      probes.push({ method: "GET", path: p, reason: "API documentation discovery (root)" });
    }
  }

  // GraphQL introspection
  const graphqlPaths = ["/graphql", prefix + "/graphql"];
  for (const gp of graphqlPaths) {
    if (!known.has(`POST ${gp}`)) {
      probes.push({ method: "POST", path: gp, reason: "GraphQL introspection" });
    }
  }

  return probes;
}

function generateVersionProbes(groups: EndpointGroup[], known: Set<string>): RawProbe[] {
  const probes: RawProbe[] = [];

  for (const g of groups) {
    const segments = g.normalizedPath.split("/").filter(Boolean);
    const versionIdx = segments.findIndex((s) => /^v\d+$/i.test(s));
    if (versionIdx === -1) continue;

    const currentVersion = parseInt(segments[versionIdx].slice(1), 10);
    const versionsToTry = [currentVersion + 1, currentVersion - 1, currentVersion + 2].filter(
      (v) => v > 0 && v !== currentVersion,
    );

    for (const v of versionsToTry) {
      const newSegments = [...segments];
      newSegments[versionIdx] = `v${v}`;
      const newPath = "/" + newSegments.join("/");
      if (!known.has(`${g.method} ${newPath}`)) {
        probes.push({
          method: g.method,
          path: newPath,
          reason: `Version variant: v${currentVersion} → v${v}`,
        });
      }
    }
  }

  // Also: if /api/users exists without version, try /api/v1/users, /api/v2/users
  for (const g of groups) {
    const segments = g.normalizedPath.split("/").filter(Boolean);
    if (segments[0]?.toLowerCase() === "api" && !/^v\d+$/i.test(segments[1] || "")) {
      for (const v of [1, 2]) {
        const newSegments = [segments[0], `v${v}`, ...segments.slice(1)];
        const newPath = "/" + newSegments.join("/");
        if (!known.has(`${g.method} ${newPath}`)) {
          probes.push({
            method: g.method,
            path: newPath,
            reason: `Version injection: /api → /api/v${v}`,
          });
        }
      }
    }
  }

  return probes;
}

function generateUtilityProbes(known: Set<string>, prefix: string): RawProbe[] {
  const probes: RawProbe[] = [];

  for (const p of UTILITY_PATHS) {
    const path = prefix ? prefix + p : p;
    if (!known.has(`GET ${path}`)) {
      probes.push({ method: "GET", path, reason: "Utility endpoint probe" });
    }
    // Also try at root
    if (prefix && !known.has(`GET ${p}`)) {
      probes.push({ method: "GET", path: p, reason: "Utility endpoint probe (root)" });
    }
  }

  return probes;
}

// ── Main exports ─────────────────────────────────────────────────────────

/**
 * Generate probe requests based on known endpoints.
 * Does not execute any HTTP requests — just produces the list of things to try.
 */
export function generateProbes(
  endpointGroups: EndpointGroup[],
  config: ProbeConfig,
): { method: string; path: string; reason: string }[] {
  const known = buildKnownSet(endpointGroups);
  const maxProbes = config.maxProbes ?? DEFAULT_MAX_PROBES;
  const aggressive = config.aggressive ?? false;
  const probeForDocs = config.probeForDocs ?? true;

  // Determine common API prefix from known endpoints
  const prefixes = endpointGroups.map((g) => getApiPrefix(g.normalizedPath)).filter(Boolean);
  const prefix = mostCommon(prefixes) || "";

  const allProbes: RawProbe[] = [];

  // 1. CRUD completion (highest priority)
  allProbes.push(...generateCrudProbes(endpointGroups, known));

  // 2. Sub-resource probes
  allProbes.push(...generateSubResourceProbes(endpointGroups, known));

  // 3. Collection operations
  allProbes.push(...generateCollectionProbes(endpointGroups, known));

  // 4. User/account probes (if auth is present)
  const hasAuth =
    Object.keys(config.authHeaders).length > 0 ||
    Object.keys(config.cookies).length > 0;
  if (hasAuth) {
    allProbes.push(...generateUserAccountProbes(endpointGroups, known, prefix));
  }

  // 5. API docs probes
  if (probeForDocs) {
    allProbes.push(...generateDocProbes(known, prefix));
  }

  // 6. Version variants (aggressive only)
  if (aggressive) {
    allProbes.push(...generateVersionProbes(endpointGroups, known));
  }

  // 7. Utility probes (aggressive only)
  if (aggressive) {
    allProbes.push(...generateUtilityProbes(known, prefix));
  }

  // Deduplicate probes by method+path
  const seen = new Set<string>();
  const deduped: RawProbe[] = [];
  for (const probe of allProbes) {
    const key = `${probe.method} ${probe.path}`;
    if (!seen.has(key)) {
      seen.add(key);
      deduped.push(probe);
    }
  }

  return deduped.slice(0, maxProbes);
}

/**
 * Execute probes and return results.
 *
 * Sends HTTP requests for each generated probe, with concurrency limiting,
 * timeouts, and auth injection. Determines which probes discovered real
 * endpoints based on response status and content.
 */
export async function probeEndpoints(
  endpointGroups: EndpointGroup[],
  config: ProbeConfig,
): Promise<ProbeResult[]> {
  const probes = generateProbes(endpointGroups, config);
  if (probes.length === 0) return [];

  const baseUrl = stripTrailingSlash(config.baseUrl);
  const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const concurrency = config.concurrency ?? DEFAULT_CONCURRENCY;

  // Find an example ID to fill in path params
  const exampleId = findExampleId(endpointGroups) || "1";

  // Build cookie header from cookies map
  const cookieHeader = Object.entries(config.cookies)
    .map(([k, v]) => `${k}=${v}`)
    .join("; ");

  const results: ProbeResult[] = [];

  // Process probes with concurrency limiting
  let idx = 0;
  while (idx < probes.length) {
    const batch = probes.slice(idx, idx + concurrency);
    const batchResults = await Promise.allSettled(
      batch.map((probe) => executeProbe(probe, baseUrl, exampleId, config.authHeaders, cookieHeader, timeoutMs)),
    );

    for (const result of batchResults) {
      if (result.status === "fulfilled") {
        results.push(result.value);
      }
      // Rejected probes (network errors, etc.) are silently dropped
    }

    idx += concurrency;
  }

  return results;
}

// ── Probe execution ──────────────────────────────────────────────────────

async function executeProbe(
  probe: RawProbe,
  baseUrl: string,
  exampleId: string,
  authHeaders: Record<string, string>,
  cookieHeader: string,
  timeoutMs: number,
): Promise<ProbeResult> {
  const filledPath = fillParams(probe.path, exampleId);
  const url = baseUrl + filledPath;
  const start = Date.now();

  const headers: Record<string, string> = {
    Accept: "application/json",
    ...authHeaders,
  };
  if (cookieHeader) {
    headers["Cookie"] = cookieHeader;
  }

  const isGraphQL = probe.reason === "GraphQL introspection";
  const isPost = probe.method === "POST";

  const fetchOptions: RequestInit = {
    method: probe.method,
    headers,
    redirect: "follow" as RequestRedirect,
    signal: AbortSignal.timeout(timeoutMs),
  };

  if (isPost) {
    headers["Content-Type"] = "application/json";
    fetchOptions.body = isGraphQL ? GRAPHQL_INTROSPECTION_QUERY : "{}";
  }

  let status: number;
  let responseText: string;

  try {
    const resp = await fetch(url, fetchOptions);
    status = resp.status;
    responseText = await resp.text();
  } catch {
    // Network error, timeout, etc.
    return {
      method: probe.method,
      path: probe.path,
      url,
      status: 0,
      ok: false,
      discovered: false,
      responseSummary: "error",
      responseSchema: null,
      reason: probe.reason,
      latencyMs: Date.now() - start,
    };
  }

  const latencyMs = Date.now() - start;
  const ok = status >= 200 && status < 300;

  // Determine if this is a real discovery
  const discovered = evaluateDiscovery(status, responseText);

  // Infer schema for discovered endpoints
  let responseSummary = "";
  let responseSchema: Record<string, string> | null = null;

  if (discovered) {
    const parsed = safeParseJson(responseText);
    if (parsed !== null) {
      const schema = inferSchema(parsed);
      responseSummary = schema.summary;
      responseSchema = getTopLevelSchema(parsed);
    } else {
      responseSummary = `text(${responseText.length} bytes)`;
    }
  } else {
    responseSummary = ok ? "empty/trivial" : `${status}`;
  }

  return {
    method: probe.method,
    path: probe.path,
    url,
    status,
    ok,
    discovered,
    responseSummary,
    responseSchema,
    reason: probe.reason,
    latencyMs,
  };
}

/**
 * Evaluate whether a probe response represents a real discovered endpoint.
 *
 * A probe is "discovered" if:
 * - Status is 2xx with a non-empty JSON body
 * - OR status is 2xx with meaningful content (not just "ok")
 * - NOT if status is 404, 405, 401
 * - NOT if response is HTML (likely a catch-all page)
 */
function evaluateDiscovery(status: number, body: string): boolean {
  // Non-success statuses are not discoveries
  if (status < 200 || status >= 300) return false;

  // Empty body is not a discovery
  if (!body || body.trim().length === 0) return false;

  const trimmed = body.trim();

  // HTML responses are likely SPA catch-all pages, not real API endpoints
  if (
    trimmed.startsWith("<!") ||
    trimmed.startsWith("<html") ||
    trimmed.startsWith("<HTML") ||
    trimmed.startsWith("<?xml")
  ) {
    return false;
  }

  // Trivial responses that don't indicate a real endpoint
  const trivial = new Set(["ok", "OK", "\"ok\"", "\"OK\"", "true", "null", "{}", "[]"]);
  if (trivial.has(trimmed)) return false;

  // JSON responses with actual content are discoveries
  const parsed = safeParseJson(trimmed);
  if (parsed !== null) {
    // Check for empty objects/arrays
    if (typeof parsed === "object" && parsed !== null) {
      if (Array.isArray(parsed) && parsed.length === 0) return false;
      if (!Array.isArray(parsed) && Object.keys(parsed).length === 0) return false;
    }
    return true;
  }

  // Non-JSON text that's substantial enough could be a discovery (e.g., YAML docs)
  return trimmed.length > 20;
}

// ── Utilities ────────────────────────────────────────────────────────────

/** Find the most common string in an array. */
function mostCommon(arr: string[]): string | null {
  if (arr.length === 0) return null;
  const counts = new Map<string, number>();
  for (const item of arr) {
    counts.set(item, (counts.get(item) || 0) + 1);
  }
  let best = arr[0];
  let bestCount = 0;
  for (const [item, count] of counts) {
    if (count > bestCount) {
      best = item;
      bestCount = count;
    }
  }
  return best;
}
