/**
 * Endpoint Analyzer — Categorize, describe, and detect dependencies between endpoints.
 *
 * Groups raw parsed requests into logical endpoints, enriches them with
 * descriptions, categories, and producer/consumer dependency info, then
 * sorts them in dependency order for skill generation.
 */

import type { EndpointGroup, ParsedRequest } from "./types.js";
import { mergeSchemas, getTopLevelSchema } from "./schema-inferrer.js";

// ── Auth detection ──────────────────────────────────────────────────────

export const AUTH_PATH_PATTERNS = [
  /\/login\b/i,
  /\/signin\b/i,
  /\/sign-in\b/i,
  /\/auth\b/i,
  /\/token\b/i,
  /\/oauth\b/i,
  /\/register\b/i,
  /\/signup\b/i,
  /\/sign-up\b/i,
  /\/session\b/i,
  /\/refresh\b/i,
];

export function isAuthEndpoint(path: string): boolean {
  return AUTH_PATH_PATTERNS.some((p) => p.test(path));
}

// ── Categorization ──────────────────────────────────────────────────────

function categorize(
  method: string,
  normalizedPath: string,
): EndpointGroup["category"] {
  if (isAuthEndpoint(normalizedPath)) return "auth";
  const m = method.toUpperCase();
  if (m === "GET" || m === "HEAD" || m === "OPTIONS") return "read";
  if (m === "DELETE") return "delete";
  if (m === "POST" || m === "PUT" || m === "PATCH") return "write";
  return "other";
}

// ── Description generation ──────────────────────────────────────────────

/** Singularize a simple English noun (best-effort). */
function singularize(word: string): string {
  if (word.endsWith("ies")) return word.slice(0, -3) + "y";
  if (word.endsWith("ses") || word.endsWith("xes") || word.endsWith("zes"))
    return word.slice(0, -2);
  if (word.endsWith("s") && !word.endsWith("ss")) return word.slice(0, -1);
  return word;
}

/** Convert a slug or camelCase segment into a human-readable word. */
function humanize(segment: string): string {
  return segment
    .replace(/[-_]/g, " ")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .toLowerCase();
}

/**
 * Generate a concise description of an endpoint from its method and path.
 *
 * Examples:
 *   GET  /users              → "List users"
 *   GET  /users/{userId}     → "Get a user by ID"
 *   POST /users              → "Create a user"
 *   PUT  /users/{userId}     → "Update a user"
 *   DELETE /users/{userId}   → "Delete a user"
 *   GET  /users/{userId}/orders → "List orders for a user"
 *   POST /users/{userId}/orders → "Create an order for a user"
 */
function generateDescription(method: string, normalizedPath: string): string {
  const m = method.toUpperCase();

  // Special-case auth endpoints
  if (isAuthEndpoint(normalizedPath)) {
    const lower = normalizedPath.toLowerCase();
    if (lower.includes("refresh")) return "Refresh auth token";
    if (lower.includes("register") || lower.includes("signup") || lower.includes("sign-up"))
      return "Register a new account";
    if (lower.includes("logout") || lower.includes("sign-out") || lower.includes("signout"))
      return "Log out";
    return "Authenticate";
  }

  // Strip leading path noise: /api/v1/v2/... → meaningful segments
  const segments = normalizedPath
    .split("/")
    .filter(Boolean)
    .filter((s) => !/^(api|v\d+)$/i.test(s));

  if (segments.length === 0) {
    return `${m} root`;
  }

  // Walk from the end to find the last resource (non-param) and whether
  // it's followed by a param.
  const lastSegment = segments[segments.length - 1];
  const endsWithParam = lastSegment.startsWith("{");

  // Find the last non-param resource name
  let resourceIndex = -1;
  for (let i = segments.length - 1; i >= 0; i--) {
    if (!segments[i].startsWith("{")) {
      resourceIndex = i;
      break;
    }
  }

  if (resourceIndex === -1) {
    return `${m} endpoint`;
  }

  const resource = humanize(segments[resourceIndex]);

  // Build the "for a <parent>" suffix by walking backwards to find the
  // parent resource (a non-param segment before a param segment).
  let parentPhrase = "";
  for (let i = resourceIndex - 1; i >= 0; i--) {
    if (segments[i].startsWith("{")) continue;
    // Found a parent resource — check if the next segment is a param
    if (i + 1 < segments.length && segments[i + 1].startsWith("{")) {
      parentPhrase = ` for a ${singularize(humanize(segments[i]))}`;
      break;
    }
  }

  // Determine verb
  if (endsWithParam) {
    // Endpoint targets a specific resource: GET /users/{userId}
    const singular = singularize(resource);
    switch (m) {
      case "GET":
        return `Get a ${singular} by ID${parentPhrase}`;
      case "POST":
        return `Create or update a ${singular}${parentPhrase}`;
      case "PUT":
        return `Update a ${singular}${parentPhrase}`;
      case "PATCH":
        return `Partially update a ${singular}${parentPhrase}`;
      case "DELETE":
        return `Delete a ${singular}${parentPhrase}`;
      default:
        return `${m} a ${singular}${parentPhrase}`;
    }
  } else {
    // Endpoint targets a collection: GET /users, POST /users
    switch (m) {
      case "GET":
        return `List ${resource}${parentPhrase}`;
      case "POST":
        return `Create a ${singularize(resource)}${parentPhrase}`;
      case "PUT":
        return `Replace ${resource}${parentPhrase}`;
      case "PATCH":
        return `Update ${resource}${parentPhrase}`;
      case "DELETE":
        return `Delete ${resource}${parentPhrase}`;
      default:
        return `${m} ${resource}${parentPhrase}`;
    }
  }
}

// ── Producer / Consumer detection ───────────────────────────────────────

/** Field names that signal a produced identifier in a response body. */
const PRODUCER_FIELD_PATTERNS = [
  /^id$/i,
  /Id$/,
  /token$/i,
  /key$/i,
  /uuid$/i,
  /^access.?token$/i,
  /^refresh.?token$/i,
  /^session.?id$/i,
  /^auth.?token$/i,
];

/**
 * Scan a response body (top-level schema) for fields that look like
 * produced identifiers (IDs, tokens, keys).
 */
function detectProducedFields(responseSchema: Record<string, string> | null): string[] {
  if (!responseSchema) return [];
  const produced: string[] = [];
  for (const field of Object.keys(responseSchema)) {
    if (PRODUCER_FIELD_PATTERNS.some((p) => p.test(field))) {
      produced.push(field);
    }
  }
  return produced;
}

/**
 * Scan path params, query params, and request body for ID-like values
 * that this endpoint consumes.
 */
function detectConsumedFields(
  pathParams: EndpointGroup["pathParams"],
  queryParams: EndpointGroup["queryParams"],
  requestBodySchema: Record<string, string> | null | undefined,
): string[] {
  const consumed: string[] = [];

  // Path params are always consumed
  for (const p of pathParams) {
    consumed.push(p.name);
  }

  // Query params that look like IDs
  for (const q of queryParams) {
    if (PRODUCER_FIELD_PATTERNS.some((p) => p.test(q.name))) {
      consumed.push(q.name);
    }
  }

  // Request body fields that look like IDs
  if (requestBodySchema) {
    for (const field of Object.keys(requestBodySchema)) {
      if (PRODUCER_FIELD_PATTERNS.some((p) => p.test(field))) {
        consumed.push(field);
      }
    }
  }

  return Array.from(new Set(consumed));
}

// ── Dependency graph ────────────────────────────────────────────────────

/**
 * Build dependency list for an endpoint group.
 * Auth endpoints depend on nothing. Other endpoints may depend on auth
 * and on endpoints that produce the IDs they consume.
 */
function buildDependencies(
  group: Pick<EndpointGroup, "category" | "consumes" | "normalizedPath">,
  allGroups: Pick<EndpointGroup, "category" | "produces" | "normalizedPath" | "method">[],
): string[] {
  if (group.category === "auth") return [];

  const deps: Set<string> = new Set();

  // All non-auth endpoints implicitly depend on auth endpoints
  for (const g of allGroups) {
    if (g.category === "auth") {
      deps.add(`${g.method} ${g.normalizedPath}`);
    }
  }

  // Find producers for each consumed field
  for (const consumed of group.consumes) {
    for (const g of allGroups) {
      if (g.normalizedPath === group.normalizedPath) continue;
      if (g.produces.some((p) => p === consumed || consumed.toLowerCase().includes(p.toLowerCase()))) {
        deps.add(`${g.method} ${g.normalizedPath}`);
      }
    }
  }

  return Array.from(deps);
}

/** Pick the most common HTTP method from a set of requests. */
function mostCommonMethod(reqs: ParsedRequest[]): string {
  const counts = new Map<string, number>();
  for (const req of reqs) {
    counts.set(req.method, (counts.get(req.method) || 0) + 1);
  }
  let best = "GET";
  let bestCount = 0;
  for (const [method, count] of counts) {
    if (count > bestCount) { best = method; bestCount = count; }
  }
  return best;
}

// ── Main export ─────────────────────────────────────────────────────────

/**
 * Analyze parsed requests into categorized, described endpoint groups
 * with dependency information.
 *
 * @param requests - All parsed requests from HAR/CDP capture
 * @param endpoints - Requests already grouped by normalized path key
 * @returns Sorted array of endpoint groups (auth first, then by dependency count)
 */
export function analyzeEndpoints(
  requests: ParsedRequest[],
  endpoints: Record<string, ParsedRequest[]>,
): EndpointGroup[] {
  // ── 1. Group by METHOD + normalizedPath ───────────────────────────────
  // GraphQL persisted queries collapse across methods (GET and POST share one endpoint)
  const grouped = new Map<string, ParsedRequest[]>();

  for (const req of requests) {
    const normPath = req.normalizedPath || req.path;
    // GraphQL operations group by path only (not method) since GET/POST are interchangeable
    const key = req.graphqlOperation
      ? `GRAPHQL ${normPath}`
      : `${req.method.toUpperCase()} ${normPath}`;
    const existing = grouped.get(key);
    if (existing) {
      existing.push(req);
    } else {
      grouped.set(key, [req]);
    }
  }

  // ── 2. Build EndpointGroup for each group ─────────────────────────────
  const groups: EndpointGroup[] = [];

  for (const [key, reqs] of Array.from(grouped.entries())) {
    const [rawMethod, ...pathParts] = key.split(" ");
    const normalizedPath = pathParts.join(" "); // rejoin in case path has spaces (unlikely)
    // For GraphQL groups, pick the most common method from the requests
    const method = rawMethod === "GRAPHQL"
      ? mostCommonMethod(reqs)
      : rawMethod;

    // Path params: merge from all request examples
    const pathParamMap = new Map<string, { type: string; example: string }>();
    for (const req of reqs) {
      if (req.pathParams) {
        for (const pp of req.pathParams) {
          if (!pathParamMap.has(pp.name)) {
            pathParamMap.set(pp.name, { type: pp.type, example: pp.exampleValue });
          }
        }
      }
    }
    const pathParams = Array.from(pathParamMap.entries()).map(([name, info]) => ({
      name,
      type: info.type,
      example: info.example,
    }));

    // Query params: collect all, mark required if >80% of requests have it
    const queryParamCounts = new Map<string, { count: number; example: string }>();
    for (const req of reqs) {
      if (req.queryParams) {
        for (const qp of req.queryParams) {
          const existing = queryParamCounts.get(qp.name);
          if (existing) {
            existing.count++;
          } else {
            queryParamCounts.set(qp.name, { count: 1, example: qp.value });
          }
        }
      }
    }
    const threshold = reqs.length * 0.8;
    const queryParams = Array.from(queryParamCounts.entries()).map(([name, info]) => ({
      name,
      example: info.example,
      required: info.count >= threshold,
    }));

    // Request body schema: merge from all examples
    const requestSchemas: Record<string, string>[] = [];
    for (const req of reqs) {
      if (req.requestBody) {
        const schema = getTopLevelSchema(req.requestBody);
        if (schema) requestSchemas.push(schema);
      }
    }
    const requestBodySchema =
      requestSchemas.length > 0 ? mergeSchemas(requestSchemas) : undefined;

    // Response body schema: merge from all examples
    const responseSchemas: Record<string, string>[] = [];
    for (const req of reqs) {
      if (req.responseBody) {
        const schema = getTopLevelSchema(req.responseBody);
        if (schema) responseSchemas.push(schema);
      }
    }
    const responseBodySchema =
      responseSchemas.length > 0 ? mergeSchemas(responseSchemas) : undefined;

    // Response summary: use first available
    const responseSummary =
      reqs.find((r) => r.responseSummary)?.responseSummary || "";

    // Verified / fromSpec flags
    const verified = reqs.some((r) => r.verified);
    const fromSpec = reqs.some((r) => r.fromSpec);

    const category = categorize(method, normalizedPath);
    const description = generateDescription(method, normalizedPath);
    const produces = detectProducedFields(responseBodySchema ?? null);
    const consumes = detectConsumedFields(
      pathParams,
      queryParams,
      requestBodySchema,
    );

    // Collect GraphQL operations if this group contains persisted queries
    const gqlOps = new Map<string, { method: string; hash?: string }>();
    for (const req of reqs) {
      if (req.graphqlOperation) {
        const op = req.graphqlOperation;
        if (!gqlOps.has(op.operationName)) {
          gqlOps.set(op.operationName, { method: req.method, hash: op.queryHash });
        }
      }
    }
    const graphqlOperations = gqlOps.size > 0
      ? Array.from(gqlOps.entries()).map(([name, info]) => ({
          name, method: info.method, hash: info.hash,
        }))
      : undefined;

    // Override description for GraphQL endpoints
    const gqlDescription = graphqlOperations
      ? `GraphQL API (${graphqlOperations.length} operations)`
      : undefined;

    const group: EndpointGroup = {
      method,
      normalizedPath,
      description: gqlDescription || description,
      category,
      pathParams,
      queryParams,
      requestBodySchema,
      responseBodySchema,
      responseSummary,
      exampleCount: reqs.length,
      verified: verified || undefined,
      fromSpec: fromSpec || undefined,
      dependencies: [], // filled in pass 2
      produces,
      consumes,
      graphqlOperations,
    };

    groups.push(group);
  }

  // ── 3. Build dependency graph (second pass) ───────────────────────────
  for (const group of groups) {
    group.dependencies = buildDependencies(group, groups);
  }

  // ── 4. Sort: auth first, then by dependency count (fewer deps first) ──
  groups.sort((a, b) => {
    // Auth always first
    if (a.category === "auth" && b.category !== "auth") return -1;
    if (a.category !== "auth" && b.category === "auth") return 1;

    // Then by number of dependencies (producers before consumers)
    if (a.dependencies.length !== b.dependencies.length) {
      return a.dependencies.length - b.dependencies.length;
    }

    // Tie-break: reads before writes before deletes
    const categoryOrder: Record<string, number> = {
      auth: 0,
      read: 1,
      write: 2,
      delete: 3,
      other: 4,
    };
    const catDiff =
      (categoryOrder[a.category] ?? 4) - (categoryOrder[b.category] ?? 4);
    if (catDiff !== 0) return catDiff;

    // Final tie-break: alphabetical by path
    return a.normalizedPath.localeCompare(b.normalizedPath);
  });

  return groups;
}
