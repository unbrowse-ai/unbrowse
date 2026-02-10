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
  /** Route-normalized path (e.g., /users/123 -> /users/{id}) */
  normalizedPath?: string;
  /** Extracted path parameters with types and example values */
  pathParams?: { name: string; type: string; example: string }[];
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
  /** Structured endpoint groups with normalization metadata */
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

// --- OOP refactor types ---

/** A normalized endpoint with route generalization and fingerprinting metadata. */
export interface NormalizedEndpoint {
  method: string;
  /** Original raw path (e.g., /users/abc123) */
  rawPath: string;
  /** Route-generalized path (e.g., /users/{id}) */
  normalizedPath: string;
  /** Stable fingerprint: METHOD|normalizedPath|queryKeys|bodySchema */
  fingerprint: string;
  /** SHA-256 hash of the body schema structure */
  schemaHash?: string;
  /** Query parameter key names (sorted) */
  queryKeys: string[];
  /** Body schema key structure */
  bodySchema?: string;
  /** Extracted path parameters */
  pathParams: { name: string; type: string; example: string }[];
  domain: string;
  status: number;
}

/** Stable fingerprint for deduplicating endpoints across captures. */
export interface EndpointFingerprint {
  method: string;
  normalizedPath: string;
  queryKeys: string[];
  bodySchema: string;
}

/** A grouped API endpoint with rich metadata for skill generation and validation. */
export interface EndpointGroup {
  method: string;
  normalizedPath: string;
  description: string;
  category: "auth" | "read" | "write" | "delete" | "other";
  pathParams: { name: string; type: string; example: string }[];
  queryParams: { name: string; type: string; example: string }[];
  responseSummary: string;
  exampleCount: number;
  dependencies: string[];
  produces: string[];
  consumes: string[];
  /** Generated method name for typed wrapper (e.g. "listProjects") */
  methodName?: string;
  /** Inferred request body schema */
  requestBodySchema?: { fields: Record<string, string>; summary: string; isArray: boolean; arrayLength?: number };
  /** Inferred response body schema */
  responseBodySchema?: { fields: Record<string, string>; summary: string; isArray: boolean; arrayLength?: number };
  /** LLM-generated param hints: param name → human description with example values */
  paramHints?: Record<string, string>;
  /** LLM-generated: when an agent should call this endpoint */
  whenToUse?: string;
}

/** Delta of what a contribution added to a skill. */
export interface ContributionDelta {
  /** New endpoints not previously in the skill */
  newEndpoints: NormalizedEndpoint[];
  /** Auth methods/headers newly discovered */
  authDiscoveries: string[];
  /** Schema changes (new fields, type changes) */
  schemaChanges: string[];
  /** Total novelty score (0-1) */
  noveltyScore: number;
}

/** A contributor to a skill with weighted contribution. */
export interface SkillContributor {
  userId: string;
  /** Relative contribution weight (0-1, all contributors sum to 1) */
  weight: number;
  contributions: ContributionDelta[];
  firstContribution: string;
  lastContribution: string;
}

/** Evidence from client-side endpoint validation (probing). */
export interface ValidationEvidence {
  /** Number of endpoints that responded successfully */
  endpointsVerified: number;
  /** Total number of endpoints tested */
  endpointsTested: number;
  /** Whether validation passed overall */
  passed: boolean;
  /** Endpoints that responded with 2xx */
  validEndpoints: string[];
  /** Endpoints that failed validation */
  invalidEndpoints: string[];
  /** Endpoints that required auth (401/403) */
  authRequired: string[];
  /** Timestamp of validation run */
  timestamp: string;
  /** Overall validation pass rate (0-1) */
  passRate: number;
}

/** Semantic diff result measuring novelty of a contribution. */
export interface NoveltyScore {
  /** Overall novelty (0-1): 0 = exact duplicate, 1 = entirely new */
  score: number;
  /** Breakdown by category */
  endpointNovelty: number;
  authNovelty: number;
  schemaNovelty: number;
  /** Human-readable summary */
  summary: string;
}

// --- Proxy verification layer types ---

/** Response from a proxy-verified API call. */
export interface ProxyResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
  /** Unique proof ID for this execution */
  proofId: string;
  latencyMs: number;
  schemaHash: string;
  /** Current skill trust score after this call */
  trustScore: number;
  /** Session sequence this belongs to (for LAM training) */
  sequenceId?: string;
}

/** Computed trust score for a skill based on execution history. */
export interface TrustScore {
  /** Composite score (0-1) */
  score: number;
  /** Percentage of successful calls */
  successRate: number;
  /** Hours since last successful call */
  freshness: number;
  /** Schema stability across calls */
  consistency: number;
  /** Total proxy calls */
  volume: number;
  lastUpdated: string;
}

/** A single execution entry from the proxy log. */
export interface ExecutionEntry {
  proofId: string;
  timestamp: string;
  endpoint: string;
  method: string;
  status: number;
  latencyMs: number;
  schemaHash: string;
  callerType: "creator" | "user";
}

/** Reward from submitting a review backed by execution proofs. */
export interface ReviewReward {
  reviewId: string;
  rewardUsdc: string;
  trustScoreDelta: number;
  message: string;
}
