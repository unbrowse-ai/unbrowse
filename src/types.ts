/** Raw HAR entry from a HAR file or CDP capture. */
export interface HarEntry {
  request: {
    method: string;
    url: string;
    headers: { name: string; value: string }[];
    cookies?: { name: string; value: string }[];
    queryString?: { name: string; value: string }[];
    postData?: { mimeType?: string; text?: string };
  };
  response: {
    status: number;
    headers: { name: string; value: string }[];
    content?: { size?: number; mimeType?: string; text?: string };
  };
  time?: number;
}

/** Parsed request info (simplified from HAR). */
export interface ParsedRequest {
  method: string;
  url: string;
  path: string;
  domain: string;
  status: number;
  /** Whether this endpoint was verified by auto-test */
  verified?: boolean;
  /** From OpenAPI spec rather than traffic capture */
  fromSpec?: boolean;
  /** Resource type from Playwright/CDP capture (e.g., "xhr", "fetch", "document") */
  resourceType?: string;
  /** Response content-type header */
  responseContentType?: string;

  // ── Enriched fields (populated by enrichApiData) ──────────────────────────

  /** Query parameters from the request URL */
  queryParams?: { name: string; value: string }[];
  /** Parsed JSON request body (POST/PUT/PATCH) */
  requestBody?: unknown;
  /** Content-type of the request body */
  requestContentType?: string;
  /** Parsed JSON response body (truncated to top-level structure) */
  responseBody?: unknown;
  /** Compact shape summary, e.g. "array[5]" or "object{id,name,email}" */
  responseSummary?: string;
  /** Path with dynamic segments replaced: /users/{userId}/orders */
  normalizedPath?: string;
  /** Detected path parameters with position and example values */
  pathParams?: PathParam[];
  /** GraphQL operation info if this is a persisted query */
  graphqlOperation?: {
    operationName: string;
    queryHash?: string;
    basePath: string;
  };
}

/** A detected path parameter from URL normalization. */
export interface PathParam {
  name: string;
  position: number;
  exampleValue: string;
  type: "numeric" | "uuid" | "hex" | "base64" | "date" | "slug" | "email" | "unknown";
}

/** An analyzed endpoint group — multiple requests collapsed into one logical endpoint. */
export interface EndpointGroup {
  method: string;
  normalizedPath: string;
  description: string;
  category: "auth" | "read" | "write" | "delete" | "other";
  pathParams: { name: string; type: string; example: string }[];
  queryParams: { name: string; example: string; required: boolean }[];
  requestBodySchema?: Record<string, string>;
  responseBodySchema?: Record<string, string>;
  responseSummary: string;
  exampleCount: number;
  verified?: boolean;
  fromSpec?: boolean;
  /** Normalized paths this endpoint likely depends on (e.g. auth, ID producers) */
  dependencies: string[];
  /** IDs this endpoint produces in its response */
  produces: string[];
  /** IDs this endpoint consumes from path/query/body */
  consumes: string[];
  /** GraphQL operations if this is a persisted query endpoint */
  graphqlOperations?: { name: string; method: string; hash?: string }[];
}

/** Auth credentials extracted from traffic. */
export interface AuthInfo {
  service: string;
  baseUrl: string;
  authMethod: string;
  timestamp: string;
  notes: string[];
  headers?: Record<string, string>;
  cookies?: Record<string, string>;
  mudraToken?: string;
  userId?: string;
  outletIds?: string[];
  authInfo?: Record<string, string>;
}

/** Full parsed API data from HAR analysis. */
export interface ApiData {
  service: string;
  baseUrls: string[];
  baseUrl: string;
  authHeaders: Record<string, string>;
  authMethod: string;
  cookies: Record<string, string>;
  authInfo: Record<string, string>;
  requests: ParsedRequest[];
  endpoints: Record<string, ParsedRequest[]>;

  // ── Enriched fields (populated by enrichApiData) ──────────────────────────

  /** Analyzed endpoint groups — deduplicated by normalized path + method */
  endpointGroups?: EndpointGroup[];
}

/** Result of skill generation. */
export interface SkillResult {
  skillFile: string;
  skillDir: string;
  service: string;
  authMethod: string;
  endpointCount: number;
  authHeaderCount: number;
  cookieCount: number;
  testPassed?: boolean;
  verifiedEndpoints?: number;
  unverifiedEndpoints?: number;
  openApiSource?: string | null;
  pagesCrawled?: number;
  /** Whether the skill content changed from the previous version. */
  changed: boolean;
  /** Human-readable diff summary (e.g. "+3 new endpoint(s)"). */
  diff?: string | null;
  /** SHA-256 hash (first 8 chars) of skill content for version tracking. */
  versionHash?: string;
}

/** CDP network request from browser control API. */
export interface CdpNetworkEntry {
  requestId: string;
  url: string;
  method: string;
  headers: Record<string, string>;
  postData?: string;
  responseStatus?: number;
  responseHeaders?: Record<string, string>;
  resourceType?: string;
  timestamp?: number;
}

/** Evidence from client-side endpoint validation before publish */
export interface ValidationEvidence {
  validatedAt: string;
  totalEndpoints: number;
  endpointsTested: number;
  endpointsVerified: number;
  endpointsFailed: number;
  endpointsSkipped: number;
  results: ValidationResult[];
  passed: boolean;
  platform: string;
  pluginVersion: string;
}

/** Evidence for a single validated endpoint */
export interface ValidationResult {
  method: string;
  path: string;
  status: number;
  ok: boolean;
  hasData: boolean;
  responseShape: string;
  responseSize: number;
  latencyMs: number;
  responseHash: string;
}
