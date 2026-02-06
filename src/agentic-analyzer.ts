/**
 * Agentic Analyzer — Deep API intelligence extraction for AI agents.
 *
 * Goes far beyond the structured endpoint-analyzer pipeline to extract
 * domain entities, auth flows, pagination patterns, error conventions,
 * rate limits, data flows, and endpoint suggestions from captured traffic.
 *
 * The output is designed to give an AI agent everything it needs to
 * autonomously interact with an API: what entities exist, how to
 * authenticate, how data flows between endpoints, and what to explore next.
 */

import type { ApiData, HarEntry, EndpointGroup, ParsedRequest } from "./types.js";
import { safeParseJson, getTopLevelSchema } from "./schema-inferrer.js";

// ── Focus Mode & Options ─────────────────────────────────────────────────

export type FocusArea = "entities" | "auth" | "dataflow" | "gaps" | "pagination" | "errors";

export interface AnalysisOptions {
  /** Focus on a specific area for deeper analysis */
  focus?: FocusArea;
}

// ── Interfaces ───────────────────────────────────────────────────────────

export interface EntityField {
  name: string;
  type: string;
  /** Seen in which endpoints' responses */
  seenIn: string[];
  nullable: boolean;
  /** Likely an ID/foreign key */
  isId: boolean;
}

export interface Entity {
  name: string;
  fields: EntityField[];
  /** Endpoints that return this entity */
  readEndpoints: string[];
  /** Endpoints that create/update this entity */
  writeEndpoints: string[];
  /** Endpoints that delete this entity */
  deleteEndpoints: string[];
  /** Whether full CRUD is available */
  crudComplete: boolean;
  /** Missing CRUD operations */
  missingOps: string[];
}

export interface AuthFlow {
  /** Auth endpoint path */
  endpoint: string;
  method: string;
  /** Fields sent in request body */
  inputFields: string[];
  /** Token/session fields produced */
  producedTokens: string[];
  /** Where these tokens appear in subsequent requests */
  consumedBy: { endpoint: string; location: "header" | "cookie" | "query" | "body"; field: string }[];
  /** Detected refresh mechanism */
  refreshEndpoint?: string;
}

export interface PaginationPattern {
  /** Endpoint this was detected on */
  endpoint: string;
  type: "offset-limit" | "page-number" | "cursor" | "link-header" | "unknown";
  /** Parameter names used */
  params: Record<string, string>;
  /** Example values seen */
  examples: Record<string, string>;
}

export interface ErrorPattern {
  /** HTTP status code */
  status: number;
  /** Response shape when this error occurs */
  shape: string;
  /** Common error fields (e.g., "message", "error", "code") */
  fields: string[];
  /** Example error message if captured */
  example?: string;
  /** Endpoints where this was observed */
  endpoints: string[];
}

export interface RateLimitInfo {
  /** Endpoint or domain */
  scope: string;
  /** Limit value from headers */
  limit?: number;
  /** Window in seconds */
  windowSeconds?: number;
  /** Headers that carry rate limit info */
  headers: string[];
}

export interface DataFlow {
  /** Source endpoint that produces the value */
  producer: string;
  /** Field name in the producer's response */
  producerField: string;
  /** Destination endpoint that consumes the value */
  consumer: string;
  /** Where it's consumed: path param, query param, header, or body field */
  consumerLocation: "path" | "query" | "header" | "body";
  /** Field/param name in the consumer */
  consumerField: string;
}

export interface EndpointSuggestion {
  method: string;
  path: string;
  reason: string;
  confidence: "high" | "medium" | "low";
}

export interface ConfidenceScores {
  /** Overall analysis confidence (0–1) */
  overall: number;
  /** Confidence in entity extraction */
  entities: number;
  /** Confidence in auth flow detection */
  auth: number;
  /** Confidence in data flow tracing */
  dataFlows: number;
  /** Confidence in API surface coverage */
  coverage: number;
}

export interface AgenticAnalysis {
  /** Inferred domain entities and their CRUD operations */
  entities: Entity[];
  /** Authentication flow analysis */
  authFlows: AuthFlow[];
  /** Detected pagination patterns */
  pagination: PaginationPattern[];
  /** Error response patterns */
  errors: ErrorPattern[];
  /** Rate limit information */
  rateLimits: RateLimitInfo[];
  /** Data flow between endpoints (ID/token tracing) */
  dataFlows: DataFlow[];
  /** Suggested undiscovered endpoints */
  suggestions: EndpointSuggestion[];
  /** API style classification */
  apiStyle: "rest" | "graphql" | "rpc" | "mixed";
  /** Whether the API has versioning */
  versioning: { detected: boolean; versions: string[]; pattern: string } | null;
  /** Confidence scores for each analysis dimension */
  confidence: ConfidenceScores;
  /** Human-readable summary for the agent */
  summary: string;
}

// ── Constants ────────────────────────────────────────────────────────────

const ID_FIELD_PATTERNS = [
  /^id$/i,
  /Id$/,
  /^_id$/,
  /uuid$/i,
  /^guid$/i,
  /key$/i,
];

const TOKEN_FIELD_PATTERNS = [
  /token$/i,
  /^access.?token$/i,
  /^refresh.?token$/i,
  /^session.?id$/i,
  /^auth.?token$/i,
  /^jwt$/i,
  /^bearer$/i,
  /^api.?key$/i,
];

const PAGINATION_QUERY_PARAMS: Record<string, string[]> = {
  "offset-limit": ["offset", "limit", "skip", "take"],
  "page-number": ["page", "per_page", "pagesize", "page_size", "size", "perpage"],
  "cursor": ["cursor", "after", "before", "next_token", "nexttoken", "continuation", "start_after"],
};

const PAGINATION_RESPONSE_FIELDS = new Set([
  "total", "count", "total_count", "totalcount", "total_pages", "totalpages",
  "has_more", "hasmore", "has_next", "hasnext", "next_cursor", "nextcursor",
  "next_page", "nextpage", "next_page_token", "next", "previous", "prev",
  "page", "per_page", "offset", "limit", "cursor",
]);

const ERROR_BODY_FIELDS = new Set([
  "message", "error", "code", "detail", "details", "errors",
  "error_code", "error_message", "error_description",
  "status", "statuscode", "status_code", "reason", "description",
  "type", "title", "instance", "violations",
]);

const RATE_LIMIT_HEADERS = [
  "x-ratelimit-limit", "x-ratelimit-remaining", "x-ratelimit-reset",
  "x-rate-limit-limit", "x-rate-limit-remaining", "x-rate-limit-reset",
  "ratelimit-limit", "ratelimit-remaining", "ratelimit-reset",
  "ratelimit", "retry-after",
  "x-ratelimit-requests-limit", "x-ratelimit-requests-remaining",
  "x-ratelimit-tokens-limit", "x-ratelimit-tokens-remaining",
];

const AUTH_PATH_PATTERNS = [
  /\/login\b/i, /\/signin\b/i, /\/sign-in\b/i,
  /\/auth\b/i, /\/token\b/i, /\/oauth\b/i,
  /\/register\b/i, /\/signup\b/i, /\/sign-up\b/i,
  /\/session\b/i,
];

const REFRESH_PATH_PATTERNS = [
  /\/refresh\b/i, /\/renew\b/i, /\/rotate\b/i,
];

// Common sub-resource patterns used in endpoint suggestions
const COMMON_SUB_RESOURCES: Record<string, string[]> = {
  users: ["posts", "comments", "orders", "settings", "notifications", "followers", "following", "favorites"],
  products: ["reviews", "images", "variants", "categories"],
  orders: ["items", "payments", "shipments", "tracking", "refunds"],
  posts: ["comments", "likes", "shares", "tags"],
  projects: ["members", "tasks", "files", "settings"],
  teams: ["members", "projects", "invitations"],
  organizations: ["members", "teams", "projects", "billing"],
};

// ── Helpers ──────────────────────────────────────────────────────────────

function endpointKey(group: EndpointGroup): string {
  return `${group.method} ${group.normalizedPath}`;
}

function isIdField(name: string): boolean {
  return ID_FIELD_PATTERNS.some(p => p.test(name));
}

function isTokenField(name: string): boolean {
  return TOKEN_FIELD_PATTERNS.some(p => p.test(name));
}

/** Singularize a simple English noun (best-effort). */
function singularize(word: string): string {
  if (word.endsWith("ies")) return word.slice(0, -3) + "y";
  if (word.endsWith("ses") || word.endsWith("xes") || word.endsWith("zes"))
    return word.slice(0, -2);
  if (word.endsWith("s") && !word.endsWith("ss")) return word.slice(0, -1);
  return word;
}

/** Capitalize first letter. */
function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/**
 * Extract the base resource path (without params) and the resource name
 * from a normalized path.
 *
 * /api/v1/users/{userId}/orders → { basePath: "/api/v1/users/{userId}/orders", resource: "orders", parent: "users" }
 * /api/v1/users/{userId}       → { basePath: "/api/v1/users", resource: "users", parent: null }
 * /api/v1/users                → { basePath: "/api/v1/users", resource: "users", parent: null }
 */
function parseResourcePath(normalizedPath: string): {
  basePath: string;
  resource: string;
  parent: string | null;
} {
  const segments = normalizedPath.split("/").filter(Boolean).filter(s => !/^(api|v\d+)$/i.test(s));

  // Walk backwards to find last non-param resource
  let resource = "";
  let resourceIdx = -1;
  for (let i = segments.length - 1; i >= 0; i--) {
    if (!segments[i].startsWith("{")) {
      resource = segments[i];
      resourceIdx = i;
      break;
    }
  }

  if (!resource) {
    return { basePath: normalizedPath, resource: "root", parent: null };
  }

  // Find the parent resource (non-param segment before a param, preceding the resource)
  let parent: string | null = null;
  for (let i = resourceIdx - 1; i >= 0; i--) {
    if (!segments[i].startsWith("{")) {
      parent = segments[i];
      break;
    }
  }

  // basePath: the path up to and including the resource segment (trim trailing params)
  const fullSegments = normalizedPath.split("/").filter(Boolean);
  const lastNonParam = fullSegments.lastIndexOf(resource);
  const basePath = "/" + fullSegments.slice(0, lastNonParam + 1).join("/");

  return { basePath, resource, parent };
}

/**
 * Build an index of HAR entries by normalized path + method for fast lookup.
 */
function indexHarEntries(
  harEntries: HarEntry[],
  requests: ParsedRequest[],
): Map<string, HarEntry[]> {
  const index = new Map<string, HarEntry[]>();

  // Match HAR entries to requests by URL + method
  for (let i = 0; i < harEntries.length && i < requests.length; i++) {
    const entry = harEntries[i];
    const req = requests[i];
    if (!req || !entry) continue;

    // Verify they match (HAR and requests should be in same order from parseHar,
    // but requests may have been filtered). Match by URL.
    if (entry.request.url !== req.url) continue;

    const normPath = req.normalizedPath || req.path;
    const key = `${req.method.toUpperCase()} ${normPath}`;
    const existing = index.get(key);
    if (existing) {
      existing.push(entry);
    } else {
      index.set(key, [entry]);
    }
  }

  return index;
}

/**
 * Build a more robust HAR index that matches by URL rather than position.
 */
function indexHarEntriesByUrl(harEntries: HarEntry[]): Map<string, HarEntry[]> {
  const index = new Map<string, HarEntry[]>();
  for (const entry of harEntries) {
    const url = entry.request.url;
    const method = entry.request.method.toUpperCase();
    const key = `${method}:${url}`;
    const existing = index.get(key);
    if (existing) {
      existing.push(entry);
    } else {
      index.set(key, [entry]);
    }
  }
  return index;
}

/**
 * Find HAR entries matching a given request.
 */
function findHarEntries(
  req: ParsedRequest,
  harUrlIndex: Map<string, HarEntry[]>,
): HarEntry[] {
  const key = `${req.method.toUpperCase()}:${req.url}`;
  return harUrlIndex.get(key) ?? [];
}

// ── Entity Extraction ────────────────────────────────────────────────────

function extractEntities(groups: EndpointGroup[]): Entity[] {
  // Group endpoints by their base resource name
  const resourceMap = new Map<string, EndpointGroup[]>();

  for (const group of groups) {
    if (group.category === "auth") continue;
    const { resource } = parseResourcePath(group.normalizedPath);
    const key = resource.toLowerCase();
    const existing = resourceMap.get(key);
    if (existing) {
      existing.push(group);
    } else {
      resourceMap.set(key, [group]);
    }
  }

  const entities: Entity[] = [];

  for (const [resourceName, endpoints] of resourceMap) {
    // Collect all fields from response schemas across related endpoints
    const fieldMap = new Map<string, EntityField>();

    for (const ep of endpoints) {
      if (!ep.responseBodySchema) continue;
      const epKey = endpointKey(ep);

      for (const [fieldName, fieldType] of Object.entries(ep.responseBodySchema)) {
        const existing = fieldMap.get(fieldName);
        if (existing) {
          if (!existing.seenIn.includes(epKey)) {
            existing.seenIn.push(epKey);
          }
          // If the field has different types across endpoints, mark as mixed
          if (existing.type !== fieldType && existing.type !== "mixed") {
            existing.type = "mixed";
          }
          // If ever seen as null, mark nullable
          if (fieldType === "null") {
            existing.nullable = true;
          }
        } else {
          fieldMap.set(fieldName, {
            name: fieldName,
            type: fieldType === "null" ? "string" : fieldType,
            seenIn: [epKey],
            nullable: fieldType === "null",
            isId: isIdField(fieldName),
          });
        }
      }
    }

    if (fieldMap.size === 0) continue;

    // Classify endpoints into CRUD operations
    const readEndpoints: string[] = [];
    const writeEndpoints: string[] = [];
    const deleteEndpoints: string[] = [];

    for (const ep of endpoints) {
      const key = endpointKey(ep);
      switch (ep.category) {
        case "read":
          readEndpoints.push(key);
          break;
        case "write":
          writeEndpoints.push(key);
          break;
        case "delete":
          deleteEndpoints.push(key);
          break;
        default:
          // 'other' category — try to infer from method
          if (ep.method === "GET" || ep.method === "HEAD") readEndpoints.push(key);
          else if (ep.method === "DELETE") deleteEndpoints.push(key);
          else writeEndpoints.push(key);
          break;
      }
    }

    // Determine what's missing
    const missingOps: string[] = [];
    const hasGet = readEndpoints.length > 0;
    const hasCreate = writeEndpoints.some(e => e.startsWith("POST "));
    const hasUpdate = writeEndpoints.some(e => e.startsWith("PUT ") || e.startsWith("PATCH "));
    const hasDelete = deleteEndpoints.length > 0;

    if (!hasGet) missingOps.push("read");
    if (!hasCreate) missingOps.push("create");
    if (!hasUpdate) missingOps.push("update");
    if (!hasDelete) missingOps.push("delete");

    const entityName = capitalize(singularize(resourceName));

    entities.push({
      name: entityName,
      fields: Array.from(fieldMap.values()),
      readEndpoints,
      writeEndpoints,
      deleteEndpoints,
      crudComplete: missingOps.length === 0,
      missingOps,
    });
  }

  // Sort: entities with more fields and more endpoints first
  entities.sort((a, b) => {
    const scoreA = a.fields.length + a.readEndpoints.length + a.writeEndpoints.length + a.deleteEndpoints.length;
    const scoreB = b.fields.length + b.readEndpoints.length + b.writeEndpoints.length + b.deleteEndpoints.length;
    return scoreB - scoreA;
  });

  return entities;
}

// ── Auth Flow Tracing ────────────────────────────────────────────────────

function traceAuthFlows(
  groups: EndpointGroup[],
  data: ApiData,
  harEntries?: HarEntry[],
): AuthFlow[] {
  const authGroups = groups.filter(g => g.category === "auth");
  if (authGroups.length === 0) return [];

  const harUrlIndex = harEntries ? indexHarEntriesByUrl(harEntries) : null;
  const flows: AuthFlow[] = [];

  for (const authGroup of authGroups) {
    const authKey = endpointKey(authGroup);

    // Input fields: from request body schema
    const inputFields = authGroup.requestBodySchema
      ? Object.keys(authGroup.requestBodySchema)
      : [];

    // Produced tokens: from response body schema, look for token-like fields
    const producedTokens: string[] = [];

    if (authGroup.responseBodySchema) {
      for (const field of Object.keys(authGroup.responseBodySchema)) {
        if (isTokenField(field) || isIdField(field)) {
          producedTokens.push(field);
        }
      }
    }

    // Also check raw HAR response bodies for deeper token detection
    if (harUrlIndex) {
      for (const req of data.requests) {
        if ((req.normalizedPath || req.path) !== authGroup.normalizedPath) continue;
        if (req.method.toUpperCase() !== authGroup.method.toUpperCase()) continue;

        const entries = findHarEntries(req, harUrlIndex);
        for (const entry of entries) {
          const rawBody = safeParseJson(entry.response?.content?.text);
          if (rawBody && typeof rawBody === "object" && !Array.isArray(rawBody)) {
            for (const field of Object.keys(rawBody as Record<string, unknown>)) {
              if (isTokenField(field) && !producedTokens.includes(field)) {
                producedTokens.push(field);
              }
            }
          }
        }
        break; // Only need one match
      }
    }

    // Where are these tokens consumed? Search all non-auth endpoints
    const consumedBy: AuthFlow["consumedBy"] = [];

    // Get actual token values from auth headers/cookies for matching
    const tokenValues = new Set<string>();
    for (const val of Object.values(data.authHeaders)) {
      if (val) tokenValues.add(val);
      // Also add the bearer token without the "Bearer " prefix
      if (val.startsWith("Bearer ")) tokenValues.add(val.slice(7));
    }
    for (const val of Object.values(data.cookies)) {
      if (val) tokenValues.add(val);
    }

    for (const group of groups) {
      if (group.category === "auth") continue;
      const ep = endpointKey(group);

      // Check if any auth headers are used in requests to this endpoint
      for (const [headerName, headerValue] of Object.entries(data.authHeaders)) {
        if (headerValue) {
          consumedBy.push({ endpoint: ep, location: "header", field: headerName });
          break; // One match per endpoint is enough
        }
      }
    }

    // Detect refresh endpoints
    let refreshEndpoint: string | undefined;
    for (const group of authGroups) {
      if (REFRESH_PATH_PATTERNS.some(p => p.test(group.normalizedPath))) {
        refreshEndpoint = endpointKey(group);
        break;
      }
    }

    flows.push({
      endpoint: authGroup.normalizedPath,
      method: authGroup.method,
      inputFields,
      producedTokens,
      consumedBy,
      refreshEndpoint,
    });
  }

  return flows;
}

// ── Pagination Detection ─────────────────────────────────────────────────

function detectPagination(
  groups: EndpointGroup[],
  data: ApiData,
  harEntries?: HarEntry[],
): PaginationPattern[] {
  const patterns: PaginationPattern[] = [];
  const harUrlIndex = harEntries ? indexHarEntriesByUrl(harEntries) : null;

  for (const group of groups) {
    if (group.method !== "GET") continue;

    const ep = endpointKey(group);
    const queryParamNames = group.queryParams.map(q => q.name.toLowerCase());
    const queryParamMap: Record<string, string> = {};
    for (const q of group.queryParams) {
      queryParamMap[q.name.toLowerCase()] = q.example;
    }

    // Check query params against known pagination patterns
    let detectedType: PaginationPattern["type"] | null = null;
    const matchedParams: Record<string, string> = {};
    const matchedExamples: Record<string, string> = {};

    for (const [type, paramNames] of Object.entries(PAGINATION_QUERY_PARAMS)) {
      const matched = paramNames.filter(p => queryParamNames.includes(p));
      if (matched.length > 0) {
        detectedType = type as PaginationPattern["type"];
        for (const m of matched) {
          matchedParams[m] = m;
          if (queryParamMap[m]) {
            matchedExamples[m] = queryParamMap[m];
          }
        }
        break;
      }
    }

    // Check response body for pagination metadata
    if (!detectedType && group.responseBodySchema) {
      const responseFields = Object.keys(group.responseBodySchema).map(f => f.toLowerCase());
      const paginationFields = responseFields.filter(f => PAGINATION_RESPONSE_FIELDS.has(f));

      if (paginationFields.length > 0) {
        // Infer type from the response fields
        if (paginationFields.some(f => f.includes("cursor") || f.includes("next_token"))) {
          detectedType = "cursor";
        } else if (paginationFields.some(f => f === "page" || f.includes("total_pages"))) {
          detectedType = "page-number";
        } else if (paginationFields.some(f => f === "offset" || f === "limit")) {
          detectedType = "offset-limit";
        } else {
          detectedType = "unknown";
        }

        for (const f of paginationFields) {
          matchedParams[f] = f;
        }
      }
    }

    // Check Link headers in raw HAR entries
    if (!detectedType && harUrlIndex) {
      for (const req of data.requests) {
        if ((req.normalizedPath || req.path) !== group.normalizedPath) continue;
        if (req.method.toUpperCase() !== group.method.toUpperCase()) continue;

        const entries = findHarEntries(req, harUrlIndex);
        for (const entry of entries) {
          const linkHeader = entry.response.headers.find(
            h => h.name.toLowerCase() === "link",
          );
          if (linkHeader && linkHeader.value.includes('rel="next"')) {
            detectedType = "link-header";
            matchedParams["link"] = "Link header";
            matchedExamples["link"] = linkHeader.value;
            break;
          }
        }
        if (detectedType) break;
      }
    }

    if (detectedType) {
      patterns.push({
        endpoint: ep,
        type: detectedType,
        params: matchedParams,
        examples: matchedExamples,
      });
    }
  }

  return patterns;
}

// ── Error Pattern Detection ──────────────────────────────────────────────

function detectErrorPatterns(
  data: ApiData,
  harEntries?: HarEntry[],
): ErrorPattern[] {
  // Group error responses by status code
  const errorsByStatus = new Map<number, {
    endpoints: Set<string>;
    bodies: unknown[];
  }>();

  const harUrlIndex = harEntries ? indexHarEntriesByUrl(harEntries) : null;

  for (const req of data.requests) {
    if (req.status < 400) continue;

    const normPath = req.normalizedPath || req.path;
    const ep = `${req.method.toUpperCase()} ${normPath}`;

    const existing = errorsByStatus.get(req.status);
    if (existing) {
      existing.endpoints.add(ep);
    } else {
      errorsByStatus.set(req.status, { endpoints: new Set([ep]), bodies: [] });
    }

    // Get the raw response body from HAR entries for richer analysis
    if (harUrlIndex) {
      const entries = findHarEntries(req, harUrlIndex);
      for (const entry of entries) {
        if (entry.response.status >= 400) {
          const body = safeParseJson(entry.response.content?.text);
          if (body) {
            errorsByStatus.get(req.status)!.bodies.push(body);
          }
        }
      }
    }

    // Also use the enriched responseBody (top-level schema) if no HAR
    if (req.responseBody && typeof req.responseBody === "object") {
      errorsByStatus.get(req.status)!.bodies.push(req.responseBody);
    }
  }

  const patterns: ErrorPattern[] = [];

  for (const [status, info] of errorsByStatus) {
    const fields: Set<string> = new Set();
    let exampleMessage: string | undefined;
    let shape = "unknown";

    for (const body of info.bodies) {
      if (body && typeof body === "object" && !Array.isArray(body)) {
        const keys = Object.keys(body as Record<string, unknown>);
        shape = `object{${keys.slice(0, 6).join(",")}}`;

        for (const key of keys) {
          if (ERROR_BODY_FIELDS.has(key.toLowerCase())) {
            fields.add(key);
          }
        }

        // Try to get an example error message
        if (!exampleMessage) {
          const record = body as Record<string, unknown>;
          const msgField = keys.find(k =>
            k.toLowerCase() === "message" ||
            k.toLowerCase() === "error" ||
            k.toLowerCase() === "detail",
          );
          if (msgField && typeof record[msgField] === "string") {
            exampleMessage = record[msgField] as string;
            // Truncate long messages
            if (exampleMessage.length > 120) {
              exampleMessage = exampleMessage.slice(0, 117) + "...";
            }
          }
        }
      } else if (body && typeof body === "object" && Array.isArray(body)) {
        shape = "array";
      }
    }

    // If we didn't get fields from bodies, infer from the schema
    if (fields.size === 0 && info.bodies.length === 0) {
      shape = "unknown";
    }

    patterns.push({
      status,
      shape,
      fields: Array.from(fields),
      example: exampleMessage,
      endpoints: Array.from(info.endpoints),
    });
  }

  // Sort by status code
  patterns.sort((a, b) => a.status - b.status);

  return patterns;
}

// ── Rate Limit Detection ─────────────────────────────────────────────────

function detectRateLimits(
  data: ApiData,
  harEntries?: HarEntry[],
): RateLimitInfo[] {
  if (!harEntries || harEntries.length === 0) return [];

  // Group rate limit headers by endpoint/domain
  const limitsMap = new Map<string, {
    headers: Set<string>;
    limit?: number;
    windowSeconds?: number;
  }>();

  for (const entry of harEntries) {
    const responseHeaders = entry.response.headers;
    if (!responseHeaders) continue;

    const foundHeaders: string[] = [];
    let limit: number | undefined;
    let windowSeconds: number | undefined;

    for (const header of responseHeaders) {
      const name = header.name.toLowerCase();

      if (RATE_LIMIT_HEADERS.includes(name)) {
        foundHeaders.push(header.name);

        // Parse limit value
        if (name.includes("limit") && !name.includes("remaining") && !name.includes("reset")) {
          const parsed = parseInt(header.value, 10);
          if (!isNaN(parsed)) limit = parsed;
        }

        // Parse reset/window
        if (name.includes("reset") || name === "retry-after") {
          const parsed = parseInt(header.value, 10);
          if (!isNaN(parsed)) {
            // If the value is a Unix timestamp (> year 2000 in seconds), compute delta
            if (parsed > 946684800) {
              windowSeconds = Math.max(0, parsed - Math.floor(Date.now() / 1000));
            } else {
              windowSeconds = parsed;
            }
          }
        }
      }
    }

    if (foundHeaders.length > 0) {
      // Determine scope — use domain as scope
      let scope: string;
      try {
        scope = new URL(entry.request.url).host;
      } catch {
        scope = "unknown";
      }

      const existing = limitsMap.get(scope);
      if (existing) {
        for (const h of foundHeaders) existing.headers.add(h);
        if (limit !== undefined && existing.limit === undefined) existing.limit = limit;
        if (windowSeconds !== undefined && existing.windowSeconds === undefined) existing.windowSeconds = windowSeconds;
      } else {
        limitsMap.set(scope, {
          headers: new Set(foundHeaders),
          limit,
          windowSeconds,
        });
      }
    }
  }

  return Array.from(limitsMap.entries()).map(([scope, info]) => ({
    scope,
    limit: info.limit,
    windowSeconds: info.windowSeconds,
    headers: Array.from(info.headers),
  }));
}

// ── Data Flow Tracing ────────────────────────────────────────────────────

function traceDataFlows(groups: EndpointGroup[]): DataFlow[] {
  const flows: DataFlow[] = [];
  const seen = new Set<string>();

  // For each endpoint that produces IDs/tokens
  for (const producer of groups) {
    if (producer.produces.length === 0) continue;
    const producerKey = endpointKey(producer);

    for (const producedField of producer.produces) {
      // Find endpoints that consume this field
      for (const consumer of groups) {
        if (consumer === producer) continue;
        const consumerKey = endpointKey(consumer);

        // Check path params
        for (const pp of consumer.pathParams) {
          if (fieldNamesMatch(producedField, pp.name)) {
            const flowKey = `${producerKey}:${producedField}->${consumerKey}:path:${pp.name}`;
            if (!seen.has(flowKey)) {
              seen.add(flowKey);
              flows.push({
                producer: producerKey,
                producerField: producedField,
                consumer: consumerKey,
                consumerLocation: "path",
                consumerField: pp.name,
              });
            }
          }
        }

        // Check query params
        for (const qp of consumer.queryParams) {
          if (fieldNamesMatch(producedField, qp.name)) {
            const flowKey = `${producerKey}:${producedField}->${consumerKey}:query:${qp.name}`;
            if (!seen.has(flowKey)) {
              seen.add(flowKey);
              flows.push({
                producer: producerKey,
                producerField: producedField,
                consumer: consumerKey,
                consumerLocation: "query",
                consumerField: qp.name,
              });
            }
          }
        }

        // Check request body
        if (consumer.requestBodySchema) {
          for (const field of Object.keys(consumer.requestBodySchema)) {
            if (fieldNamesMatch(producedField, field)) {
              const flowKey = `${producerKey}:${producedField}->${consumerKey}:body:${field}`;
              if (!seen.has(flowKey)) {
                seen.add(flowKey);
                flows.push({
                  producer: producerKey,
                  producerField: producedField,
                  consumer: consumerKey,
                  consumerLocation: "body",
                  consumerField: field,
                });
              }
            }
          }
        }
      }
    }
  }

  return flows;
}

/**
 * Check if two field names refer to the same logical value.
 * e.g., "id" matches "userId" path param, "orderId" matches "orderId".
 */
function fieldNamesMatch(produced: string, consumed: string): boolean {
  const pLower = produced.toLowerCase();
  const cLower = consumed.toLowerCase();

  // Exact match
  if (pLower === cLower) return true;

  // "id" produced by /users endpoint matches "userId" consumer
  if (pLower === "id" && cLower.endsWith("id")) return true;

  // "userId" matches "user_id"
  const pNorm = pLower.replace(/[_-]/g, "");
  const cNorm = cLower.replace(/[_-]/g, "");
  if (pNorm === cNorm) return true;

  // Field name is contained in the other (e.g., "token" matches "accessToken")
  if (pNorm.length >= 3 && cNorm.includes(pNorm)) return true;
  if (cNorm.length >= 3 && pNorm.includes(cNorm)) return true;

  return false;
}

// ── Endpoint Suggestions ─────────────────────────────────────────────────

function suggestEndpoints(
  groups: EndpointGroup[],
  entities: Entity[],
): EndpointSuggestion[] {
  const suggestions: EndpointSuggestion[] = [];
  const existingEndpoints = new Set(groups.map(g => `${g.method} ${g.normalizedPath}`));

  // Suggest missing CRUD operations for each entity
  for (const entity of entities) {
    for (const missingOp of entity.missingOps) {
      // Find a representative path for this entity
      const existingPaths = [
        ...entity.readEndpoints,
        ...entity.writeEndpoints,
        ...entity.deleteEndpoints,
      ];
      if (existingPaths.length === 0) continue;

      const samplePath = existingPaths[0].split(" ")[1];
      if (!samplePath) continue;

      const { resource } = parseResourcePath(samplePath);
      const collectionPath = samplePath.replace(/\/\{[^}]+\}$/, "");
      const itemPath = samplePath.includes("{")
        ? samplePath
        : `${samplePath}/{${singularize(resource)}Id}`;

      switch (missingOp) {
        case "read": {
          // Suggest both list and get-by-id
          const listKey = `GET ${collectionPath}`;
          const getKey = `GET ${itemPath}`;
          if (!existingEndpoints.has(listKey)) {
            suggestions.push({
              method: "GET",
              path: collectionPath,
              reason: `List all ${resource} (CRUD gap for ${entity.name})`,
              confidence: "high",
            });
          }
          if (!existingEndpoints.has(getKey)) {
            suggestions.push({
              method: "GET",
              path: itemPath,
              reason: `Get ${entity.name} by ID (CRUD gap)`,
              confidence: "high",
            });
          }
          break;
        }
        case "create": {
          const key = `POST ${collectionPath}`;
          if (!existingEndpoints.has(key)) {
            suggestions.push({
              method: "POST",
              path: collectionPath,
              reason: `Create a ${entity.name} (CRUD gap)`,
              confidence: "high",
            });
          }
          break;
        }
        case "update": {
          const key = `PUT ${itemPath}`;
          const patchKey = `PATCH ${itemPath}`;
          if (!existingEndpoints.has(key) && !existingEndpoints.has(patchKey)) {
            suggestions.push({
              method: "PUT",
              path: itemPath,
              reason: `Update a ${entity.name} (CRUD gap)`,
              confidence: "medium",
            });
          }
          break;
        }
        case "delete": {
          const key = `DELETE ${itemPath}`;
          if (!existingEndpoints.has(key)) {
            suggestions.push({
              method: "DELETE",
              path: itemPath,
              reason: `Delete a ${entity.name} (CRUD gap)`,
              confidence: "medium",
            });
          }
          break;
        }
      }
    }
  }

  // Suggest common sub-resources
  for (const group of groups) {
    const { resource } = parseResourcePath(group.normalizedPath);
    const resourceLower = resource.toLowerCase();
    const subResources = COMMON_SUB_RESOURCES[resourceLower];

    if (subResources && group.normalizedPath.includes("{")) {
      // This is a specific resource endpoint (e.g., /users/{userId})
      // Suggest sub-resources that don't exist yet
      const basePath = group.normalizedPath;
      for (const sub of subResources) {
        const subPath = `${basePath}/${sub}`;
        const key = `GET ${subPath}`;
        if (!existingEndpoints.has(key)) {
          // Only suggest if at least one other sub-resource exists for this entity
          const hasAnySub = groups.some(
            g => g.normalizedPath.startsWith(basePath + "/") && g.normalizedPath !== basePath,
          );
          if (hasAnySub) {
            suggestions.push({
              method: "GET",
              path: subPath,
              reason: `Common sub-resource of ${resource}`,
              confidence: "low",
            });
          }
        }
      }
    }
  }

  // Suggest common utility endpoints
  const commonPaths = [
    { method: "GET", suffix: "/me", reason: "Current user profile (common auth pattern)" },
    { method: "GET", suffix: "/search", reason: "Search endpoint" },
    { method: "GET", suffix: "/health", reason: "Health check endpoint" },
  ];

  // Find a base path prefix (e.g., /api/v1)
  const pathPrefixes = groups.map(g => {
    const match = g.normalizedPath.match(/^(\/api\/v\d+|\/api|\/v\d+)/);
    return match ? match[1] : "";
  }).filter(Boolean);
  const commonPrefix = pathPrefixes.length > 0
    ? mostFrequent(pathPrefixes)
    : "";

  for (const { method, suffix, reason } of commonPaths) {
    const path = commonPrefix + suffix;
    const key = `${method} ${path}`;
    if (!existingEndpoints.has(key)) {
      suggestions.push({
        method,
        path,
        reason,
        confidence: "low",
      });
    }
  }

  // Suggest version upgrades if versioned paths exist
  const versions = detectVersionsFromPaths(groups);
  if (versions.length > 0) {
    const latestVersion = versions.sort().pop()!;
    const nextVersion = `v${parseInt(latestVersion.slice(1), 10) + 1}`;

    // Find endpoints on the latest version and suggest their next-version equivalents
    for (const group of groups.slice(0, 3)) {
      if (group.normalizedPath.includes(`/${latestVersion}/`)) {
        const nextPath = group.normalizedPath.replace(`/${latestVersion}/`, `/${nextVersion}/`);
        const key = `${group.method} ${nextPath}`;
        if (!existingEndpoints.has(key)) {
          suggestions.push({
            method: group.method,
            path: nextPath,
            reason: `Next API version (${nextVersion}) equivalent`,
            confidence: "low",
          });
        }
      }
    }
  }

  // Deduplicate suggestions
  const seen = new Set<string>();
  return suggestions.filter(s => {
    const key = `${s.method} ${s.path}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function mostFrequent(arr: string[]): string {
  const counts = new Map<string, number>();
  for (const item of arr) {
    counts.set(item, (counts.get(item) ?? 0) + 1);
  }
  let maxCount = 0;
  let maxItem = arr[0];
  for (const [item, count] of counts) {
    if (count > maxCount) {
      maxCount = count;
      maxItem = item;
    }
  }
  return maxItem;
}

// ── API Style Detection ──────────────────────────────────────────────────

function detectApiStyle(groups: EndpointGroup[]): "rest" | "graphql" | "rpc" | "mixed" {
  let restScore = 0;
  let graphqlScore = 0;
  let rpcScore = 0;

  for (const group of groups) {
    const path = group.normalizedPath.toLowerCase();

    // GraphQL detection
    if (path.includes("/graphql") || path.endsWith("/gql")) {
      graphqlScore += 10;
      continue;
    }

    // REST pattern: /resource/{id} with appropriate HTTP methods
    if (/\/\{[^}]+\}/.test(group.normalizedPath)) {
      restScore += 2;
    }

    // REST pattern: collection endpoints with standard HTTP methods
    const segments = path.split("/").filter(Boolean).filter(s => !/^(api|v\d+)$/i.test(s));
    const lastSegment = segments[segments.length - 1];
    if (lastSegment && !lastSegment.startsWith("{")) {
      // Looks like a resource collection
      if (group.method === "GET" || group.method === "POST") {
        restScore += 1;
      }
    }

    // RPC pattern: verb-like path segments (doSomething, processOrder)
    if (lastSegment && /^(get|set|create|update|delete|process|execute|run|do|fetch|send|check|validate|compute|calculate|submit|generate|search|find|list|batch|bulk)/i.test(lastSegment)) {
      // Only count as RPC if it's POST to a verb-like path (not GET /search)
      if (group.method === "POST" && !/search|find|list|get/i.test(lastSegment)) {
        rpcScore += 2;
      }
    }
  }

  const total = restScore + graphqlScore + rpcScore;
  if (total === 0) return "rest"; // default

  if (graphqlScore > 0 && graphqlScore >= restScore && graphqlScore >= rpcScore) {
    return graphqlScore > total * 0.5 ? "graphql" : "mixed";
  }

  if (rpcScore > restScore) {
    return rpcScore > total * 0.6 ? "rpc" : "mixed";
  }

  if (restScore > rpcScore + graphqlScore) {
    return "rest";
  }

  return "mixed";
}

// ── Versioning Detection ─────────────────────────────────────────────────

function detectVersionsFromPaths(groups: EndpointGroup[]): string[] {
  const versions = new Set<string>();
  for (const group of groups) {
    const match = group.normalizedPath.match(/\/(v\d+(?:\.\d+)*)/i);
    if (match) {
      versions.add(match[1].toLowerCase());
    }
  }
  return Array.from(versions);
}

function detectVersioning(
  groups: EndpointGroup[],
  data: ApiData,
  harEntries?: HarEntry[],
): AgenticAnalysis["versioning"] {
  const versions = detectVersionsFromPaths(groups);

  if (versions.length > 0) {
    return {
      detected: true,
      versions: versions.sort(),
      pattern: "path",
    };
  }

  // Check for version headers in HAR
  if (harEntries) {
    const versionHeaders = new Set<string>();
    for (const entry of harEntries) {
      for (const header of entry.request.headers) {
        const name = header.name.toLowerCase();
        if (name === "accept-version" || name === "api-version" || name === "x-api-version") {
          versionHeaders.add(header.value);
        }
      }
    }
    if (versionHeaders.size > 0) {
      return {
        detected: true,
        versions: Array.from(versionHeaders).sort(),
        pattern: "header",
      };
    }
  }

  // Check for version in query params
  for (const group of groups) {
    const versionParam = group.queryParams.find(
      q => q.name.toLowerCase() === "version" || q.name.toLowerCase() === "api_version",
    );
    if (versionParam) {
      return {
        detected: true,
        versions: [versionParam.example],
        pattern: "query",
      };
    }
  }

  return null;
}

// ── Summary Generation ───────────────────────────────────────────────────

function generateSummary(
  analysis: Omit<AgenticAnalysis, "summary">,
  data: ApiData,
  focus?: FocusArea,
): string {
  const parts: string[] = [];

  // Focus mode prefix
  if (focus) {
    const focusLabels: Record<FocusArea, string> = {
      entities: "entity extraction and field analysis",
      auth: "authentication flow tracing",
      dataflow: "data flow and dependency tracing",
      gaps: "API coverage gaps and missing endpoints",
      pagination: "pagination patterns and collection sizing",
      errors: "error classification and response patterns",
    };
    parts.push(`Deep dive into ${focusLabels[focus]}:`);
  }

  // API purpose
  const entityNames = analysis.entities.slice(0, 5).map(e => e.name);
  if (entityNames.length > 0) {
    parts.push(
      `This API manages ${entityNames.join(", ")} entities` +
      (analysis.entities.length > 5 ? ` and ${analysis.entities.length - 5} more` : "") +
      ".",
    );
  } else {
    parts.push(`This API (${data.service}) has ${data.requests.length} captured requests.`);
  }

  // Endpoint count and style
  const groupCount = data.endpointGroups?.length ?? 0;
  parts.push(
    `${groupCount} unique endpoints detected, following a ${analysis.apiStyle.toUpperCase()} style.`,
  );

  // Auth
  if (analysis.authFlows.length > 0) {
    const flow = analysis.authFlows[0];
    const tokenDesc = flow.producedTokens.length > 0
      ? ` producing ${flow.producedTokens.join(", ")}`
      : "";
    parts.push(
      `Authentication via ${flow.method} ${flow.endpoint}${tokenDesc}.` +
      (flow.refreshEndpoint ? ` Token refresh available at ${flow.refreshEndpoint}.` : ""),
    );
  } else if (data.authMethod && data.authMethod !== "none") {
    parts.push(`Authentication: ${data.authMethod}.`);
  }

  // CRUD completeness
  const completeEntities = analysis.entities.filter(e => e.crudComplete);
  const incompleteEntities = analysis.entities.filter(e => !e.crudComplete);
  if (completeEntities.length > 0) {
    parts.push(`${completeEntities.length} entities have complete CRUD operations.`);
  }
  if (incompleteEntities.length > 0) {
    parts.push(
      `${incompleteEntities.length} entities have incomplete CRUD: ` +
      incompleteEntities
        .slice(0, 3)
        .map(e => `${e.name} (missing ${e.missingOps.join(", ")})`)
        .join("; ") +
      ".",
    );
  }

  // Pagination
  if (analysis.pagination.length > 0) {
    const types = [...new Set(analysis.pagination.map(p => p.type))];
    parts.push(`Pagination detected: ${types.join(", ")}.`);
  }

  // Rate limits
  if (analysis.rateLimits.length > 0) {
    const rl = analysis.rateLimits[0];
    const limitStr = rl.limit ? `${rl.limit} requests` : "rate limiting";
    parts.push(`Rate limits present: ${limitStr}${rl.windowSeconds ? ` per ${rl.windowSeconds}s window` : ""}.`);
  }

  // Errors
  if (analysis.errors.length > 0) {
    const codes = analysis.errors.map(e => e.status);
    parts.push(`Error responses observed: HTTP ${codes.join(", ")}.`);
  }

  // Versioning
  if (analysis.versioning?.detected) {
    parts.push(`API versioning: ${analysis.versioning.versions.join(", ")} (via ${analysis.versioning.pattern}).`);
  }

  // Suggestions
  if (analysis.suggestions.length > 0) {
    const highConf = analysis.suggestions.filter(s => s.confidence === "high");
    if (highConf.length > 0) {
      parts.push(
        `${highConf.length} likely undiscovered endpoints to explore (e.g., ${highConf[0].method} ${highConf[0].path}).`,
      );
    }
  }

  return parts.join(" ");
}

// ── Confidence Scoring ────────────────────────────────────────────────────

function computeConfidence(
  data: ApiData,
  entities: Entity[],
  authFlows: AuthFlow[],
  dataFlows: DataFlow[],
  groups: EndpointGroup[],
  harEntries?: HarEntry[],
): ConfidenceScores {
  const hasHar = !!harEntries && harEntries.length > 0;

  // --- Entity confidence ---
  // Based on: number of entities found, field count per entity, response body availability
  let entityScore = 0;
  if (entities.length > 0) {
    const avgFields = entities.reduce((s, e) => s + e.fields.length, 0) / entities.length;
    // More fields = higher confidence in entity extraction
    entityScore = Math.min(1, 0.3 + avgFields * 0.05);
    // Bonus if we have multiple endpoints per entity (cross-validation)
    const avgEndpoints = entities.reduce(
      (s, e) => s + e.readEndpoints.length + e.writeEndpoints.length + e.deleteEndpoints.length,
      0,
    ) / entities.length;
    if (avgEndpoints > 2) entityScore = Math.min(1, entityScore + 0.15);
  }
  // Penalize if no response body schemas are available
  const groupsWithResponseSchema = groups.filter(g => g.responseBodySchema && Object.keys(g.responseBodySchema).length > 0);
  if (groups.length > 0 && groupsWithResponseSchema.length / groups.length < 0.3) {
    entityScore *= 0.6;
  }

  // --- Auth confidence ---
  let authScore = 0;
  if (authFlows.length > 0) {
    authScore = 0.5;
    // Higher if we found produced tokens
    if (authFlows.some(f => f.producedTokens.length > 0)) authScore += 0.2;
    // Higher if we traced where tokens are consumed
    if (authFlows.some(f => f.consumedBy.length > 0)) authScore += 0.2;
    // Higher if refresh endpoint detected
    if (authFlows.some(f => f.refreshEndpoint)) authScore += 0.1;
  } else if (data.authMethod && data.authMethod !== "none") {
    // We know auth exists but couldn't trace the flow
    authScore = 0.3;
  } else {
    // No auth detected — could mean no auth or we missed it
    // If there are auth headers, we missed tracing
    authScore = Object.keys(data.authHeaders).length > 0 ? 0.2 : 0.5;
  }

  // --- Data flow confidence ---
  let dataFlowScore = 0;
  if (dataFlows.length > 0) {
    dataFlowScore = Math.min(1, 0.4 + dataFlows.length * 0.05);
    // Higher if we have HAR data (actual field values for matching)
    if (hasHar) dataFlowScore = Math.min(1, dataFlowScore + 0.15);
  } else if (groups.length <= 2) {
    // Few endpoints — data flow detection is naturally limited
    dataFlowScore = 0.5;
  }

  // --- Coverage confidence ---
  // How well do we cover the API surface?
  let coverageScore = 0;
  if (data.requests.length > 0) {
    // More unique requests per endpoint = higher confidence
    const avgRequestsPerEndpoint = groups.length > 0
      ? data.requests.length / groups.length
      : 0;
    coverageScore = Math.min(1, 0.2 + avgRequestsPerEndpoint * 0.1);
    // Bonus for HAR data (richer than reconstructed)
    if (hasHar) coverageScore = Math.min(1, coverageScore + 0.15);
    // Bonus for having both successful and error responses
    const hasErrors = data.requests.some(r => r.status >= 400);
    const hasSuccess = data.requests.some(r => r.status >= 200 && r.status < 300);
    if (hasErrors && hasSuccess) coverageScore = Math.min(1, coverageScore + 0.1);
  }

  // --- Overall ---
  const overall = (entityScore + authScore + dataFlowScore + coverageScore) / 4;

  // Round all to 2 decimal places
  const round = (n: number) => Math.round(n * 100) / 100;

  return {
    overall: round(overall),
    entities: round(entityScore),
    auth: round(authScore),
    dataFlows: round(dataFlowScore),
    coverage: round(coverageScore),
  };
}

// ── Focus Mode: Deep Analysis ─────────────────────────────────────────────

/**
 * When focus is "entities": extract richer field metadata — field co-occurrence,
 * enum-like fields, timestamp patterns, required vs optional inference.
 */
function deepEntityAnalysis(
  entities: Entity[],
  groups: EndpointGroup[],
  data: ApiData,
  harEntries?: HarEntry[],
): Entity[] {
  const harUrlIndex = harEntries ? indexHarEntriesByUrl(harEntries) : null;

  for (const entity of entities) {
    // Collect all raw response bodies for this entity's endpoints
    const allBodies: Record<string, unknown>[] = [];
    const allEndpointKeys = [...entity.readEndpoints, ...entity.writeEndpoints];

    for (const epKey of allEndpointKeys) {
      for (const req of data.requests) {
        const normPath = req.normalizedPath || req.path;
        const reqKey = `${req.method.toUpperCase()} ${normPath}`;
        if (reqKey !== epKey) continue;

        // Use HAR entries for raw bodies
        if (harUrlIndex) {
          const entries = findHarEntries(req, harUrlIndex);
          for (const entry of entries) {
            const body = safeParseJson(entry.response?.content?.text);
            if (body && typeof body === "object" && !Array.isArray(body)) {
              allBodies.push(body as Record<string, unknown>);
            } else if (body && Array.isArray(body)) {
              for (const item of body as unknown[]) {
                if (item && typeof item === "object" && !Array.isArray(item)) {
                  allBodies.push(item as Record<string, unknown>);
                }
              }
            }
          }
        }
      }
    }

    if (allBodies.length === 0) continue;

    // Enrich each field with deeper metadata
    for (const field of entity.fields) {
      const values: unknown[] = [];
      let presentCount = 0;

      for (const body of allBodies) {
        if (field.name in body) {
          presentCount++;
          values.push(body[field.name]);
        }
      }

      // Detect enum-like fields: few unique string values across many instances
      if (values.length >= 3) {
        const stringVals = values.filter(v => typeof v === "string") as string[];
        if (stringVals.length >= 3) {
          const unique = new Set(stringVals);
          if (unique.size <= 5 && unique.size < stringVals.length * 0.5) {
            field.type = `enum(${Array.from(unique).join("|")})`;
          }
        }
      }

      // Detect timestamp patterns
      if (values.length > 0) {
        const sample = values[0];
        if (typeof sample === "string") {
          if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(sample)) {
            field.type = "datetime";
          } else if (/^\d{4}-\d{2}-\d{2}$/.test(sample)) {
            field.type = "date";
          }
        }
      }

      // Infer required vs optional: if present in >90% of bodies, mark as required
      if (allBodies.length >= 2) {
        const presenceRatio = presentCount / allBodies.length;
        field.nullable = presenceRatio < 0.9;
      }
    }

    // Detect field co-occurrence: fields that always appear together
    if (allBodies.length >= 3) {
      const fieldNames = entity.fields.map(f => f.name);
      const coOccurring: string[][] = [];

      for (let i = 0; i < fieldNames.length; i++) {
        for (let j = i + 1; j < fieldNames.length; j++) {
          const a = fieldNames[i];
          const b = fieldNames[j];
          let together = 0;
          let apart = 0;
          for (const body of allBodies) {
            const hasA = a in body;
            const hasB = b in body;
            if (hasA && hasB) together++;
            else if (hasA !== hasB) apart++;
          }
          if (together >= 3 && apart === 0) {
            coOccurring.push([a, b]);
          }
        }
      }

      // Add co-occurrence info to entity fields via seenIn metadata
      // We encode it by prefixing co-occurring partner names into seenIn
      for (const [a, b] of coOccurring) {
        const fieldA = entity.fields.find(f => f.name === a);
        const fieldB = entity.fields.find(f => f.name === b);
        if (fieldA && !fieldA.seenIn.includes(`co-occurs:${b}`)) {
          fieldA.seenIn.push(`co-occurs:${b}`);
        }
        if (fieldB && !fieldB.seenIn.includes(`co-occurs:${a}`)) {
          fieldB.seenIn.push(`co-occurs:${a}`);
        }
      }
    }
  }

  return entities;
}

/**
 * When focus is "auth": deeper token tracing — JWT vs opaque detection,
 * CSRF tokens, multi-step auth detection.
 */
function deepAuthAnalysis(
  authFlows: AuthFlow[],
  groups: EndpointGroup[],
  data: ApiData,
  harEntries?: HarEntry[],
): AuthFlow[] {
  const harUrlIndex = harEntries ? indexHarEntriesByUrl(harEntries) : null;

  for (const flow of authFlows) {
    // Detect token format (JWT vs opaque) from actual values in HAR
    if (harUrlIndex) {
      for (const req of data.requests) {
        const normPath = req.normalizedPath || req.path;
        if (normPath !== flow.endpoint) continue;
        if (req.method.toUpperCase() !== flow.method.toUpperCase()) continue;

        const entries = findHarEntries(req, harUrlIndex);
        for (const entry of entries) {
          const body = safeParseJson(entry.response?.content?.text);
          if (body && typeof body === "object" && !Array.isArray(body)) {
            const record = body as Record<string, unknown>;
            for (const tokenField of flow.producedTokens) {
              const val = record[tokenField];
              if (typeof val === "string") {
                // JWT detection: three base64url segments separated by dots
                if (/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(val)) {
                  if (!flow.producedTokens.includes(`${tokenField}(jwt)`)) {
                    // Replace the token name with annotated version
                    const idx = flow.producedTokens.indexOf(tokenField);
                    if (idx !== -1) flow.producedTokens[idx] = `${tokenField}(jwt)`;
                  }
                } else {
                  const idx = flow.producedTokens.indexOf(tokenField);
                  if (idx !== -1) flow.producedTokens[idx] = `${tokenField}(opaque)`;
                }
              }
            }
          }
        }
        break;
      }
    }

    // Detect CSRF tokens in request headers/cookies
    for (const req of data.requests) {
      if (req.status >= 400) continue;
      const normPath = req.normalizedPath || req.path;
      const ep = `${req.method.toUpperCase()} ${normPath}`;

      // Check for CSRF-like headers
      if (harUrlIndex) {
        const entries = findHarEntries(req, harUrlIndex);
        for (const entry of entries) {
          for (const header of entry.request.headers) {
            const name = header.name.toLowerCase();
            if (name.includes("csrf") || name.includes("xsrf") || name === "x-requested-with") {
              if (!flow.consumedBy.some(c => c.endpoint === ep && c.field === header.name)) {
                flow.consumedBy.push({
                  endpoint: ep,
                  location: "header",
                  field: header.name,
                });
              }
            }
          }
          break; // One entry is enough
        }
      }
    }

    // Detect multi-step auth: look for sequences like login → verify → token
    const authEndpoints = groups
      .filter(g => g.category === "auth")
      .map(g => endpointKey(g));

    if (authEndpoints.length > 1) {
      // If multiple auth endpoints exist, they likely form a multi-step flow
      // Add the other auth steps as consumed-by references
      for (const otherEp of authEndpoints) {
        if (otherEp.split(" ")[1] !== flow.endpoint) {
          if (!flow.consumedBy.some(c => c.endpoint === otherEp && c.field === "multi-step-auth")) {
            flow.consumedBy.push({
              endpoint: otherEp,
              location: "body",
              field: "multi-step-auth",
            });
          }
        }
      }
    }
  }

  return authFlows;
}

/**
 * When focus is "dataflow": trace IDs across 3+ endpoints (transitive chains),
 * detect cyclic dependencies, identify orchestration endpoints.
 */
function deepDataFlowAnalysis(
  dataFlows: DataFlow[],
  groups: EndpointGroup[],
): DataFlow[] {
  // Build adjacency: producer → consumers
  const producerGraph = new Map<string, Set<string>>();
  for (const flow of dataFlows) {
    const existing = producerGraph.get(flow.producer);
    if (existing) {
      existing.add(flow.consumer);
    } else {
      producerGraph.set(flow.producer, new Set([flow.consumer]));
    }
  }

  // Find transitive chains: A → B → C (trace IDs across 3+ endpoints)
  const transitiveFlows: DataFlow[] = [];
  const seen = new Set(dataFlows.map(f => `${f.producer}:${f.producerField}->${f.consumer}:${f.consumerField}`));

  for (const flow of dataFlows) {
    // Does the consumer of this flow produce something consumed elsewhere?
    const consumerProductions = producerGraph.get(flow.consumer);
    if (!consumerProductions) continue;

    // For each downstream consumer, check if the field propagates
    for (const downstreamConsumer of consumerProductions) {
      // Find the actual flow from consumer to downstream
      const downstreamFlows = dataFlows.filter(
        f => f.producer === flow.consumer && f.consumer === downstreamConsumer,
      );
      for (const downstream of downstreamFlows) {
        // Create a transitive flow: original producer → downstream consumer
        const key = `${flow.producer}:${flow.producerField}->${downstreamConsumer}:${downstream.consumerField}`;
        if (!seen.has(key)) {
          seen.add(key);
          transitiveFlows.push({
            producer: flow.producer,
            producerField: flow.producerField,
            consumer: downstreamConsumer,
            consumerLocation: downstream.consumerLocation,
            consumerField: `${downstream.consumerField}(via ${flow.consumer.split(" ").pop()})`,
          });
        }
      }
    }
  }

  // Identify orchestration endpoints: endpoints that consume from 2+ producers
  const consumerInputCount = new Map<string, number>();
  for (const flow of dataFlows) {
    consumerInputCount.set(flow.consumer, (consumerInputCount.get(flow.consumer) ?? 0) + 1);
  }

  // Add a synthetic flow for orchestration endpoints
  for (const [consumer, count] of consumerInputCount) {
    if (count >= 2) {
      const key = `orchestrator:${consumer}->self:orchestrator`;
      if (!seen.has(key)) {
        seen.add(key);
        transitiveFlows.push({
          producer: consumer,
          producerField: `orchestrator(consumes ${count} inputs)`,
          consumer: consumer,
          consumerLocation: "body",
          consumerField: "orchestration-marker",
        });
      }
    }
  }

  return [...dataFlows, ...transitiveFlows];
}

/**
 * When focus is "gaps": enumerate CRUD gaps, find lone GET endpoints,
 * detect response fields that look like sub-resource IDs.
 */
function deepGapAnalysis(
  entities: Entity[],
  groups: EndpointGroup[],
  suggestions: EndpointSuggestion[],
): EndpointSuggestion[] {
  const existingEndpoints = new Set(groups.map(g => `${g.method} ${g.normalizedPath}`));
  const additionalSuggestions: EndpointSuggestion[] = [];

  // Find lone GET endpoints (have reads but zero writes)
  for (const group of groups) {
    if (group.method !== "GET") continue;
    const { resource, basePath } = parseResourcePath(group.normalizedPath);
    if (!resource || resource === "root") continue;

    // Check if ANY write method exists for this resource
    const hasWrite = groups.some(g =>
      g.method !== "GET" && g.method !== "HEAD" && g.method !== "OPTIONS" &&
      parseResourcePath(g.normalizedPath).resource.toLowerCase() === resource.toLowerCase(),
    );

    if (!hasWrite) {
      const collectionPath = basePath.replace(/\/\{[^}]+\}$/, "");
      const itemPath = basePath.includes("{")
        ? basePath
        : `${basePath}/{${singularize(resource)}Id}`;

      for (const method of ["POST", "PUT", "DELETE"] as const) {
        const target = method === "POST" ? collectionPath : itemPath;
        const key = `${method} ${target}`;
        if (!existingEndpoints.has(key) && !suggestions.some(s => s.method === method && s.path === target)) {
          additionalSuggestions.push({
            method,
            path: target,
            reason: `Lone GET: ${resource} has reads but no writes — likely undiscovered`,
            confidence: "medium",
          });
        }
      }
    }
  }

  // Find response fields that look like sub-resource IDs with no corresponding endpoint
  for (const group of groups) {
    if (!group.responseBodySchema) continue;
    for (const [field, type] of Object.entries(group.responseBodySchema)) {
      if (!isIdField(field) || field === "id" || field === "_id") continue;
      // e.g., "organizationId" → look for /organizations endpoint
      const resourceGuess = field.replace(/Id$|_id$/i, "").toLowerCase();
      if (resourceGuess.length < 3) continue;

      const hasEndpoint = groups.some(g => {
        const { resource } = parseResourcePath(g.normalizedPath);
        return resource.toLowerCase() === resourceGuess || resource.toLowerCase() === resourceGuess + "s";
      });

      if (!hasEndpoint) {
        const plural = resourceGuess.endsWith("s") ? resourceGuess : resourceGuess + "s";
        const suggestedPath = `/api/${plural}`;
        if (!suggestions.some(s => s.path.includes(plural)) &&
            !additionalSuggestions.some(s => s.path.includes(plural))) {
          additionalSuggestions.push({
            method: "GET",
            path: suggestedPath,
            reason: `Field "${field}" in ${endpointKey(group)} suggests a "${capitalize(resourceGuess)}" resource`,
            confidence: "medium",
          });
        }
      }
    }
  }

  return [...suggestions, ...additionalSuggestions];
}

/**
 * When focus is "pagination": detect page sizes, estimate collection sizes,
 * identify endpoints that should be paginated but aren't.
 */
function deepPaginationAnalysis(
  pagination: PaginationPattern[],
  groups: EndpointGroup[],
  data: ApiData,
  harEntries?: HarEntry[],
): PaginationPattern[] {
  const harUrlIndex = harEntries ? indexHarEntriesByUrl(harEntries) : null;
  const paginatedEndpoints = new Set(pagination.map(p => p.endpoint));

  // Enrich existing pagination patterns with page size estimates
  if (harUrlIndex) {
    for (const pattern of pagination) {
      // Find matching HAR entries to detect page sizes
      for (const req of data.requests) {
        const normPath = req.normalizedPath || req.path;
        const ep = `${req.method.toUpperCase()} ${normPath}`;
        if (ep !== pattern.endpoint) continue;

        const entries = findHarEntries(req, harUrlIndex);
        for (const entry of entries) {
          const body = safeParseJson(entry.response?.content?.text);
          if (body && typeof body === "object") {
            const record = body as Record<string, unknown>;
            // Look for total counts
            for (const key of ["total", "count", "total_count", "totalCount", "totalResults"]) {
              if (typeof record[key] === "number") {
                pattern.examples[`estimated_total`] = String(record[key]);
              }
            }
            // Detect page size from array length in response
            for (const val of Object.values(record)) {
              if (Array.isArray(val) && val.length > 0) {
                pattern.examples[`page_size`] = String(val.length);
                break;
              }
            }
          }
        }
        break;
      }
    }
  }

  // Find GET endpoints returning arrays that SHOULD be paginated but aren't
  for (const group of groups) {
    if (group.method !== "GET") continue;
    const ep = endpointKey(group);
    if (paginatedEndpoints.has(ep)) continue;

    // Check if response looks like a list (responseSummary starts with "array")
    if (group.responseSummary?.startsWith("array")) {
      // Extract array size from summary if available
      const sizeMatch = group.responseSummary.match(/array\[(\d+)\]/);
      const size = sizeMatch ? parseInt(sizeMatch[1], 10) : 0;

      // Lists with 10+ items likely need pagination
      if (size >= 10) {
        pagination.push({
          endpoint: ep,
          type: "unknown",
          params: { _note: "no pagination detected" },
          examples: { array_size: String(size), recommendation: "should be paginated" },
        });
      }
    }
  }

  return pagination;
}

/**
 * When focus is "errors": classify errors by type, detect retry-able vs terminal.
 */
function deepErrorAnalysis(
  errors: ErrorPattern[],
  data: ApiData,
  harEntries?: HarEntry[],
): ErrorPattern[] {
  // Classify errors by category
  for (const error of errors) {
    const status = error.status;
    let category: string;

    if (status === 400) category = "validation";
    else if (status === 401) category = "auth:unauthenticated";
    else if (status === 403) category = "auth:forbidden";
    else if (status === 404) category = "not-found";
    else if (status === 409) category = "conflict";
    else if (status === 422) category = "validation:unprocessable";
    else if (status === 429) category = "rate-limit";
    else if (status >= 500 && status < 600) category = "server-error";
    else category = `http-${status}`;

    // Detect if error is retry-able
    const retryable = status === 429 || status === 503 || status === 502 || status === 504;
    const terminal = status === 400 || status === 401 || status === 403 || status === 404 || status === 422;

    // Encode classification into the shape field
    error.shape = `${error.shape} [${category}${retryable ? ", retryable" : ""}${terminal ? ", terminal" : ""}]`;
  }

  // Check for consistent error shape across the API
  const harUrlIndex = harEntries ? indexHarEntriesByUrl(harEntries) : null;
  if (harUrlIndex) {
    // Collect all error response shapes to detect patterns
    const errorShapes = new Map<string, number>();
    for (const req of data.requests) {
      if (req.status < 400) continue;
      const entries = findHarEntries(req, harUrlIndex);
      for (const entry of entries) {
        const body = safeParseJson(entry.response?.content?.text);
        if (body && typeof body === "object" && !Array.isArray(body)) {
          const keys = Object.keys(body as Record<string, unknown>).sort().join(",");
          errorShapes.set(keys, (errorShapes.get(keys) ?? 0) + 1);
        }
      }
    }

    // If one shape dominates, add it as a pattern note
    if (errorShapes.size > 0) {
      let maxShape = "";
      let maxCount = 0;
      for (const [shape, count] of errorShapes) {
        if (count > maxCount) { maxCount = count; maxShape = shape; }
      }
      if (maxCount > 1 && errors.length > 0) {
        const consistency = maxCount / data.requests.filter(r => r.status >= 400).length;
        if (consistency > 0.5) {
          // Add to the first error pattern as a reference
          errors[0].fields.push(`_consistent_shape:${maxShape}(${Math.round(consistency * 100)}%)`);
        }
      }
    }
  }

  return errors;
}

// ── Main Export ───────────────────────────────────────────────────────────

/**
 * Perform deep agentic analysis of captured API traffic.
 *
 * Extracts domain entities, auth flows, pagination patterns, error
 * conventions, rate limits, data flows, and endpoint suggestions from
 * the structured API data and optionally from raw HAR entries.
 *
 * @param data - Enriched API data (with endpointGroups from enrichApiData)
 * @param harEntries - Optional raw HAR entries for deeper analysis (response headers, timing, raw bodies)
 * @param options - Optional analysis options (e.g., focus area for deeper analysis)
 * @returns Complete agentic analysis
 */
export function analyzeTraffic(
  data: ApiData,
  harEntries?: HarEntry[],
  options?: AnalysisOptions,
): AgenticAnalysis {
  const groups = data.endpointGroups ?? [];
  const focus = options?.focus;

  let entities = extractEntities(groups);
  let authFlows = traceAuthFlows(groups, data, harEntries);
  let pagination = detectPagination(groups, data, harEntries);
  let errors = detectErrorPatterns(data, harEntries);
  const rateLimits = detectRateLimits(data, harEntries);
  let dataFlows = traceDataFlows(groups);
  let suggestions = suggestEndpoints(groups, entities);
  const apiStyle = detectApiStyle(groups);
  const versioning = detectVersioning(groups, data, harEntries);

  // Apply focus-mode deep analysis
  if (focus === "entities") {
    entities = deepEntityAnalysis(entities, groups, data, harEntries);
  } else if (focus === "auth") {
    authFlows = deepAuthAnalysis(authFlows, groups, data, harEntries);
  } else if (focus === "dataflow") {
    dataFlows = deepDataFlowAnalysis(dataFlows, groups);
  } else if (focus === "gaps") {
    suggestions = deepGapAnalysis(entities, groups, suggestions);
  } else if (focus === "pagination") {
    pagination = deepPaginationAnalysis(pagination, groups, data, harEntries);
  } else if (focus === "errors") {
    errors = deepErrorAnalysis(errors, data, harEntries);
  }

  const confidence = computeConfidence(data, entities, authFlows, dataFlows, groups, harEntries);

  const partialAnalysis = {
    entities,
    authFlows,
    pagination,
    errors,
    rateLimits,
    dataFlows,
    suggestions,
    apiStyle,
    versioning,
    confidence,
  };

  const summary = generateSummary(partialAnalysis, data, focus);

  return {
    ...partialAnalysis,
    summary,
  };
}
